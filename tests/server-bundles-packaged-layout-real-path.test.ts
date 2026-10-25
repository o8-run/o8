import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundleServers, SERVER_ENTRIES } from '../scripts/lib/server-bundles.mjs';
import { stagePackagedNativeAddons } from './helpers/packaged-native-addons';

const root = mkdtempSync(join(tmpdir(), 'o8-server-layout-'));
const serverDir = join(root, 'server');
const state = join(root, 'state');
const children: ChildProcess[] = [];
let api: Server;
let apiPort: number;
let report: ReturnType<typeof bundleServers>;

async function freePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(done => listener.close(() => done()));
  return port;
}
function launch(label: string, extra: Record<string, string> = {}, args: string[] = []) {
  const child = spawn(process.execPath, [join(serverDir, `${label}.mjs`), ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', HOME: root, USERPROFILE: root,
      O8_DATA_DIR: state, CORTEX_IDE_DATA_DIR: state, CORTEX_IDE_DB_PATH: join(state, 'db.sqlite'),
      CORTEX_IDE_REVIEW_REPO_ROOT: root, O8_API_PORT: String(apiPort),
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`, O8_SILENT_EXIT_DETECTOR_ENABLED: '0', ...extra },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  let output = '';
  child.stdout!.on('data', data => { output += String(data); });
  child.stderr!.on('data', data => { output += String(data); });
  return { child, output: () => output };
}
async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error('Packaged bundle did not answer its protocol');
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 2000);
  await exited;
  clearTimeout(force);
}

beforeAll(async () => {
  mkdirSync(state);
  report = bundleServers({ root: process.cwd(), outDir: serverDir });
  // Only native externals are installed. All JavaScript dependencies must come
  // from the generated entries/chunks, with no checkout node_modules above them.
  stagePackagedNativeAddons({ projectRoot: process.cwd(), serverRoot: serverDir });
  cpSync('src/lib/lane/orchestrator.md', join(serverDir, 'orchestrator.md'));
  api = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url === '/api/mcp'
        ? { jsonrpc: '2.0', id: JSON.parse(body).id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'fixture' }, capabilities: {} } }
        : { repos: [], ready: true, configured: false }));
    });
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  apiPort = (api.address() as { port: number }).port;
}, 60_000);

afterAll(async () => {
  await Promise.all(children.map(stop));
  if (api?.listening) {
    api.closeAllConnections();
    await new Promise<void>(done => api.close(() => done()));
  }
  rmSync(root, { recursive: true, force: true });
});

describe('shared server bundles in the packaged layout', () => {
  it('keeps all launcher and implementation paths, sibling chunks, names, and no maps', () => {
    const files = readdirSync(serverDir);
    for (const label of Object.keys(SERVER_ENTRIES)) {
      expect(files).toContain(`${label}.mjs`);
      expect(files).toContain(`${label}-impl.mjs`);
      const launcher = readFileSync(join(serverDir, `${label}.mjs`), 'utf8');
      if (!['operator-mcp-proxy', 'codex-app-bridge'].includes(label)) {
        expect(launcher.indexOf('prepareNativeAddons')).toBeLessThan(launcher.indexOf('await import'));
      } else expect(launcher).not.toContain('prepareNativeAddons');
    }
    expect(files.some(file => file.startsWith('server-chunk-'))).toBe(true);
    expect(files.some(file => file.endsWith('.map'))).toBe(false);
    expect(new Set(report.outputs.map(output => output.budgetKey)).size).toBe(report.outputs.length);
    // esbuild keepNames emits original function names even after identifiers shrink.
    expect(readFileSync(join(serverDir, 'ws-server-impl.mjs'), 'utf8')).toContain('"startPollingLoops"');
    for (const output of report.outputs) {
      expect(/^\s*\/\/[#@] sourceMappingURL=/m.test(readFileSync(join(serverDir, output.file), 'utf8')), output.file).toBe(false);
    }
  });

  it.skipIf(process.platform === 'win32')('boots the real native selector and addons from the macOS active-ABI package layout', () => {
    const macServer = join(root, 'mac-server');
    stagePackagedNativeAddons({ projectRoot: process.cwd(), serverRoot: macServer, platform: 'darwin' });
    const probe = join(macServer, 'native-probe.cjs');
    writeFileSync(probe, `
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      require('./native-addon-runtime.cjs').prepareNativeAddons(__dirname);
      const Database = require('better-sqlite3');
      const db = new Database(':memory:');
      console.log(JSON.stringify(db.prepare('select 1 as ready').get()));
      db.close();
      require('node-pty');
    `);
    const result = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr.replace(/\/[^\s)]+/g, '<path>').slice(-400)).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ready: 1 });
  });

  it.each(['operator-mcp-proxy', 'codex-app-bridge'])('keeps %s independent of native addons', label => {
    const outputs = report.metafile.outputs;
    const entry = Object.keys(outputs).find(file => file.endsWith(`/${label}-impl.mjs`))!;
    const visited = new Set<string>();
    const nativeImports = new Set<string>();
    const visit = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      for (const imported of outputs[file].imports) {
        if (!imported.external) visit(imported.path);
        else if (['better-sqlite3', 'node-pty', 'bindings'].includes(imported.path)) nativeImports.add(imported.path);
      }
    };
    visit(entry);
    expect([...nativeImports]).toEqual([]);
  });

  it.each(['operator-mcp-server-main', 'operator-mcp-server', 'cortex-mcp-server', 'operator-mcp-proxy'])(
    'boots %s and completes MCP initialization', async label => {
      const { child, output } = launch(label);
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 73, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }) + '\n');
      try {
        await waitFor(() => output().split('\n').some(line => {
          try { const message = JSON.parse(line); return message.id === 73 && Boolean(message.result?.serverInfo); } catch { return false; }
        }));
      } finally { await stop(child); }
    },
  );

  it('boots ws-server and answers health through its generated launcher', async () => {
    const wsPort = await freePort();
    const { child } = launch('ws-server', { O8_WS_PORT: String(wsPort) });
    try {
      await waitFor(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${wsPort}/health`, { signal: AbortSignal.timeout(500) });
          const health = await response.json();
          return response.ok && health.product === 'o8' && health.status === 'ok';
        } catch { return false; }
      });
    } finally { await stop(child); }
  });

  it('serves native-owned HTTP from the packaged launcher with Next unreachable', async () => {
    const wsPort = await freePort();
    const { child, output } = launch('ws-server', { O8_WS_PORT: String(wsPort),
      O8_NEXT_HTTP_OWNER: '1', NEXT_ORIGIN: 'http://127.0.0.1:1' });
    const origin = `http://127.0.0.1:${wsPort}`;
    try {
      await waitFor(async () => {
        try { return (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) })).ok; }
        catch { return false; }
      }).catch(error => { throw new Error(`${String(error)}\n${output()}`); });
      const denied = await fetch(`${origin}/api/panel/ws-info`, { signal: AbortSignal.timeout(5000) });
      expect(denied.status, output()).toBe(401);
      const token = readFileSync(join(state, 'ws-token'), 'utf8').trim();
      const response = await fetch(`${origin}/api/panel/ws-info`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
      });
      expect(response.status, output()).toBe(200);
      expect(await response.json()).toMatchObject({ wsPort, wsToken: token });
    } finally { await stop(child); }
  });

  it('boots terminal-host over the packaged fork IPC channel', async () => {
    const { child, output } = launch('terminal-host');
    try {
      await waitFor(() => output().includes('[terminal-host] child started'));
      expect(output()).not.toContain('node-pty unavailable');
      const exited = once(child, 'exit');
      child.disconnect();
      expect((await exited)[0]).toBe(0);
    } finally { await stop(child); }
  });

  it('boots codex-app-bridge and reaches spec validation without a real account', async () => {
    const spec = join(root, 'bridge-spec.json');
    writeFileSync(spec, 'malformed fixture');
    const { child, output } = launch('codex-app-bridge', {}, [spec]);
    expect((await once(child, 'exit'))[0]).toBe(1);
    expect(output()).toContain('Codex app bridge: malformed spec');
  });
});
