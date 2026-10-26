#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveSpawn, withServerOnlyStubNodeOptions } from './run-lib.mjs';
import { generatedOutputLaunch } from './lib/generated-output-launch.mjs';

const root = process.cwd();
const stateDir = join(
  process.env.O8_DATA_DIR
    || process.env.CORTEX_IDE_DATA_DIR
    || join(homedir(), '.o8'),
  'dev',
);
const pidFile = join(stateDir, 'pids.json');
const env = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: process.env.PORT || '47120',
  O8_API_PORT: process.env.O8_API_PORT || process.env.PORT || '47120',
  WS_PORT: process.env.WS_PORT || '47125',
  O8_WS_PORT: process.env.O8_WS_PORT || process.env.WS_PORT || '47125',
};
// Next reads standalone production configuration before the checkout's config.
// A dev command must always resolve this checkout, including when launched from
// a packaged application or an older terminal server.
delete env.__NEXT_PRIVATE_STANDALONE_CONFIG;
delete env.O8_PACKAGED_APP;
delete env.NEXT_PHASE;

function readEntries() {
  try {
    const parsed = JSON.parse(readFileSync(pidFile, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeEntries(entries) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(pidFile, JSON.stringify(entries, null, 2));
}

function remember(pid, label) {
  const entries = readEntries().filter((entry) => entry.pid !== pid);
  entries.push({ pid, label, cwd: root, startedAt: Date.now() });
  writeEntries(entries);
}

function forget(pid) {
  const entries = readEntries().filter((entry) => entry.pid !== pid);
  if (entries.length) writeEntries(entries);
  else if (existsSync(pidFile)) rmSync(pidFile);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanup() {
  const entries = readEntries();
  const ours = entries.filter((entry) => entry && entry.cwd === root && Number.isInteger(entry.pid));
  const liveOurs = ours.filter((entry) => pidAlive(entry.pid));
  for (const entry of liveOurs) {
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch {}
  }
  if (liveOurs.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  for (const entry of liveOurs) {
    if (!pidAlive(entry.pid)) continue;
    try {
      process.kill(entry.pid, 'SIGKILL');
    } catch {}
  }
  const survivors = entries.filter((entry) => entry && entry.cwd !== root && pidAlive(entry.pid));
  if (survivors.length) writeEntries(survivors);
  else if (existsSync(pidFile)) rmSync(pidFile);
}

function waitForChildExit(child, timeoutMs = 2_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once('exit', finish);
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
}

function run(label, command, args) {
  // `next`/`tsx` come from node_modules/.bin, which is a POSIX symlink to the
  // package's JS entry here but a .cmd shim on Windows that bare spawn() cannot
  // exec. resolveSpawn() runs that JS entry under process.execPath instead, so
  // the PID we remember below stays the real child on every platform (#1744).
  const invocation = command === 'next'
    ? generatedOutputLaunch('dev', args.slice(1)) : null;
  const { file, args: spawnArgs, shell } = invocation
    ? { file: invocation.command, args: invocation.args, shell: false }
    : resolveSpawn(command, args);
  const child = spawn(file, spawnArgs, { cwd: root, env, stdio: 'inherit', shell });
  remember(child.pid, label);

  const forward = (signal) => {
    try {
      child.kill(signal);
    } catch {}
  };
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));
  child.on('exit', (code, signal) => {
    forget(child.pid);
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

async function all() {
  await cleanup();
  const next = spawn(process.execPath, ['scripts/dev.mjs', 'next'], { cwd: root, env, stdio: 'inherit' });
  const ws = spawn(process.execPath, ['scripts/dev.mjs', 'ws'], { cwd: root, env, stdio: 'inherit' });
  remember(next.pid, 'dev:next-wrapper');
  remember(ws.pid, 'dev:ws-wrapper');

  const signalChildren = (signal) => {
    for (const child of [next, ws]) {
      try {
        child.kill(signal);
      } catch {}
    }
  };

  // Ctrl-C used to exit here the moment a wrapper died, before either wrapper
  // had reaped its own `next dev` / `tsx ws-server` grandchild -- so 47120 and
  // 47125 stayed bound and the pid file kept entries for processes we never
  // waited on. Route every exit path through cleanup(), the same pass
  // `dev:cleanup` runs, so the ports are free and the pid file is accurate by
  // the time the shell comes back (#1678).
  let exiting = false;
  const shutdown = async (signal, code) => {
    if (exiting) return;
    exiting = true;
    const wrappersExited = Promise.all([next, ws].map((child) => waitForChildExit(child)));
    signalChildren(signal);
    await cleanup();
    await wrappersExited;
    // Wrapper exit handlers also update this cross-process ledger. Reconcile
    // once more after both writers have settled so dead grandchildren cannot
    // recreate a stale pid file after the first cleanup pass.
    await cleanup();
    process.exit(code ?? 0);
  };

  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

  for (const child of [next, ws]) {
    child.on('exit', (code, signal) => {
      forget(child.pid);
      // A signal exit reports a null code. Preserve that failure instead of
      // turning an unexpectedly killed wrapper into a successful dev command.
      void shutdown('SIGTERM', code ?? (signal ? 1 : 0));
    });
  }
}

function devListenHost(source) {
  return ['1', 'true', 'yes', 'on'].includes(String(source.O8_LAN_ACCESS ?? '').trim().toLowerCase())
    ? '0.0.0.0'
    : '127.0.0.1';
}

const mode = process.argv[2] || 'all';
if (mode === 'cleanup') await cleanup();
// Loopback unless O8_LAN_ACCESS opts in (mirrors src/lib/panel/listen-host.ts);
// `next dev` would otherwise listen on every interface.
else if (mode === 'next') run('dev:next', 'next', ['dev', '-p', env.PORT, '-H', devListenHost(env)]);
else if (mode === 'ws') {
  env.NODE_OPTIONS = withServerOnlyStubNodeOptions(env.NODE_OPTIONS);
  run('dev:ws', 'tsx', ['src/ws-server.ts']);
} else if (mode === 'all') await all();
else {
  console.error(`unknown dev mode: ${mode}`);
  process.exit(1);
}
