#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import net from 'node:net';
import { BOOT_PROBE_JS } from './preship-gate-logic.mjs';
import { cleanupGate } from './lib/preship-gate-cleanup.mjs';
import { chatTurn, nativeEval, until, workerDispatch } from './lib/installed-smoke-client.mjs';
import { fileSha256, manifestSha256, SMOKE_STEPS } from './lib/smoke-receipt.mjs';

function options(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--artifact', '--manifest', '--receipt', '--timeout-ms'].includes(key) || !args[i + 1]) throw new Error('arguments');
    values[key.slice(2)] = args[i + 1];
  }
  for (const key of ['artifact', 'manifest', 'receipt']) {
    if (!values[key]) throw new Error('arguments');
    values[key] = resolve(values[key]);
  }
  if (!values.receipt.endsWith('.json') || [values.artifact, values.manifest].includes(values.receipt)) throw new Error('arguments');
  values.timeout = Number(values['timeout-ms'] ?? 120_000);
  if (!Number.isFinite(values.timeout) || values.timeout < 100 || values.timeout > 600_000) throw new Error('arguments');
  return values;
}
function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const file = join(dir, name);
    try { accessSync(file, constants.X_OK); return realpathSync(file); } catch {}
  }
  return null;
}
async function ports() {
  const servers = [net.createServer(), net.createServer()];
  try {
    await Promise.all(servers.map(server => new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))));
    return servers.map(server => server.address().port);
  } finally { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); }
}
function isolatedEnvironment(root, apiPort, wsPort, socketPath) {
  const env = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LD_LIBRARY_PATH', 'DISPLAY', 'WAYLAND_DISPLAY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_ACCESS_TOKEN']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const home = join(root, 'profile');
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'),
    XDG_DATA_HOME: join(home, 'data'), XDG_RUNTIME_DIR: join(home, 'runtime'), CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'), O8_DATA_DIR: join(root, 'data'), CORTEX_IDE_DATA_DIR: join(root, 'data'),
    O8_TAURI_MCP_SOCKET: socketPath, O8_API_PORT: String(apiPort), O8_WS_PORT: String(wsPort), O8_PRESHIP_GATE: '1',
    O8_FORCE_BUNDLED_SERVERS: '1', O8_INSTALLED_SMOKE_RUN: randomUUID(), O8_MASTER_KEY: randomBytes(32).toString('base64') });
  for (const path of [home, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.XDG_RUNTIME_DIR, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, env.O8_DATA_DIR]) mkdirSync(path, { recursive: true, mode: 0o700 });
  return env;
}
function providers(root, env) {
  const modes = {};
  for (const [kind, command, variable] of [['codex', 'codex', 'O8_CODEX_BIN'], ['claude', 'claude', 'O8_CLAUDE_CODE_BIN']]) {
    let binary = onPath(command);
    modes[kind] = binary ? 'real' : 'fixture';
    if (!binary) {
      binary = join(root, `${kind}-fixture.mjs`);
      const source = readFileSync(new URL('./fixtures/installed-smoke-provider.mjs', import.meta.url), 'utf8');
      writeFileSync(binary, source.replace(/^#!.*\n/, `#!${process.execPath}\n`), { mode: 0o700 });
    }
    env[variable] = binary;
  }
  if (modes.codex === 'fixture') { delete env.OPENAI_API_KEY; delete env.CODEX_ACCESS_TOKEN; }
  if (modes.claude === 'fixture') delete env.ANTHROPIC_API_KEY;
  modes.worker = modes.codex === 'real' || modes.claude === 'real' ? 'real' : 'fixture';
  return modes;
}
function unpack(artifact, root, env) {
  const installed = join(root, 'installed');
  mkdirSync(installed);
  const run = (command, args, cwd = installed) => execFileSync(command, args, { cwd, env, timeout: 120_000, stdio: 'pipe' });
  if (artifact.endsWith('.dmg') && process.platform === 'darwin') {
    const mount = join(root, 'mount');
    mkdirSync(mount);
    run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, artifact]);
    try {
      run('/usr/bin/ditto', [join(mount, 'o8.app'), join(installed, 'o8.app')]);
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(installed, 'o8.app')]);
    } finally { run('/usr/bin/hdiutil', ['detach', mount]); }
    return join(installed, 'o8.app/Contents/MacOS/o8');
  }
  if (process.platform === 'linux' && artifact.endsWith('.AppImage')) {
    run(artifact, ['--appimage-extract']);
    return join(installed, 'squashfs-root/usr/bin/o8');
  }
  if (process.platform === 'linux' && artifact.endsWith('.deb')) {
    run('dpkg-deb', ['--extract', artifact, installed]);
    return join(installed, 'usr/bin/o8');
  }
  throw new Error('unsupported installer');
}

async function main() {
  let step = 'arguments', root, child, env, socketPath, config;
  const steps = {};
  let receipt;
  let cleanupFailed = false;
  try {
    config = options(process.argv.slice(2));
    step = 'artifact';
    const manifest = JSON.parse(readFileSync(config.manifest, 'utf8'));
    const artifactSha256 = fileSha256(config.artifact);
    if (manifest.channel !== 'beta' || !manifest.installers?.some(installer => installer.sha256 === artifactSha256)) throw new Error('artifact identity mismatch');
    rmSync(config.receipt, { force: true });
    root = mkdtempSync(join(realpathSync(process.platform === 'darwin' ? '/tmp' : tmpdir()), 'o8-smoke-'));
    socketPath = join(root, 'view.sock');
    const [apiPort, wsPort] = await ports();
    env = isolatedEnvironment(root, apiPort, wsPort, socketPath);
    const modes = providers(root, env);
    const workerRuntime = modes.codex === 'real' || modes.claude !== 'real' ? 'codex' : 'claude-code';
    receipt = { schema: 'o8/installed-smoke/v1', status: 'failed', version: manifest.version, artifactSha256,
      manifestSha256: manifestSha256(manifest), providers: modes, workerRuntime, steps };
    step = 'unpack';
    const executable = unpack(config.artifact, root, env);
    const repoPath = join(env.HOME, 'workspace');
    mkdirSync(repoPath);
    const git = args => execFileSync('git', args, { cwd: repoPath, env, stdio: 'pipe' });
    git(['init', '-q']);
    writeFileSync(join(repoPath, 'README.md'), 'Disposable installed-build smoke workspace.\n');
    git(['add', 'README.md']);
    git(['-c', 'user.name=o8', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'smoke fixture']);
    step = 'first-window';
    child = spawn(executable, [], { cwd: dirname(executable), env, detached: true, stdio: 'ignore' });
    let launchError = false;
    child.on('error', () => { launchError = true; });
    await until(async () => {
      if (launchError || child.exitCode !== null || child.signalCode !== null) throw new Error('app exited');
      try {
        const reportPath = join(env.O8_DATA_DIR, 'installed-smoke-window.json');
        if (existsSync(reportPath)) {
          const report = JSON.parse(readFileSync(reportPath, 'utf8'));
          if (report.runId !== env.O8_INSTALLED_SMOKE_RUN || report.version !== manifest.version || report.ready !== true) throw new Error('version mismatch');
          return true;
        }
        const window = await nativeEval(socketPath, `(async () => {
          if (!location.pathname.includes('/dashboard') || (${BOOT_PROBE_JS}) !== 'hydrated') return JSON.stringify({ready:false});
          const info = await window.__TAURI_INTERNALS__.invoke('get_desktop_info');
          return JSON.stringify({ready:true,version:info.version});
        })()`, Math.min(config.timeout, 3000));
        if (window?.ready && window.version !== manifest.version) throw new Error('version mismatch');
        return window?.ready;
      } catch (error) { if (error.message === 'version mismatch') throw error; return false; }
    }, config.timeout);
    steps[step] = 'passed';
    await until(() => existsSync(join(env.O8_DATA_DIR, 'ws-token')) && existsSync(join(env.O8_DATA_DIR, 'api-port')), config.timeout);
    const token = readFileSync(join(env.O8_DATA_DIR, 'ws-token'), 'utf8').trim();
    for (const backend of ['codex', 'claude']) {
      step = `${backend}-chat`;
      console.log(`[installed-smoke] ${step}: ${modes[backend]}`);
      await chatTurn({ port: wsPort, token, repoPath, backend, timeout: config.timeout });
      steps[step] = 'passed';
    }
    step = 'worker-dispatch';
    console.log(`[installed-smoke] ${step}: ${modes.worker}`);
    await workerDispatch({ apiPort, token, repoPath, runtime: workerRuntime, timeout: config.timeout });
    steps[step] = 'passed';
  } catch {
    if (receipt) receipt.failedStep = step;
    process.exitCode = 1;
    console.error(`[installed-smoke] failed: ${step}`);
  } finally {
    if (root) {
      try {
        await cleanupGate({ child, dataDir: env?.O8_DATA_DIR, socketPath });
        rmSync(root, { recursive: true, force: true });
        steps.cleanup = 'passed';
      } catch {
        cleanupFailed = true;
        process.exitCode = 1;
        if (receipt) receipt.failedStep = 'cleanup';
        console.error('[installed-smoke] failed: cleanup; isolated state retained');
      }
    }
    if (receipt && config) {
      receipt.status = !process.exitCode && !cleanupFailed && SMOKE_STEPS.every(name => steps[name] === 'passed') ? 'passed' : 'failed';
      receipt.completedAt = new Date().toISOString();
      mkdirSync(dirname(config.receipt), { recursive: true });
      writeFileSync(config.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    }
  }
}
main().catch(() => { console.error('[installed-smoke] failed: receipt'); process.exitCode = 1; });
