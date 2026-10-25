import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { WebSocket } from 'ws';
import { stageDeviceViewerHelper } from './fixtures/device-viewer-helper';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-device-controllers-')));
const data = join(root, 'data');
const receipts = join(root, 'receipts.jsonl');
const control = join(root, 'control.json');
const manualReceipts = join(root, 'manual-receipts.jsonl');
const previous = { O8_DATA_DIR: process.env.O8_DATA_DIR, CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR, WS_TOKEN: process.env.WS_TOKEN };
const physicalData = join(root, 'physical-data'); mkdirSync(physicalData, { recursive: true });
symlinkSync(physicalData, data, process.platform === 'win32' ? 'junction' : 'dir');
process.env.O8_DATA_DIR = data;
process.env.CORTEX_IDE_DATA_DIR = data;
process.env.WS_TOKEN = 'fixture-controller-operator-01234567890123456789';
// Collect the real route graph before the hook clock starts, as other MCP route
// suites do. Cold transforms on macOS must not exhaust fixture setup's budget.
const devices = await import('@/app/api/panel/devices/route');
const mcp = await import('@/app/api/mcp/route');
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
  writeFileSync(control, '{}');
  for (const spec of [
    { name: 'expo-device-hub', version: '0.15.3', entry: 'dist/server/cli.mjs' },
    { name: 'agent-device', version: '0.21.23', entry: 'bin/agent-device.mjs' },
  ]) {
    const dir = join(data, 'devices/tools', spec.name, spec.version);
    const pkg = join(dir, 'node_modules', spec.name);
    mkdirSync(dirname(join(pkg, spec.entry)), { recursive: true });
    writeFileSync(join(dir, '.install-complete'), spec.version);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: spec.name, version: spec.version, type: 'module' }));
    if (spec.name === 'expo-device-hub') stageDeviceViewerHelper(pkg, manualReceipts, control);
    writeFileSync(join(pkg, spec.entry), spec.name === 'expo-device-hub' ? `
import { createServer } from 'node:http';
import { WebSocketServer } from ${JSON.stringify(join(process.cwd(), 'node_modules/ws/wrapper.mjs'))};
import handler, { FixtureHid, fixtureExec, fixtureUi, fixtureAxType, fixtureHardwareKeyboard, webSocketHandlers } from './index.mjs';
const args = process.argv.slice(2); const port = Number(args[args.indexOf('--port') + 1]);
const token = 'fixture-controller-hub-01234567890123456789';
const server = createServer(async (req, res) => {
  if (new URL(req.url, 'http://' + req.headers.host).pathname === '/readyz') {
    const result = await handler(new Request('http://' + req.headers.host + req.url, { method: req.method }));
    res.writeHead(result.status); return res.end(await result.text());
  }
  if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); return res.end(); }
  if (req.method === 'POST') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const result = await handler(new Request('http://' + req.headers.host + req.url, { method: 'POST', body: Buffer.concat(chunks) }));
    res.writeHead(result.status, { 'content-type': 'application/json' }); res.end(await result.text()); return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ simulators: [1, 2].map(n => ({ id: 'ios-' + n, name: 'Fixture phone ' + n, platform: 'ios', booted: true })), emulators: [] }));
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => {
    const route = new URL(req.url, 'http://' + req.headers.host).pathname;
    if (webSocketHandlers[route]) { webSocketHandlers[route](ws); return; }
    const hid = new FixtureHid('ios-1');
    ws.on('message', async bytes => {
      try {
        const input = JSON.parse(bytes.toString());
        const result = input.action === 'exec' ? await fixtureExec({ action: 'appearance.set', params: { udid: 'ios-1', value: 'dark' } })
          : input.action === 'ui' ? await fixtureUi({ ui: { device: 'ios-1', option: 'appearance', value: 'dark' } })
            : input.action === 'ax-type' ? await fixtureAxType('ios-1')
              : input.action === 'hardware-keyboard' ? await fixtureHardwareKeyboard('ios-1')
                : input.action === 'touch' ? await hid.touch(input.type) : await hid.button();
        ws.send(JSON.stringify(result));
      } catch { ws.send(JSON.stringify({ applied: false })); }
    });
  });
});
server.listen(port, '127.0.0.1', () => console.log('http://localhost:' + port + '/?token=' + token));
process.on('SIGTERM', () => { for (const client of wss.clients) client.terminate(); server.close(() => process.exit(0)); });
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
  it('starts the fenced helper through DeviceManager and keeps readiness independent of input ownership', async () => {
    await expect.poll(async () => (await state()).phase, { timeout: 8_000, interval: 50 }).toBe('running');
    const ready = await state();
    expect(ready.controllers).toEqual([]);
    const health = new URL('/readyz', ready.embedUrl);
    expect((await fetch(health)).status).toBe(200);
    expect((await tool(2, { action: 'acquire', deviceId: 'ios-1' })).error).toBe(false);
    const owned = (await state()).controllers;
    const before = records().length;
    try {
      for (const method of ['GET', 'HEAD']) expect((await fetch(health, { method })).status).toBe(200);
      writeFileSync(control, JSON.stringify({ healthStatus: 503 }));
      expect((await fetch(health)).status).toBe(503);
      writeFileSync(control, '{}');
      expect((await fetch(health, { method: 'POST' })).status).toBe(409);
      expect((await fetch(new URL('/api/devices/boot', ready.embedUrl), { method: 'POST',
        headers: { authorization: 'Bearer fixture-controller-hub-01234567890123456789' },
        body: JSON.stringify({ platform: 'ios', id: 'ios-1' }),
      })).status).toBe(409);
      expect((await state()).controllers).toEqual(owned);
      expect(records()).toHaveLength(before);
      expect(existsSync(manualReceipts)).toBe(false);
    } finally { writeFileSync(control, '{}'); expect((await tool(2, { action: 'release', deviceId: 'ios-1' })).error).toBe(false); }
  });

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

  it('rejects a stale panel on the actual native input path after another panel hands control to a worker', async () => {
    await expect.poll(async () => (await state()).phase).toBe('running');
    expect((await panel({ action: 'take-control', deviceId: 'ios-1', expectedSession: null })).status).toBe(200);
    const operatorState = await state();
    const operator = operatorState.controllers.find((entry: { deviceId: string }) => entry.deviceId === 'ios-1').active.session;
    const url = new URL(operatorState.embedUrl);
    url.protocol = 'ws:'; url.pathname = '/vendor/serve-sim/helper/ws';
    const stalePanel = new WebSocket(url);
    await new Promise<void>(resolve => stalePanel.once('open', resolve));
    const input = (action: string) => new Promise<{ applied: boolean }>(resolve => {
      stalePanel.once('message', value => resolve(JSON.parse(value.toString())));
      stalePanel.send(JSON.stringify({ action }));
    });
    try {
      for (const action of ['button', 'exec', 'ui', 'ax-type', 'hardware-keyboard']) expect((await input(action)).applied).toBe(true);
      expect((await tool(2, { action: 'acquire', deviceId: 'ios-1' })).error).toBe(true);
      const waiting = (await state()).controllers.find((entry: { deviceId: string }) => entry.deviceId === 'ios-1').waiting[0].session;
      expect((await panel({ action: 'handoff', deviceId: 'ios-1', expectedSession: operator, targetSession: waiting })).status).toBe(200);
      const before = readFileSync(manualReceipts, 'utf8');
      for (const action of ['button', 'exec', 'ui', 'ax-type', 'hardware-keyboard']) expect((await input(action)).applied).toBe(false);
      const rejected = await fetch(new URL('/api/devices/boot', operatorState.embedUrl), {
        method: 'POST', headers: { authorization: 'Bearer fixture-controller-hub-01234567890123456789' }, body: JSON.stringify({ platform: 'ios', id: 'ios-1' }),
      });
      expect(rejected.status).toBe(409);
      expect(readFileSync(manualReceipts, 'utf8')).toBe(before);
    } finally { stalePanel.terminate(); await tool(2, { action: 'release', deviceId: 'ios-1' }); }
  });

  it('pushes ownership changes to both open panels before their next poll', async () => {
    const makeStreamRequest = (signal: AbortSignal) => new Request(request().url + '?stream=controllers', { headers: request().headers, signal });
    const a = new AbortController(); const b = new AbortController();
    const responses = await Promise.all([devices.GET(makeStreamRequest(a.signal)), devices.GET(makeStreamRequest(b.signal))]);
    try {
      expect(responses.map(response => response.headers.get('content-type'))).toEqual(['text/event-stream', 'text/event-stream']);
      const readers = responses.map(response => response.body!.getReader());
      await Promise.all(readers.map(reader => reader.read()));
      expect((await panel({ action: 'take-control', deviceId: 'ios-1', expectedSession: null })).status).toBe(200);
      for (const reader of readers) {
        let update = '';
        for (let count = 0; count < 4 && !update.includes('Operator'); count++) update += new TextDecoder().decode((await reader.read()).value);
        expect(update).toContain('Operator');
      }
    } finally { a.abort(); b.abort(); }
  });

  it('rejects conflicting device aliases before a lifecycle request can drive another worker device', async () => {
    const current = await state();
    const before = readFileSync(manualReceipts, 'utf8');
    const response = await fetch(new URL('/api/devices/boot', current.embedUrl), {
      method: 'POST', headers: { authorization: 'Bearer fixture-controller-hub-01234567890123456789' },
      body: JSON.stringify({ platform: 'ios', id: 'ios-2', device: 'ios-1' }),
    });
    expect(response.status).toBe(409);
    expect(readFileSync(manualReceipts, 'utf8')).toBe(before);
  });

  it('refuses the uncoordinated emulator WebSocket instead of exposing another input path', async () => {
    const current = await state(); const url = new URL(current.embedUrl);
    url.protocol = 'ws:'; url.pathname = '/vendor/serve-emu/ws';
    const socket = new WebSocket(url);
    try {
      const result = await new Promise<boolean>(resolve => {
        socket.once('message', () => resolve(true)); socket.once('close', () => resolve(false));
      });
      expect(result).toBe(false);
    } finally { socket.terminate(); }
  });

  it('holds authority through native completion and a complete touch gesture before handing off', async () => {
    const current = await state(); const operator = current.controllers.find((entry: { deviceId: string }) => entry.deviceId === 'ios-1').active.session;
    expect((await tool(2, { action: 'acquire', deviceId: 'ios-1' })).error).toBe(true);
    const waiting = (await state()).controllers.find((entry: { deviceId: string }) => entry.deviceId === 'ios-1').waiting[0].session;
    const url = new URL(current.embedUrl); url.protocol = 'ws:'; url.pathname = '/vendor/serve-sim/helper/ws';
    const socket = new WebSocket(url); await new Promise<void>(resolve => socket.once('open', resolve));
    const input = (action: string, type?: string) => new Promise<{ applied: boolean }>(resolve => {
      socket.once('message', value => resolve(JSON.parse(value.toString()))); socket.send(JSON.stringify({ action, type }));
    });
    const transfer = () => panel({ action: 'handoff', deviceId: 'ios-1', expectedSession: operator, targetSession: waiting });
    try {
      writeFileSync(control, JSON.stringify({ manualDelay: 200 }));
      const pressing = input('button');
      await expect.poll(async () => (await state()).controllers.find((entry: { deviceId: string }) => entry.deviceId === 'ios-1').operatorInput).toBe(true);
      expect((await transfer()).status).toBe(409);
      expect((await pressing).applied).toBe(true); writeFileSync(control, '{}');
      expect((await input('touch', 'begin')).applied).toBe(true);
      expect((await transfer()).status).toBe(409);
      expect((await input('touch', 'end')).applied).toBe(true);
      expect((await transfer()).status).toBe(200);
      expect((await input('button')).applied).toBe(false);
    } finally { writeFileSync(control, '{}'); socket.terminate(); await tool(2, { action: 'release', deviceId: 'ios-1' }); }
  });

  it('fails closed when the installed helper no longer matches the pinned native input boundary', async () => {
    await panel({ action: 'stop' });
    const native = join(data, 'devices/tools/expo-device-hub/0.15.3/node_modules/expo-device-hub/vendor/serve-sim/dist/middleware.js');
    writeFileSync(native, readFileSync(native, 'utf8').replace('this.handle=new(e6()).SimHID($)', 'this.handle = new (e6()).SimHID($)'));
    expect((await panel({ action: 'start' })).status).toBe(202);
    await expect.poll(async () => (await state()).phase).toBe('error');
    expect((await state()).embedUrl).toBeUndefined();
  });
});
