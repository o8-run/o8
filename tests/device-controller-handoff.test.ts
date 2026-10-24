import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-device-controllers-')));
const data = join(root, 'data');
const receipts = join(root, 'receipts.jsonl');
const control = join(root, 'control.json');
const previous = { O8_DATA_DIR: process.env.O8_DATA_DIR, CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR, WS_TOKEN: process.env.WS_TOKEN };
process.env.O8_DATA_DIR = data;
process.env.CORTEX_IDE_DATA_DIR = data;
process.env.WS_TOKEN = 'fixture-controller-operator-01234567890123456789';
let devices: typeof import('@/app/api/panel/devices/route');
let mcp: typeof import('@/app/api/mcp/route');
const workers: ChildProcess[] = [];
const identity = (worker: number) => ({ conversation: `fixture-conversation-${worker}`, worker: `fixture-worker-${worker}`, pid: workers[worker].pid! });

function request(body?: unknown) {
  return new Request('http://127.0.0.1:3100/api/panel/devices', { method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${process.env.WS_TOKEN}`, host: '127.0.0.1:3100', origin: 'http://127.0.0.1:3100', 'x-o8-client-addr': '127.0.0.1' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function tool(worker: number, args: Record<string, unknown>) {
  const who = identity(worker);
  const response = await mcp.POST(new Request('http://127.0.0.1:3100/api/mcp', { method: 'POST',
    headers: { authorization: `Bearer ${process.env.WS_TOKEN}`, 'x-o8-device-worker': who.worker,
      'x-o8-device-conversation': who.conversation, 'x-o8-device-pid': String(who.pid) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'o8_device', arguments: args } }),
  }));
  const value = await response.json();
  const result = value.result;
  return { error: result?.isError === true || Boolean(value.error), text: result?.content?.[0]?.text ?? JSON.stringify(value) };
}
function records(): Array<{ args: string[]; stateDir: string; cwd: string }> {
  return existsSync(receipts) ? readFileSync(receipts, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
async function state() { return (await devices.GET(request())).json(); }
async function panel(body: unknown) { return devices.POST(request(body)); }

beforeAll(async () => {
  mkdirSync(data, { recursive: true });
  writeFileSync(control, '{}');
  for (const spec of [
    { name: 'expo-device-hub', version: '0.15.3', entry: 'dist/server/cli.mjs' },
    { name: 'agent-device', version: '0.21.23', entry: 'bin/agent-device.mjs' },
  ]) {
    const dir = join(data, 'devices/tools', spec.name, spec.version);
    const pkg = join(dir, 'node_modules', spec.name);
    mkdirSync(dirname(join(pkg, spec.entry)), { recursive: true });
    writeFileSync(join(dir, '.install-complete'), spec.version);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: spec.name, version: spec.version }));
    writeFileSync(join(pkg, spec.entry), spec.name === 'expo-device-hub' ? `
import { createServer } from 'node:http';
const args = process.argv.slice(2); const port = Number(args[args.indexOf('--port') + 1]);
const token = 'fixture-controller-hub-01234567890123456789';
const server = createServer((req, res) => {
  if (req.url === '/readyz') return res.end('ready');
  if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); return res.end(); }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ simulators: [1, 2].map(n => ({ id: 'ios-' + n, name: 'Fixture phone ' + n, platform: 'ios', booted: true })), emulators: [] }));
});
server.listen(port, '127.0.0.1', () => console.log('http://localhost:' + port + '/?token=' + token));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
` : `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(receipts)}, JSON.stringify({ args, stateDir: process.env.AGENT_DEVICE_STATE_DIR, cwd: process.cwd() }) + '\\n');
const config = JSON.parse(readFileSync(${JSON.stringify(control)}, 'utf8'));
const session = args[args.indexOf('--session') + 1];
const file = join(process.env.AGENT_DEVICE_STATE_DIR, 'fixture-sessions.json');
const sessions = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
if (config.failClose && args[0] === 'close') { console.error('private helper failure'); process.exit(2); }
if (args[0] === 'open') {
  const device = args[args.indexOf('--udid') + 1];
  if (Object.entries(sessions).some(([key, value]) => key !== session && value === device)) process.exit(3);
  sessions[session] = device;
}
if (args[0] === 'close') delete sessions[session];
writeFileSync(file, JSON.stringify(sessions));
if (config.delay && args[0] === 'press') await new Promise(resolve => setTimeout(resolve, config.delay));
console.log(JSON.stringify(config.unconfirmed ? { data: { fixture: true } } : { success: true, data: { fixture: true } }));
`);
  }
  for (let index = 0; index < 3; index++) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { ...process.env, O8_OWNED_RUN_MARKER: `fixture-device-run-${index}` } });
    workers.push(child);
    await new Promise<void>(resolve => child.once('spawn', resolve));
  }
  devices = await import('@/app/api/panel/devices/route');
  mcp = await import('@/app/api/mcp/route');
  expect((await panel({ action: 'start' })).status).toBe(202);
});
afterAll(async () => {
  if (devices) await panel({ action: 'stop' });
  for (const child of workers) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM'); await exited;
  }
  const { closeDb } = await import('@/lib/db'); closeDb();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe.sequential('Devices controller handoff through panel routes and MCP tools', () => {
  it('assigns distinct sessions automatically, refuses a second worker and shows its waiting identity', async () => {
    await expect.poll(async () => (await state()).phase).toBe('running');
    expect((await tool(0, { action: 'acquire', deviceId: 'ios-1' })).error).toBe(false);
    const before = records().length;
    const second = await tool(1, { action: 'acquire', deviceId: 'ios-1' });
    expect(second.error).toBe(true);
    expect(second.text).toContain('handoff');
    expect(records()).toHaveLength(before);
    const roster = (await state()).controllers;
    expect(roster).toHaveLength(1);
    expect(roster[0].active.kind).toBe('worker');
    expect(roster[0].waiting).toHaveLength(1);
    expect(roster[0].active.session).not.toBe(roster[0].waiting[0].session);
    expect(JSON.stringify(roster)).not.toContain(root);
    expect(JSON.stringify(roster)).not.toContain('fixture-conversation');
    expect(realpathSync(records()[0].cwd)).toBe(realpathSync(join(data, 'devices')));
    expect(realpathSync(records()[0].stateDir)).toBe(realpathSync(join(data, 'devices/agent-state')));
  });

  it('requires the current owner for handoff and never silently closes an occupied session', async () => {
    const roster = (await state()).controllers[0];
    const before = records().length;
    expect((await tool(1, { action: 'handoff', deviceId: 'ios-1', targetSession: roster.waiting[0].session })).error).toBe(true);
    expect(records()).toHaveLength(before);
    expect((await tool(0, { action: 'handoff', deviceId: 'ios-1', targetSession: roster.waiting[0].session })).error).toBe(false);
    const calls = records().slice(before);
    expect(calls.map(call => call.args[0])).toEqual(['close', 'open']);
    expect(calls[0].args).toContain(roster.active.session);
    expect(calls[1].args).toContain(roster.waiting[0].session);
    expect((await tool(0, { action: 'press', deviceId: 'ios-1', x: 20, y: 30 })).error).toBe(true);
  });

  it('allows independent devices and attributes agent input without retaining typed content', async () => {
    expect((await tool(0, { action: 'acquire', deviceId: 'ios-2' })).error).toBe(false);
    expect((await tool(1, { action: 'press', deviceId: 'ios-1', x: 20, y: 30 })).error).toBe(false);
    expect((await tool(1, { action: 'type', deviceId: 'ios-1', text: 'fixture private text' })).error).toBe(false);
    const roster = (await state()).controllers;
    expect(roster.filter((row: { active: unknown }) => row.active)).toHaveLength(2);
    expect(roster.find((row: { deviceId: string }) => row.deviceId === 'ios-1').lastInput).toMatchObject({ action: 'type' });
    expect(JSON.stringify(roster)).not.toContain('fixture private text');
    expect(new Set(records().map(call => call.stateDir)).size).toBe(1);
  });

  it('makes operator takeover explicit, blocks agents until a handoff and rejects stale panel actions', async () => {
    const row = (await state()).controllers.find((entry: { deviceId: string }) => entry.deviceId === 'ios-1');
    const takeover = await panel({ action: 'take-control', deviceId: 'ios-1', expectedSession: row.active.session });
    expect(takeover.status).toBe(200);
    expect((await state()).controllers.find((entry: { deviceId: string }) => entry.deviceId === 'ios-1').active.kind).toBe('operator');
    expect((await tool(1, { action: 'press', deviceId: 'ios-1', x: 10, y: 10 })).error).toBe(true);
    expect((await panel({ action: 'handoff', deviceId: 'ios-1', expectedSession: row.active.session, targetSession: row.active.session })).status).toBe(409);
    const current = (await state()).controllers.find((entry: { deviceId: string }) => entry.deviceId === 'ios-1');
    expect((await panel({ action: 'handoff', deviceId: 'ios-1', expectedSession: current.active.session, targetSession: row.active.session })).status).toBe(200);
  });

  it('does not transfer ownership while input is in flight or when the helper cannot release it', async () => {
    writeFileSync(control, JSON.stringify({ delay: 200 }));
    const before = records().length;
    const driving = tool(1, { action: 'press', deviceId: 'ios-1', x: 40, y: 50 });
    await expect.poll(() => records().length).toBeGreaterThan(before);
    const row = (await state()).controllers.find((entry: { deviceId: string }) => entry.deviceId === 'ios-1');
    expect((await panel({ action: 'take-control', deviceId: 'ios-1', expectedSession: row.active.session })).status).toBe(409);
    expect((await driving).error).toBe(false);
    writeFileSync(control, JSON.stringify({ failClose: true }));
    expect((await panel({ action: 'take-control', deviceId: 'ios-1', expectedSession: row.active.session })).status).toBe(409);
    expect((await state()).controllers.find((entry: { deviceId: string }) => entry.deviceId === 'ios-1').active.session).toBe(row.active.session);
    writeFileSync(control, '{}');
  });

  it('recovers exited workers through the real roster read and keeps unrelated simulator ownership', async () => {
    const exited = new Promise<void>(resolve => workers[1].once('exit', () => resolve()));
    workers[1].kill('SIGTERM'); await exited;
    const roster = (await state()).controllers;
    expect(roster.find((entry: { deviceId: string }) => entry.deviceId === 'ios-1').active).toBeNull();
    expect(roster.find((entry: { deviceId: string }) => entry.deviceId === 'ios-2').active).not.toBeNull();
    expect((await tool(2, { action: 'acquire', deviceId: 'ios-1' })).error).toBe(false);
    expect((await tool(2, { action: 'release', deviceId: 'ios-1' })).error).toBe(false);
  });

  it('binds the dispatched worker tool entry point to the credential rather than spoofed controller arguments', async () => {
    const { mintPacketWorkerToken, bindPacketWorkerTokenProcess } = await import('@/lib/auth/packet-worker-token');
    const bearer = mintPacketWorkerToken('fixture-device-packet', { processMarker: 'fixture-device-run-2' });
    bindPacketWorkerTokenProcess(bearer, { pid: workers[2].pid!, processMarker: 'fixture-device-run-2' });
    const workerRoute = await import('@/app/api/devices/agent/route');
    const call = async (args: Record<string, unknown>, name = 'o8_device', credential = bearer) => workerRoute.POST(new Request('http://127.0.0.1:3100/api/devices/agent', {
      method: 'POST', headers: { authorization: `Bearer ${credential}`, host: '127.0.0.1:3100', 'x-o8-client-addr': '127.0.0.1',
        'x-o8-device-worker': identity(0).worker, 'x-o8-device-pid': String(workers[0].pid) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }));
    const acquired = await (await call({ action: 'acquire', deviceId: 'ios-1' })).json();
    expect(acquired.result.isError).not.toBe(true);
    expect((await (await call({ action: 'press', deviceId: 'ios-2', x: 1, y: 2 })).json()).result.isError).toBe(true);
    expect((await (await call({}, 'dispatch_mission')).json()).result.isError).toBe(true);
    expect((await (await call({ action: 'release', deviceId: 'ios-1' })).json()).result.isError).not.toBe(true);
    const stale = mintPacketWorkerToken('fixture-device-packet', { processMarker: 'fixture-wrong-run' });
    bindPacketWorkerTokenProcess(stale, { pid: workers[2].pid!, processMarker: 'fixture-wrong-run' });
    expect((await call({ action: 'status' }, 'o8_device', stale)).status).toBe(403);
  });

  it('automatically attaches the Devices-only tool transport through the owned worker launch entry point', async () => {
    const { claudeCodeOwnedAdapter } = await import('@/lib/claude-code/owned');
    const { prepareOwnedLaunchArgs } = await import('@/lib/runtimes/shared/owned-session/launch-args');
    const sessionDir = join(root, 'worker-session'); mkdirSync(sessionDir);
    const session = { surfaceId: 'claude-code-owned:fixture-device', packetId: 'fixture-device-packet', sessionDir,
      cwd: root, repoPath: root, branch: 'fixture', title: 'Fixture worker', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      threadId: 'fixture-parent-conversation', initialPrompt: 'Fixture', latestPrompt: 'Fixture', latestSummary: '', recentRuns: [] };
    const launch = await prepareOwnedLaunchArgs({ adapter: claudeCodeOwnedAdapter, session,
      runId: 'fixture-device-config', prompt: 'Fixture', mode: 'launch', sandboxEnabled: false, humanLabel: 'Fixture worker' });
    const server = launch.workerMcp.servers.find(entry => entry.name === 'o8-devices');
    expect(server?.env).toMatchObject({ O8_DEVICE_WORKER_ONLY: '1', O8_DEVICE_CONVERSATION_ID: 'fixture-parent-conversation' });
    const saved = JSON.parse(readFileSync(launch.workerMcp.configPath!, 'utf8'));
    expect(saved.mcpServers['o8-devices'].env).not.toHaveProperty('WS_TOKEN');
    const { codexOwnedAdapter } = await import('@/lib/codex/owned');
    const codex = await prepareOwnedLaunchArgs({ adapter: codexOwnedAdapter, session,
      runId: 'fixture-device-codex', prompt: 'Fixture', mode: 'launch', sandboxEnabled: false, humanLabel: 'Fixture worker' });
    expect(codex.args).toContain('mcp_servers.o8-devices.env_vars=["O8_WORKER_TOKEN"]');
  });

  it('recovers an abandoned operation after its recorded helper exits without reassigning live control', async () => {
    expect((await tool(2, { action: 'acquire', deviceId: 'ios-1' })).error).toBe(false);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    workers.push(child); await new Promise<void>(resolve => child.once('spawn', resolve));
    const { probeMetadataLockProcessIdentity } = await import('@/lib/worktree/metadata-lock-process-identity');
    const helper = await probeMetadataLockProcessIdentity(child.pid!);
    const parent = await probeMetadataLockProcessIdentity(process.pid);
    if (helper.state !== 'live' || parent.state !== 'live') throw new Error('Fixture process identity unavailable');
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(join(data, 'devices/controllers.sqlite'));
    const saved = JSON.parse((db.prepare('SELECT value FROM authority WHERE id = 1').get() as { value: string }).value);
    saved.devices['ios-1'].operation = { id: 'fixture-abandoned', pid: workers[1].pid, identity: parent.identity,
      helper: { pid: child.pid, identity: helper.identity } };
    db.prepare('UPDATE authority SET value = ? WHERE id = 1').run(JSON.stringify(saved)); db.close();
    const active = saved.devices['ios-1'].active.session;
    expect((await state()).controllers.find((entry: { deviceId: string }) => entry.deviceId === 'ios-1')).toMatchObject({ busy: true, active: { session: active } });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGTERM'); await exited;
    expect((await state()).controllers.find((entry: { deviceId: string }) => entry.deviceId === 'ios-1')).toMatchObject({ busy: false, active: { session: active } });
    expect((await tool(2, { action: 'release', deviceId: 'ios-1' })).error).toBe(false);
  });

  it('assigns two real stdio tool transports distinct sessions in the same conversation', async () => {
    writeFileSync(join(data, 'ws-token'), process.env.WS_TOKEN!);
    const server = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(key, value);
      headers.set('x-o8-client-addr', '127.0.0.1');
      const response = await mcp.POST(new Request('http://127.0.0.1/api/mcp', { method: 'POST', headers, body: Buffer.concat(chunks).toString() }));
      outgoing.writeHead(response.status, { 'content-type': 'application/json' }); outgoing.end(await response.text());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
    const proxies: Array<{ child: ChildProcess; call: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> = [];
    try {
      for (let index = 0; index < 2; index++) {
        const child = spawn(process.execPath, [join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', join(process.cwd(), 'tsconfig.json'),
          join(process.cwd(), 'src/lib/mcp/operator-mcp-proxy.ts')], { stdio: ['pipe', 'pipe', 'ignore'],
          env: { ...process.env, O8_API_BASE: `http://127.0.0.1:${address.port}`, O8_VISUALIZATION_THREAD_ID: 'fixture-live-conversation', O8_MCP_TOOL_LOADING: 'full' } });
        workers.push(child);
        let id = 0;
        const pending = new Map<number, (value: { result: { isError?: boolean; content: Array<{ text: string }> } }) => void>();
        const lines = createInterface({ input: child.stdout! });
        lines.on('line', line => { const value = JSON.parse(line); pending.get(value.id)?.(value); pending.delete(value.id); });
        proxies.push({ child, call: args => new Promise(resolve => {
          const requestId = ++id; pending.set(requestId, value => resolve(value.result));
          child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name: 'o8_device', arguments: args } }) + '\n');
        }) });
      }
      expect((await proxies[0].call({ action: 'acquire', deviceId: 'ios-1' })).isError).not.toBe(true);
      expect((await proxies[1].call({ action: 'acquire', deviceId: 'ios-1' })).isError).toBe(true);
      const row = (await state()).controllers.find((entry: { deviceId: string }) => entry.deviceId === 'ios-1');
      expect(row.active.session).not.toBe(row.waiting[0].session);
      expect((await proxies[0].call({ action: 'handoff', deviceId: 'ios-1', targetSession: row.waiting[0].session })).isError).not.toBe(true);
      expect((await proxies[1].call({ action: 'release', deviceId: 'ios-1' })).isError).not.toBe(true);
    } finally {
      for (const { child } of proxies) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.stdin?.end(); await exited;
      }
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('retains ownership when a zero-exit helper does not confirm success', async () => {
    await expect.poll(async () => (await state()).phase).toBe('running');
    expect((await tool(2, { action: 'acquire', deviceId: 'ios-1' })).error).toBe(false);
    writeFileSync(control, JSON.stringify({ unconfirmed: true }));
    const result = await tool(2, { action: 'press', deviceId: 'ios-1', x: 5, y: 6 });
    writeFileSync(control, '{}');
    expect(result.error).toBe(true);
    expect((await state()).controllers.find((entry: { deviceId: string }) => entry.deviceId === 'ios-1').active).not.toBeNull();
    expect((await tool(2, { action: 'release', deviceId: 'ios-1' })).error).toBe(false);
  });
});
