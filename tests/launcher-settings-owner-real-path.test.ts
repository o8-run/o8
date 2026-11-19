import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { seedSessionFixture } from '../scripts/o8d/parity';

const run = promisify(execFile);
const target = process.env.O8_LAUNCHER_TEST_TARGET ?? '/tmp/o8-launcher-owner-target';
const launcher = process.env.O8_LAUNCHER_TEST_BINARY ?? join(target, 'debug/o8-launcher');
const daemon = process.env.O8D_TEST_BINARY ?? join(target, 'debug/o8d');
const clientBinary = process.env.O8_LAUNCHER_TRANSPORT_TEST_BINARY;
const settingsPath = '/api/panel/operator-defaults?include=native';
beforeAll(async () => {
  if (process.platform !== 'linux') return;
  if (!process.env.O8_LAUNCHER_TEST_BINARY || !process.env.O8D_TEST_BINARY) {
    const { stdout } = await run('df', ['-Pk', '/']);
    if (Number(stdout.trim().split('\n').at(-1)!.trim().split(/\s+/)[3]) < 15 * 1024 * 1024) throw Error('15 GiB free required');
  }
  if (!process.env.O8_LAUNCHER_TEST_BINARY) await run('cargo', ['build', '--locked', '--manifest-path', 'crates/o8-launcher/Cargo.toml', '--jobs', '1', '--target-dir', target]);
  if (!process.env.O8D_TEST_BINARY) await run('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--jobs', '1', '--target-dir', target]);
}, 600_000);
async function until(check: () => boolean | Promise<boolean>, reason: string, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > deadline) throw Error('Settings fixture timeout: ' + reason);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function json(path: string) { return JSON.parse(readFileSync(path, 'utf8')); }
async function stop(child: ChildProcess | undefined) {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await until(() => child.exitCode !== null || child.signalCode !== null, 'owned process quit', 15_000);
  }
}
async function start(override = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-settings-owner-'))), server = join(root, 'server');
  let owner: ChildProcess | undefined;
  try {
    await seedSessionFixture(root);
    await run('git', ['init', '--quiet', root]);
    mkdirSync(server);
    symlinkSync(join(process.cwd(), 'node_modules'), join(server, 'node_modules'), 'dir');
    if (override) writeFileSync(join(root, 'settings-env-override'), 'fixture override');
    const repo = process.cwd(), window = join(root, 'window'), probe = join(root, 'probe');
    writeFileSync(join(server, 'server.js'), 'throw Error("Next must remain absent");');
    writeFileSync(join(server, 'ws-server.mjs'), `await import(${JSON.stringify(pathToFileURL(join(repo, 'tests/fixtures/launcher-settings-owner-entry.mjs')).href)});`);
    writeFileSync(window, '#!/bin/sh\necho o8-next-ready\ncat >/dev/null\n', { mode: 0o700 });
    writeFileSync(probe, `#!/bin/sh\nprintf '__O8_PATH=%s\\n__O8_NODE=%s\\n' "$PATH" '${process.execPath}'\n`, { mode: 0o700 });
    writeFileSync(join(root, 'launch.json'), JSON.stringify({ data_dir: root, server_dir: server, node: process.execPath, window, probe, api_port: 0, ws_port: 0, version: 'fixture', native_lifecycle: false, api_front_door: true, next_off: true }));
    const nodeOptions = ['--require=' + join(repo, 'scripts/next/brain-runtime.cjs'), '--import=' + pathToFileURL(join(repo, 'scripts/register-server-only-stub.mjs')).href, '--import=' + pathToFileURL(join(repo, 'node_modules/tsx/dist/loader.mjs')).href].join(' ');
    owner = spawn(launcher, ['--config', join(root, 'launch.json')], { env: { PATH: process.env.PATH, HOME: root, LANG: 'C', NODE_ENV: 'test', NODE_OPTIONS: nodeOptions, TSX_TSCONFIG_PATH: join(repo, 'tsconfig.json'), CORTEX_IDE_DATA_DIR: root, CORTEX_IDE_DB_PATH: join(root, 'cortex-ide.db'), CORTEX_IDE_REVIEW_REPO_ROOT: root, O8D_BINARY: daemon, O8_TTS_PYTHON: join(root, 'no-python') }, stdio: ['pipe', 'ignore', 'ignore'] });
    let port = 0, pid = 0;
    await until(async () => {
      try {
        port = Number(readFileSync(join(root, 'api-port'), 'utf8').trim());
        pid = (await (await fetch('http://127.0.0.1:' + port + '/health')).json()).delivery?.pid ?? 0;
        return pid > 0 && existsSync(join(root, 'settings-identity.json'));
      } catch { return false; }
    }, 'producer readiness');
    const token = readFileSync(join(root, 'ws-token'), 'utf8').trim();
    return { root, owner, pid, origin: 'http://127.0.0.1:' + port, headers: { authorization: 'Bearer ' + token },
      close: async () => { await stop(owner); rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { await stop(owner); rmSync(root, { recursive: true, force: true }); throw error; }
}

it.runIf(process.platform === 'linux').each([false, true])('observes cold identity and per-request Settings environment authority (override=%s)', async override => {
  const fixture = await start(override);
  try {
    expect(json(join(fixture.root, 'settings-identity.json'))).toEqual({ cold: { cached: null, persisted: true }, warmMatchesLauncher: true, warmMatchesFile: true });
    const answer = await fetch(fixture.origin + settingsPath, { headers: fixture.headers });
    expect(answer.status).toBe(200);
    const body = await answer.json();
    expect(body.sources.branchPrefix).toBe(override ? 'env' : 'default');
    if (override) expect(body.values.branchPrefix).toBe('fixture-env');
    const admissions = readFileSync(join(fixture.root, 'settings-admissions.jsonl'), 'utf8').trim().split('\n').map(row => JSON.parse(row));
    expect(admissions).toContainEqual({ machineMatchesLauncher: true, machineMatchesFile: true, operatorEnvClean: !override });
    expect(answer.headers.get('x-o8d-native')).toBe(override ? null : '1');
    // These observations use the actual two processes, not the test's environment.
    const daemonEnv = readFileSync('/proc/' + fixture.pid + '/environ', 'utf8').split('\0');
    expect(daemonEnv.some(value => value.startsWith('O8_BRANCH_PREFIX='))).toBe(false);
    expect(daemonEnv.some(value => value.startsWith('O8_INSTANCE_ID='))).toBe(true);
    const machine = readFileSync(join(fixture.root, 'instance-id'), 'utf8').trim();
    writeFileSync(join(fixture.root, 'settings.toml'), '[scope]\nversion = 1\n[scope.machine.' + JSON.stringify(machine) + '.operator]\nparallel_cap = 11\n');
    const scoped = await (await fetch(fixture.origin + settingsPath, { headers: fixture.headers })).json();
    expect(scoped.scope.layers.machine.parallelCap).toBe(11);
    expect(scoped.values.parallelCap).toBe(11);
    console.info('[settings-authority] cold cache=null; launcher identity agrees; override=' + override + '; admitted clean=' + !override + '; native=' + (answer.headers.get('x-o8d-native') === '1'));
  } finally { await fixture.close(); }
}, 120_000);

it.runIf(process.platform === 'linux' && Boolean(clientBinary))('commits Settings with WS stopped through the production Client and notifies exactly once', async () => {
  const fixture = await start();
  let client: ChildProcess | undefined, output = '';
  try {
    client = spawn(clientBinary!, ['launcher_owner_tests::settings_save_during_producer_gap', '--ignored', '--exact', '--nocapture'], { env: { PATH: process.env.PATH, HOME: fixture.root, NODE_ENV: 'test', O8_LAUNCHER_CLIENT_ORIGIN: fixture.origin, O8_LAUNCHER_CLIENT_DATA: fixture.root }, stdio: ['ignore', 'pipe', 'pipe'] });
    client!.stdout!.on('data', chunk => output += chunk);
    client!.stderr!.on('data', chunk => output += chunk);
    await until(() => existsSync(join(fixture.root, 'settings-client-ready')) || client!.exitCode !== null, 'production Settings initial read');
    expect(existsSync(join(fixture.root, 'settings-client-ready')), output).toBe(true);
    const producer = json(join(fixture.root, 'launcher-ws.json')).pid as number;
    writeFileSync(join(fixture.root, 'hold-ws-start'), 'hold');
    process.kill(producer, 'SIGKILL');
    await until(() => readFileSync(join(fixture.root, 'ws-starts'), 'utf8').trim().split('\n').length >= 2, 'replacement producer held');
    expect(json(join(fixture.root, 'launcher-o8d.json')).pid).toBe(fixture.pid);
    expect(readFileSync('/proc/' + fixture.pid + '/stat', 'utf8').split(') ')[1].startsWith('Z')).toBe(false);
    expect(Number(readFileSync(join(fixture.root, 'api-port'), 'utf8'))).toBe(Number(new URL(fixture.origin).port));
    expect((await fetch(fixture.origin + '/api/panel/ws-info', { headers: fixture.headers })).status).toBe(200);
    writeFileSync(join(fixture.root, 'settings-client-save'), 'save');
    await until(() => client!.exitCode !== null, 'production Settings save/event result', 100_000);
    const result = json(join(fixture.root, 'settings-client-result.json'));
    console.info('[settings-producer-gap] production Client Settings POST status=' + result.status + '; same o8d PID/public port=true');
    expect(result.status, 'Settings save must commit with WS stopped').toBe(200);
    expect(client!.exitCode, output).toBe(0);
    const token = readFileSync(join(fixture.root, 'ws-token'), 'utf8').trim();
    expect(output.includes(token)).toBe(false);
  } finally { await stop(client); await fixture.close(); }
}, 180_000);

it.runIf(process.platform === 'linux')('preserves overlapping public Settings and Node source updates with one writer', async () => {
  const fixture = await start(), notes = realpathSync(mkdtempSync(join(tmpdir(), 'o8-settings-notes-')));
  try {
    const headers = { ...fixture.headers, 'content-type': 'application/json' };
    const before = await (await fetch(fixture.origin + settingsPath, { headers })).json();
    const [setting, source] = await Promise.all([
      fetch(fixture.origin + settingsPath, { method: 'POST', headers, body: JSON.stringify({ branchPrefix: 'fixture-concurrent', settingsTomlRevision: before.settingsToml.revision }) }),
      fetch(fixture.origin + '/api/cortex/sources', { method: 'POST', headers, body: JSON.stringify({ action: 'add', path: notes, name: 'Fixture notes' }) }),
    ]);
    expect(source.status).toBe(200);
    expect([200, 409]).toContain(setting.status);
    let committed = setting;
    if (setting.status === 409) {
      const fresh = await (await fetch(fixture.origin + settingsPath, { headers })).json();
      const retry = await fetch(fixture.origin + settingsPath, { method: 'POST', headers, body: JSON.stringify({ branchPrefix: 'fixture-concurrent', settingsTomlRevision: fresh.settingsToml.revision }) });
      expect(retry.status).toBe(200);
      committed = retry;
    }
    const after = await (await fetch(fixture.origin + settingsPath, { headers })).json();
    expect(after.values.branchPrefix).toBe('fixture-concurrent');
    expect(after.values.knowledgeSources.some((item: { path: string }) => item.path === notes)).toBe(true);
    expect(committed.headers.get('x-o8d-native')).toBe('1');
    expect(existsSync(join(fixture.root, 'settings-node-writes.jsonl'))).toBe(false);
  } finally { await fixture.close(); rmSync(notes, { recursive: true, force: true }); }
}, 120_000);
