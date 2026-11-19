import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { beforeAll, expect, it } from 'vitest';
import { seedSessionFixture } from '../scripts/o8d/parity';
interface WireEvent { data: { mutation: { surfaceId: string } }; }
interface WireFrame { channel: string; event: string; data: { delivery: string; epoch: string; events: WireEvent[] }; }
const run = promisify(execFile);
const target = process.env.O8_LAUNCHER_TEST_TARGET ?? '/tmp/o8-launcher-owner-target';
const launcher = process.env.O8_LAUNCHER_TEST_BINARY ?? join(target, 'debug/o8-launcher');
const daemon = process.env.O8D_TEST_BINARY ?? join(target, 'debug/o8d');
const clientBinary = process.env.O8_LAUNCHER_TRANSPORT_TEST_BINARY;
beforeAll(async () => {
  if (process.platform !== 'linux') return;
  if (!process.env.O8_LAUNCHER_TEST_BINARY) await run('cargo', ['build', '--locked', '--manifest-path', 'crates/o8-launcher/Cargo.toml', '--jobs', '1', '--target-dir', target]);
  if (!process.env.O8D_TEST_BINARY) await run('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--jobs', '1', '--target-dir', target]);
}, 600_000);
function json(path: string) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function alive(pid: number) { try { process.kill(pid, 0); return !readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].startsWith('Z'); } catch { return false; } }
async function until(check: () => boolean | Promise<boolean>, reason: string, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw Error('Native global fixture timeout: ' + reason); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function stop(child: ChildProcess | undefined) {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await until(() => child.exitCode !== null || child.signalCode !== null, 'owned process quit', 15_000); }
}
function bootstrap(origin: string, headers: Record<string, string>) {
  return new Promise<{ status: number; marker: string | undefined; type: string | undefined; cache: string | undefined; body: string }>((resolve, reject) => {
    const req = request(origin + '/api/panel/ws-info', { headers }, res => {
      let body = ''; res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode!, marker: res.headers['x-o8d-native'] as string | undefined, type: res.headers['content-type'], cache: res.headers['cache-control'], body }));
    }); req.on('error', reject); req.end();
  });
}
function connect(origin: string, token: string, headers: Record<string, string> = {}) {
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws?token=' + encodeURIComponent(token), { headers });
  const frames: WireFrame[] = []; // Protocol fields are asserted before use.
  let code: number | null = null;
  socket.on('message', raw => frames.push(JSON.parse(String(raw))));
  socket.on('close', value => code = value);
  socket.on('error', () => {});
  return { socket, frames, get code() { return code; } };
}
it.runIf(process.platform === 'linux')('bootstraps the real window Client without Node, delivers a native global event and hands back to TS', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-native-global-'))), server = join(root, 'server');
  let owner: ChildProcess | undefined, client: ChildProcess | undefined;
  const sockets: WebSocket[] = []; let clientOutput = '', stderr = '';
  try {
    await seedSessionFixture(root); await run('git', ['init', '--quiet', root]); mkdirSync(server);
    symlinkSync(join(process.cwd(), 'node_modules'), join(server, 'node_modules'), 'dir');
    const repo = process.cwd(), window = join(root, 'window'), probe = join(root, 'probe');
    writeFileSync(join(server, 'server.js'), 'throw Error("Next must remain absent");');
    writeFileSync(join(server, 'ws-server.mjs'), `await import(${JSON.stringify(pathToFileURL(join(repo, 'tests/fixtures/launcher-ws-owner-entry.mjs')).href)});`);
    writeFileSync(window, '#!/bin/sh\necho o8-next-ready\ncat >/dev/null\n', { mode: 0o700 });
    writeFileSync(probe, `#!/bin/sh\nprintf '__O8_PATH=%s\\n__O8_NODE=%s\\n' "$PATH" '${process.execPath}'\n`, { mode: 0o700 });
    writeFileSync(join(root, 'launch.json'), JSON.stringify({ data_dir: root, server_dir: server, node: process.execPath, window, probe, api_port: 0, ws_port: 0, version: 'fixture', native_lifecycle: false, api_front_door: true, next_off: true }));
    const nodeOptions = ['--require=' + join(repo, 'scripts/next/brain-runtime.cjs'), '--import=' + pathToFileURL(join(repo, 'scripts/register-server-only-stub.mjs')).href, '--import=' + pathToFileURL(join(repo, 'node_modules/tsx/dist/loader.mjs')).href].join(' ');
    owner = spawn(launcher, ['--config', join(root, 'launch.json')], { env: { PATH: process.env.PATH, HOME: root, LANG: 'C', NODE_ENV: 'test', NODE_OPTIONS: nodeOptions, TSX_TSCONFIG_PATH: join(repo, 'tsconfig.json'), CORTEX_IDE_DATA_DIR: root, CORTEX_IDE_DB_PATH: join(root, 'cortex-ide.db'), CORTEX_IDE_REVIEW_REPO_ROOT: root, O8D_BINARY: daemon, O8_TTS_PYTHON: join(root, 'no-python') }, stdio: ['pipe', 'pipe', 'pipe'] });
    owner.stderr!.on('data', chunk => stderr += chunk);
    let port = 0, daemonPid = 0;
    await until(async () => { try { port = Number(readFileSync(join(root, 'api-port'), 'utf8').trim()); const body = await (await fetch('http://127.0.0.1:' + port + '/health')).json(); daemonPid = body.delivery?.pid ?? 0; return daemonPid > 0; } catch { return false; } }, 'producer readiness');
    const origin = 'http://127.0.0.1:' + port, token = readFileSync(join(root, 'ws-token'), 'utf8').trim(), headers = { authorization: 'Bearer ' + token };
    const expected = await bootstrap(origin, headers); expect(expected.status).toBe(200);
    const firstProducer = json(join(root, 'launcher-ws.json')).pid as number;
    writeFileSync(join(root, 'hold-ws-start'), 'hold replacement before production import'); process.kill(firstProducer, 'SIGKILL');
    await until(() => { try { return readFileSync(join(root, 'ws-starts'), 'utf8').trim().split('\n').length >= 2; } catch { return false; } }, 'replacement start');
    const gap = await bootstrap(origin, headers);
    expect(gap.status, 'Native operator ws-info bootstrap must be reachable without Node').toBe(200);
    expect(gap.marker).toBe('1'); expect(gap.type).toBe(expected.type); expect(gap.cache).toBe(expected.cache);
    expect(gap.body === expected.body, 'bootstrap response contract must match TS-backed mode').toBe(true);
    for (const bad of ([{}, { authorization: 'Bearer wrong' }, { ...headers, host: 'foreign.invalid:' + port }, { ...headers, 'x-o8-relay-forward': '1' }, { ...headers, 'x-o8d-peer': '127.0.0.1' }, { ...headers, 'x-o8-client-addr': '127.0.0.1' }] as Record<string, string>[])) {
      const refused = await bootstrap(origin, bad); expect(refused.status).toBe(503); expect(refused.marker).toBeUndefined();
    }
    for (const [bearer, extra] of [['wrong', {}], ['o8ro_fixture_read_only', {}], ['o8br_fixture_brain', {}], ['o8p_fixture_plugin', {}], [token, { host: 'foreign.invalid:' + port }], [token, { 'x-o8-relay-forward': '1' }], [token, { 'x-o8d-peer': '127.0.0.1' }], [token, { 'x-o8-client-addr': '127.0.0.1' }]] as [string, Record<string, string>][]) {
      const refused = connect(origin, bearer, extra); sockets.push(refused.socket);
      await until(() => refused.code !== null, 'upgrade refusal'); expect(refused.code).toBe(1013); expect(refused.frames.length).toBe(0);
    }
    for (const command of [{ type: 'realtime-subscribe', subscriptions: [{ stream: 'session:llm-chat:fixture' }] }, { type: 'orchestrator-send', text: 'must not run' }, { type: 'realtime-subscribe', subscriptions: [{ stream: 'global', since: 1 }] }]) {
      const refused = connect(origin, token); sockets.push(refused.socket);
      await until(() => refused.socket.readyState === WebSocket.OPEN, 'operator upgrade'); refused.socket.send(JSON.stringify(command));
      await until(() => refused.code !== null, 'unsupported command refusal'); expect(refused.code).toBe(1013); expect(refused.frames.length).toBe(0);
    }
    // Every bootstrap and session delivery consults fresh canonical authority.
    const rotated = 'fixture-rotated-operator-credential';
    writeFileSync(join(root, 'ws-token'), rotated, { mode: 0o600 });
    expect((await bootstrap(origin, headers)).status).toBe(503);
    const stale = connect(origin, token); sockets.push(stale.socket);
    await until(() => stale.code !== null, 'rotated token refusal'); expect(stale.frames.length).toBe(0);
    const fresh = connect(origin, rotated); sockets.push(fresh.socket);
    await until(() => fresh.socket.readyState === WebSocket.OPEN, 'rotated native upgrade');
    fresh.socket.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions: [{ stream: 'global' }] }));
    await until(() => fresh.frames.some(frame => frame.channel === 'system'), 'rotated credential session');
    rmSync(join(root, 'ws-token'));
    fresh.socket.send(JSON.stringify({ type: 'ping' }));
    await until(() => fresh.code !== null, 'missing authority revokes session'); expect(fresh.code).toBe(1013);
    writeFileSync(join(root, 'token-target'), token); symlinkSync(join(root, 'token-target'), join(root, 'ws-token'));
    expect((await bootstrap(origin, headers)).status).toBe(503);
    const linked = connect(origin, token); sockets.push(linked.socket);
    await until(() => linked.code !== null, 'symlink credential refusal'); expect(linked.frames.length).toBe(0);
    rmSync(join(root, 'ws-token')); writeFileSync(join(root, 'ws-token'), token, { mode: 0o600 });
    const observer = connect(origin, token); sockets.push(observer.socket);
    await until(() => observer.socket.readyState === WebSocket.OPEN, 'native operator upgrade');
    observer.socket.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions: [{ stream: 'global' }] }));
    await until(() => observer.frames.some(frame => frame.channel === 'realtime' && frame.event === 'batch'), 'native checkpoint');
    expect(observer.frames.some(frame => frame.channel === 'system' && frame.event === 'connected')).toBe(true);
    const checkpoint = observer.frames.find(frame => frame.channel === 'realtime' && frame.event === 'batch')!;
    expect(checkpoint.data.delivery).toBe('bootstrap'); expect(checkpoint.data.epoch.startsWith('o8d-native:')).toBe(true);
    observer.socket.send(JSON.stringify({ type: 'ping' })); await until(() => observer.frames.some(frame => frame.channel === 'pong'), 'native ping');
    const beforeReads = readFileSync(join(root, 'o8d-request-counts.jsonl'), 'utf8').split('\n').filter(line => line.includes('"route":"/api/panel/ws-info"') && line.includes('"status":200')).length;
    if (clientBinary) {
      client = spawn(clientBinary, ['launcher_owner_tests::producer_gap_reconnects', '--ignored', '--exact'], { env: { PATH: process.env.PATH, HOME: root, NODE_ENV: 'test', O8_LAUNCHER_CLIENT_ORIGIN: origin, O8_LAUNCHER_CLIENT_DATA: root }, stdio: ['pipe', 'pipe', 'pipe'] });
      client.stdout!.on('data', chunk => clientOutput += chunk); client.stderr!.on('data', chunk => clientOutput += chunk);
      await until(() => readFileSync(join(root, 'o8d-request-counts.jsonl'), 'utf8').split('\n').filter(line => line.includes('"route":"/api/panel/ws-info"') && line.includes('"status":200')).length > beforeReads, 'first Client bootstrap during gap');
    }
    await until(async () => {
      writeFileSync(join(root, 'publish-native-global'), 'test-only commit');
      await new Promise(resolve => setTimeout(resolve, 100));
      return client ? json(join(root, 'transport-first.json'))?.pid === daemonPid : observer.frames.some(frame => frame.data?.events?.some((event: WireEvent) => event.data?.mutation?.surfaceId === String(daemonPid)));
    }, 'daemon-owned global event');
    if (client) expect(json(join(root, 'transport-first.json')).epoch.startsWith('o8d-native:')).toBe(true);
    rmSync(join(root, 'hold-ws-start'));
    await until(async () => { try { return (await (await fetch(origin + '/health')).json()).delivery?.pid === daemonPid; } catch { return false; } }, 'producer reattach');
    await until(() => observer.code !== null, 'native session handoff'); expect(observer.code).toBe(1013);
    const secondProducer = json(join(root, 'launcher-ws.json')).pid as number;
    if (client) {
      await until(() => json(join(root, 'transport-second.json'))?.pid === secondProducer, 'real Client receives TS event after handoff');
      const frames = readFileSync(join(root, 'subscriptions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(frames.some(row => row.pid === secondProducer)).toBe(true);
      for (const row of frames) for (const subscription of row.frame.subscriptions) expect(Object.hasOwn(subscription, 'since')).toBe(false);
    } else console.info('[native-client-proof] Supply O8_LAUNCHER_TRANSPORT_TEST_BINARY for the actual window Client leg; integration does not build the GUI.');
    await stop(owner); expect(owner.exitCode).toBe(0); expect(alive(daemonPid)).toBe(false); expect(alive(secondProducer)).toBe(false); await expect(fetch(origin + '/health')).rejects.toThrow();
    if (client) { writeFileSync(join(root, 'transport-stop'), 'quit'); await until(() => client!.exitCode !== null, 'Client quit'); expect(client.exitCode).toBe(0); expect(clientOutput.includes('launcher_owner_tests::producer_gap_reconnects ... ok') && clientOutput.includes('1 passed')).toBe(true); }
    const childEnvironment = readFileSync(join(root, 'logs/o8d.log'), 'utf8') + stderr + readFileSync(join(root, 'o8d-request-counts.jsonl'), 'utf8');
    expect(childEnvironment.includes(token) || childEnvironment.includes(rotated)).toBe(false);
  } finally { for (const socket of sockets) socket.terminate(); if (client && client.exitCode === null) client.kill('SIGTERM'); await stop(owner); rmSync(root, { recursive: true, force: true }); }
}, 240_000);
