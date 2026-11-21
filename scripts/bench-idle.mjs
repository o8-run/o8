#!/usr/bin/env node
// Resting-cost bench for the Node WS server.
//
// Boots this checkout's WS server (front door on, Next off) against a
// copy-on-write clone of a data dir, with dispatch halted in the copy, lets it
// settle, then measures resting CPU %, RSS and the background-work ledger with
// no clients, and again with one offscreen o8-next window attached.
//
// On macOS the server runs under sandbox-exec: it cannot write outside the
// bench folder, reach the network beyond loopback, talk to the real tmux
// server or signal other processes, so loops that act on real repositories,
// agents or GitHub can stay on without touching anything real. Elsewhere it
// refuses unless --allow-unsandboxed is given.
//
// Usage: npm run bench:idle -- [--data ~/.o8] [--settle 120] [--seconds 60]
//          [--window /path/to/o8-next] [--window-settle 90] [--keep] [--allow-unsandboxed]
//
// The window is the app shell, offscreen, on the copy of the saved shell state
// (next-shell.json). An offscreen window is never in front, so it marks its
// reads `x-o8-foreground: 0`. Its startup reads and subscriptions still count
// as activity, so the measurement starts after --window-settle seconds, past
// the idle gate's 60 s window.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanBackgroundLoops } from './background-loops-scan.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const sourceData = resolve(option('data', join(homedir(), '.o8')).replace(/^~/, homedir()));
const settleSeconds = Number(option('settle', '120'));
const measureSeconds = Number(option('seconds', '60'));
const windowSettleSeconds = Number(option('window-settle', '90'));
const windowBinary = option('window', '');
const sandboxed = platform() === 'darwin';
if (!sandboxed && !flag('allow-unsandboxed')) {
  console.error('bench:idle runs the server sandboxed only on macOS. Pass --allow-unsandboxed to run it here anyway.');
  process.exit(2);
}

// Large or live-only entries the server does not need at rest.
const SKIP = new Set(['worktrees', 'package-manager-cache', 'workspace-preservation', 'backups', 'bin', 'compile-cache']);
const LIVE = /(\.sock|\.hold|\.pid|lock|^ws-port$|^api-port$)/;

function freePort() {
  return new Promise((done) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

function cloneTree(from, to) {
  if (platform() === 'darwin') execFileSync('cp', ['-c', '-R', from, to]);
  else execFileSync('cp', ['--reflink=auto', '-a', from, to]);
}

function cpuSeconds(pid) {
  const time = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  const parts = time.split(/[:.-]/).map(Number);
  // [[dd-]hh:]mm:ss.cc
  const [cs, s, m = 0, h = 0, d = 0] = parts.reverse();
  return d * 86400 + h * 3600 + m * 60 + s + cs / 100;
}

function rssMb(pid) {
  return Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function readLedger(dataDir) {
  try { return JSON.parse(readFileSync(join(dataDir, 'background-ledger.json'), 'utf8')); } catch { return null; }
}

function ledgerDelta(before, after, seconds) {
  const prior = new Map((before?.loops ?? []).map((loop) => [loop.name, loop]));
  return (after?.loops ?? []).map((loop) => {
    const was = prior.get(loop.name) ?? { runs: 0, mainMs: 0, children: 0, childWallMs: 0 };
    return {
      name: loop.name,
      runs: loop.runs - was.runs,
      mainMsPerMin: ((loop.mainMs - was.mainMs) / seconds) * 60,
      spawnsPerMin: ((loop.children - was.children) / seconds) * 60,
      childWallMsPerMin: ((loop.childWallMs - was.childWallMs) / seconds) * 60,
      changedRuns: loop.changedRuns,
      commands: loop.childCommands,
    };
  }).filter((loop) => loop.runs > 0 || loop.mainMsPerMin > 0)
    .sort((a, b) => (b.mainMsPerMin + b.childWallMsPerMin / 10) - (a.mainMsPerMin + a.childWallMsPerMin / 10));
}

async function measure(label, pid, dataDir) {
  const before = readLedger(dataDir);
  const cpu0 = cpuSeconds(pid);
  await sleep(measureSeconds * 1000);
  const cpu1 = cpuSeconds(pid);
  // The reporter writes every 15 s; wait for a snapshot that covers the window.
  await sleep(16_000);
  const after = readLedger(dataDir);
  const cpu = ((cpu1 - cpu0) / measureSeconds) * 100;
  console.log(`\n== ${label}: ${cpu.toFixed(1)}% of a core, ${rssMb(pid)} MB RSS (${measureSeconds} s)`);
  const rows = ledgerDelta(before, after, measureSeconds + 16);
  for (const row of rows.slice(0, 25)) {
    const commands = Object.entries(row.commands).map(([name, count]) => `${name}×${count}`).join(' ');
    console.log(`${row.mainMsPerMin.toFixed(0).padStart(7)} ms/min main  ${row.spawnsPerMin.toFixed(1).padStart(6)} spawns/min  ${String(row.runs).padStart(4)} runs  ${row.name}${commands ? `  [${commands}]` : ''}`);
  }
  if (rows.length === 0) console.log('  no registered loop ran');
  return { cpu, rows };
}

async function main() {
  const bench = mkdtempSync(join(tmpdir(), 'o8-bench-idle-'));
  const dataDir = join(bench, 'data');
  mkdirSync(dataDir);
  mkdirSync(join(bench, 'tmp'));
  console.log(`[bench:idle] cloning ${sourceData} into ${dataDir}`);
  for (const name of readdirSync(sourceData)) {
    if (SKIP.has(name) || LIVE.test(name)) continue;
    try { cloneTree(join(sourceData, name), join(dataDir, name)); } catch { /* unreadable entries are skipped */ }
  }
  // Halt dispatch in the copy only: no packet launches or recovers.
  execFileSync('sqlite3', [join(dataDir, 'cortex-ide.db'),
    `INSERT INTO app_state(key, value, updated_at) VALUES ('orchestrator_dispatch_halt', '{"halted":true,"reason":"bench:idle"}', ${Date.now()})
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`]);
  // Codex reads and writes its own home; give it a copy too.
  const codexHome = join(homedir(), '.codex');
  const benchCodex = join(bench, 'codex');
  // Sockets inside it cannot be copied; cp reports them and copies the rest.
  if (existsSync(codexHome)) try { cloneTree(codexHome, benchCodex); } catch { /* partial copy is enough */ }

  const [apiPort, wsPort, nextPort] = [await freePort(), await freePort(), await freePort()];
  const env = {
    ...process.env,
    NODE_ENV: 'production', O8_API_PORT: String(apiPort), PORT: String(apiPort),
    O8_WS_PORT: String(wsPort), WS_PORT: String(wsPort),
    O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir, CODEX_HOME: benchCodex, TMPDIR: join(bench, 'tmp'),
    O8_LAN_ACCESS: '0', O8_CONNECT_ATTACH: 'off', O8_RELAY_CONNECTOR: 'off', O8_WS_O8D: '0',
    O8_API_FRONT_DOOR: '1', O8_NEXT_OFF: '1', NEXT_ORIGIN: `http://127.0.0.1:${nextPort}/`,
    O8_BACKGROUND_LEDGER: '1', O8_BACKGROUND_LEDGER_INTERVAL_MS: '15000',
  };
  // The packaged app starts the server in its bundled server folder, which is
  // not a Git repository. Starting it in this checkout made the 5 s conflict
  // scan (repo: process.cwd()) probe every worktree of this repository, a cost
  // the app never pays. Run from a plain folder with absolute module paths.
  const node = [process.execPath, `--import=${join(root, 'scripts/register-server-only-stub.mjs')}`,
    '--import', join(root, 'node_modules/tsx/dist/loader.mjs'), join(root, 'src/ws-server.ts')];
  let command = node;
  if (sandboxed) {
    const profile = join(bench, 'server.sb');
    writeFileSync(profile, `(version 1)
(allow default)
(deny file-write* (subpath "${homedir()}"))
(allow file-write* (subpath "${bench}") (subpath "${resolve(tmpdir())}") (subpath "/private${resolve(tmpdir())}"))
(deny network-outbound (remote ip "*:*"))
(allow network-outbound (remote ip "localhost:*"))
(deny network-outbound (remote unix-socket (subpath "/private/tmp/tmux-${process.getuid()}")))
(deny signal (target others))
`);
    command = ['sandbox-exec', '-f', profile, ...node];
  }
  console.log(`[bench:idle] starting the WS server on ${apiPort}${sandboxed ? ' (sandboxed)' : ''}`);
  const serverCwd = join(bench, 'server-cwd');
  mkdirSync(serverCwd);
  const server = spawn(command[0], command.slice(1), {
    cwd: serverCwd, env: { ...env, TSX_TSCONFIG_PATH: join(root, 'tsconfig.json') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = join(bench, 'server.log');
  server.stdout.on('data', (chunk) => writeFileSync(log, chunk, { flag: 'a' }));
  server.stderr.on('data', (chunk) => writeFileSync(log, chunk, { flag: 'a' }));
  let window = null;
  const stop = () => {
    window?.kill();
    server.kill();
    if (!flag('keep')) rmSync(bench, { recursive: true, force: true });
  };
  process.on('SIGINT', () => { stop(); process.exit(130); });
  try {
    console.log(`[bench:idle] settling for ${settleSeconds} s`);
    await sleep(settleSeconds * 1000);
    if (server.exitCode !== null) throw new Error(`server exited; log at ${log}`);
    const quiet = await measure('no clients', server.pid, dataDir);
    let windowed = null;
    if (windowBinary) {
      window = spawn(windowBinary, ['--enable-next', '--app-shell', '--shell-state', join(dataDir, 'next-shell.json'),
        '--server', `http://127.0.0.1:${apiPort}`, '--offscreen'], {
        env: { ...process.env, O8_DATA_DIR: dataDir, O8_NEXT_API_TOKEN: readFileSync(join(dataDir, 'ws-token'), 'utf8').trim() },
        stdio: 'ignore',
      });
      await sleep(windowSettleSeconds * 1000);
      windowed = await measure('one offscreen window', server.pid, dataDir);
    }
    const scan = scanBackgroundLoops();
    console.log(`\nRegistered loops: ${scan.registered.length}; unregistered setInterval sites: ${scan.unregistered.length}`);
    if (flag('json')) console.log(JSON.stringify({ quiet, windowed, scan }, null, 2));
    if (flag('keep')) console.log(`[bench:idle] kept ${bench}`);
  } finally {
    stop();
  }
}

await main();
