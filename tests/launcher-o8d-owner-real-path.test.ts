import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { beforeAll, expect, it } from 'vitest';
import { seedSessionFixture } from '../scripts/o8d/parity';
import packageJson from '../package.json';
const run = promisify(execFile);
const target = process.env.O8_LAUNCHER_TEST_TARGET ?? '/tmp/o8-launcher-owner-target';
const launcher = process.env.O8_LAUNCHER_TEST_BINARY ?? join(target, 'debug/o8-launcher');
const daemon = process.env.O8D_TEST_BINARY ?? join(target, 'debug/o8d');
const windowClient = process.env.O8_LAUNCHER_TRANSPORT_TEST_BINARY;
beforeAll(async () => {
  if (process.platform !== 'linux') return;
  if (!process.env.O8_LAUNCHER_TEST_BINARY) await run('cargo', ['build', '--locked', '--manifest-path', 'crates/o8-launcher/Cargo.toml', '--jobs', '1', '--target-dir', target], { maxBuffer: 4 * 1024 * 1024 });
  if (!process.env.O8D_TEST_BINARY) await run('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--jobs', '1', '--target-dir', target], { maxBuffer: 4 * 1024 * 1024 });
}, 600_000);
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 90_000) {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw Error('Launcher fixture timeout: ' + label); await new Promise(resolve => setTimeout(resolve, 25)); }
}
function json(path: string) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function pids(path: string): number[] { try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(Number); } catch { return []; } }
function alive(pid: number) { try { process.kill(pid, 0); return !readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].startsWith('Z'); } catch { return false; } }
async function stop(child: ChildProcess | undefined) {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await until(() => child.exitCode !== null || child.signalCode !== null, 'owned child quit', 15_000); }
}
it.runIf(process.platform === 'linux')('launcher keeps the public o8d owner across a producer outage and the real window transport reconnects', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-launch-owner-'))), server = join(root, 'server');
  let owner: ChildProcess | undefined, client: ChildProcess | undefined; let clientOutput = '';
  try {
    await seedSessionFixture(root); await run('git', ['init', '--quiet', root]); mkdirSync(server);
    symlinkSync(join(process.cwd(), 'node_modules'), join(server, 'node_modules'), 'dir');
    const repo = process.cwd(), window = join(root, 'window'), probe = join(root, 'probe');
    writeFileSync(join(server, 'server.js'), 'throw Error("Next must remain off in this fixture");');
    writeFileSync(join(server, 'ws-server.mjs'), `await import(${JSON.stringify(pathToFileURL(join(repo, 'tests/fixtures/launcher-ws-owner-entry.mjs')).href)});`);
    writeFileSync(window, `#!/bin/sh\necho $$ >> '${root}/window-pids'\necho o8-next-ready\ncat >/dev/null\n`, { mode: 0o700 });
    writeFileSync(probe, `#!/bin/sh\nprintf '__O8_PATH=%s\\n__O8_NODE=%s\\n' "$PATH" '${process.execPath}'\n`, { mode: 0o700 });
    const config = join(root, 'launch.json');
    writeFileSync(config, JSON.stringify({ data_dir: root, server_dir: server, node: process.execPath, window, probe, api_port: 0, ws_port: 0, version: 'fixture', native_lifecycle: false, api_front_door: true, next_off: true }));
    const nodeOptions = ['--require=' + join(repo, 'scripts/next/brain-runtime.cjs'), '--import=' + pathToFileURL(join(repo, 'scripts/register-server-only-stub.mjs')).href, '--import=' + pathToFileURL(join(repo, 'node_modules/tsx/dist/loader.mjs')).href].join(' ');
    owner = spawn(launcher, ['--config', config], { env: { PATH: process.env.PATH, HOME: root, LANG: 'C', NODE_ENV: 'test', NODE_OPTIONS: nodeOptions, TSX_TSCONFIG_PATH: join(repo, 'tsconfig.json'), CORTEX_IDE_DATA_DIR: root, CORTEX_IDE_DB_PATH: join(root, 'cortex-ide.db'), CORTEX_IDE_REVIEW_REPO_ROOT: root, O8D_BINARY: daemon, O8_WS_O8D: '1', O8_TTS_PYTHON: join(root, 'no-python') }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; owner.stderr!.on('data', chunk => stderr += chunk);
    let port = 0, o8dPid = 0;
    await until(async () => {
      if (owner!.exitCode !== null || owner!.signalCode !== null) throw Error('Launcher exited before readiness: ' + stderr);
      try { port = Number(readFileSync(join(root, 'api-port'), 'utf8').trim()); const value = await (await fetch('http://127.0.0.1:' + port + '/health')).json(); o8dPid = value.delivery?.pid ?? 0; return o8dPid > 0 && pids(join(root, 'window-pids')).length > 0; } catch { return false; }
    }, 'launcher, producer and public o8d readiness');
    const origin = 'http://127.0.0.1:' + port, token = readFileSync(join(root, 'ws-token'), 'utf8').trim(), headers = { authorization: 'Bearer ' + token };
    const ownerEnvironment = Object.fromEntries(readFileSync('/proc/' + o8dPid + '/environ', 'utf8').split('\0').filter(Boolean).map(entry => { const at = entry.indexOf('='); return [entry.slice(0, at), entry.slice(at + 1)]; }));
    const holdInfo = readFileSync('/proc/' + o8dPid + '/fdinfo/' + ownerEnvironment.O8_LAUNCH_HOLD_FD, 'utf8');
    const holdFlags = Number.parseInt(holdInfo.match(/^flags:\s+([0-7]+)/m)![1], 8);
    expect(Boolean(holdFlags & 0o2000000), 'ownership hold must remain open in o8d and close on child exec').toBe(true);
    const bridgeKey = ownerEnvironment.O8D_BRIDGE_KEY; expect(Boolean(bridgeKey)).toBe(true);

    for (const bearer of ['', 'wrong-fixture-token']) {
      const refused = await fetch(origin + '/api/orchestrator/session-rules?threadId=launcher-gap', { headers: { authorization: 'Bearer ' + bearer, 'x-o8d-bridge': 'public-forgery' } });
      expect(refused.status).toBe(401); expect(refused.headers.get('x-o8d-native')).toBeNull();
    }
    const identity = await fetch(origin + '/api/setup/identity', { headers });
    expect(identity.headers.get('x-o8d-native')).toBe('1'); expect((await identity.json()).version).toBe(packageJson.version);
    const created = await fetch(origin + '/api/orchestrator/session-rules', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ threadId: 'launcher-gap', text: 'Native data remains readable during the producer gap' }) });
    expect(created.headers.get('x-o8d-native')).toBe('1'); expect(created.status).toBe(200); const rule = (await created.json()).result.rule;
    if (windowClient) {
      client = spawn(windowClient, ['launcher_owner_tests::producer_gap_reconnects','--ignored','--exact'], { env: { PATH: process.env.PATH, HOME: root, NODE_ENV: 'test', O8_LAUNCHER_CLIENT_ORIGIN: origin, O8_LAUNCHER_CLIENT_DATA: root }, stdio: ['pipe','pipe','pipe'] });
      client!.stdout!.on('data', chunk => clientOutput += chunk); client!.stderr!.on('data', chunk => clientOutput += chunk);
      await until(() => json(join(root, 'transport-first.json'))?.pid === json(join(root, 'launcher-ws.json'))?.pid, 'real window first producer');
    }
    const firstWs = json(join(root, 'launcher-ws.json')).pid as number;
    writeFileSync(join(root, 'hold-ws-start'), 'gate the replacement producer'); process.kill(firstWs, 'SIGKILL');
    await until(() => pids(join(root, 'ws-starts')).length >= 2, 'launcher replacement producer start');
    expect(alive(o8dPid), 'The launcher must retain the same o8d PID when the Node WS producer exits').toBe(true);
    expect(json(join(root, 'launcher-o8d.json'))).toMatchObject({ pid: o8dPid, port, parent: owner.pid });
    expect(Number(readFileSync(join(root, 'api-port'), 'utf8').trim())).toBe(port);
    expect(Number(readFileSync(join(root, 'ws-port'), 'utf8').trim())).toBe(port);
    const gap = await fetch(origin + '/api/orchestrator/session-rules?threadId=launcher-gap', { headers }); expect(gap.headers.get('x-o8d-native')).toBe('1'); expect((await gap.json()).result.rules.map((r: { id: string }) => r.id)).toContain(rule.id);
    const proxy = await fetch(origin + '/health'); expect(proxy.status).toBe(503); expect(proxy.headers.get('retry-after')).toBeTruthy();
    const closed = await new Promise<number>((resolve, reject) => { const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws?token=wrong-token'); ws.on('message', () => reject(Error('No producer must not serve WS application data'))); ws.on('close', code => resolve(code)); ws.on('error', reject); }); expect(closed).toBe(1013);
    if (client) await until(() => Boolean(json(join(root, 'transport-reconnecting.json'))), 'window reconnecting during gap');
    rmSync(join(root, 'hold-ws-start'));
    await until(async () => { try { const value = await (await fetch(origin + '/health')).json(); return value.delivery?.pid === o8dPid; } catch { return false; } }, 'replacement producer attach');
    const secondWs = json(join(root, 'launcher-ws.json')).pid as number; expect(secondWs).not.toBe(firstWs); expect(alive(firstWs)).toBe(false);
    if (client) {
      await until(() => json(join(root, 'transport-second.json'))?.pid === secondWs, 'same window client observes the new producer');
      const frames = readFileSync(join(root, 'subscriptions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      for (const pid of [firstWs, secondWs]) expect(frames.some(frame => frame.pid === pid)).toBe(true);
      for (const frame of frames) for (const subscription of frame.frame.subscriptions) expect(Object.hasOwn(subscription, 'since')).toBe(false);
    } else console.info('[native-client-proof] Client leg skipped: supply O8_LAUNCHER_TRANSPORT_TEST_BINARY; integration never builds the GUI crate.');
    await stop(owner); expect(owner.exitCode).toBe(0); expect(alive(o8dPid)).toBe(false); expect(alive(secondWs)).toBe(false);
    await expect(fetch(origin + '/health')).rejects.toThrow();
    for (const pid of pids(join(root, 'window-pids'))) expect(alive(pid)).toBe(false);
    if (client) { writeFileSync(join(root, 'transport-stop'), 'quit'); await until(() => client!.exitCode !== null, 'window transport probe exit'); expect(client.exitCode).toBe(0); expect(clientOutput).toContain('launcher_owner_tests::producer_gap_reconnects ... ok'); expect(clientOutput).toContain('1 passed'); }
    if (client) console.info('[native-client-proof] launcher_owner_tests::producer_gap_reconnects ... ok; 1 passed; same subscription, new producer/epoch, no since');
    console.info('[launcher-owner] same daemon PID and public port; native read during producer gap; proxy 503; WS 1013; quit cleans both child groups');
    expect(stderr.includes(bridgeKey)).toBe(false);
    expect(readFileSync(join(root, 'logs/o8d.log'), 'utf8').includes(bridgeKey)).toBe(false);
    expect(readFileSync(join(root, 'o8d-request-counts.jsonl'), 'utf8').includes(bridgeKey)).toBe(false);
    expect(stderr.includes(token)).toBe(false);
    expect(readFileSync(join(root, 'logs/o8d.log'), 'utf8').includes(token)).toBe(false);
    expect(readFileSync(join(root, 'o8d-request-counts.jsonl'), 'utf8').includes(token)).toBe(false);
  } finally { if (client && client.exitCode === null) { writeFileSync(join(root, 'transport-stop'), 'cleanup'); client.kill('SIGTERM'); } await stop(owner); rmSync(root, { recursive: true, force: true }); }
}, 240_000);
