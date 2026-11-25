import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BENCH_TMUX_SERVER_NAME, benchTmuxArgs } from '../tmux-scope.mjs';
import {
  descendantPids,
  measureProcessPhysicalBytes,
  snapshotProcesses,
} from '../../lib/footprint-budget.mjs';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function reservedPorts(root) {
  const source = fs.readFileSync(path.join(root, 'src/lib/panel/port-constants.ts'), 'utf8');
  return new Set(Array.from(source.matchAll(/\b(\d{5})\b/g), (match) => Number(match[1])));
}

async function freePort(root) {
  const reserved = reservedPorts(root);
  while (true) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const selected = typeof address === 'object' && address ? address.port : 0;
        server.close(() => resolve(selected));
      });
    });
    if (port > 0 && !reserved.has(port)) return port;
  }
}

export function sessionNameForTabId(tabId) {
  const digest = createHash('sha256').update(`workspace:${tabId}`).digest('hex').slice(0, 32);
  return `cortex-dash-${digest}`;
}

function repoEntry(repoDir, now) {
  return {
    id: 'terminal-workload-fixture',
    name: 'terminal-workload-fixture',
    localPath: repoDir,
    remoteUrl: null,
    defaultBranch: 'main',
    isGitRepo: true,
    addedAt: now,
    lastOpenedAt: now,
    storagePressureParkingDisabled: false,
    setup: {
      envMode: 'copy',
      envFiles: ['.env', '.env.local'],
      installCommand: null,
      installOnCreateWorkspace: false,
      buildCommand: null,
      runBuildOnCreateWorkspace: false,
      devCommand: null,
      defaultPort: null,
      workspaceIsolationPreference: 'auto',
    },
  };
}

export function seedFixtureState(sessionCount, runPrefix) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `o8-terminal-workload-${runPrefix}-`));
  const repoDir = path.join(dataDir, 'fixture-repo');
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(repoDir, 'fixture.txt'), 'terminal workload fixture\n');
  execFileSync('git', ['add', 'fixture.txt'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=o8 fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'fixture'], { cwd: repoDir, stdio: 'ignore' });
  const now = new Date().toISOString();
  const tabs = Array.from({ length: sessionCount }, (_, index) => {
    const id = `term-${runPrefix}-${index + 1}`;
    return {
      id,
      label: `Terminal ${index + 1}`,
      kind: 'terminal',
      cliAgent: 'shell',
      repoName: 'terminal-workload-fixture',
      repoPath: repoDir,
      sessionName: sessionNameForTabId(id),
    };
  });
  fs.mkdirSync(path.join(dataDir, 'terminal-states'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'setup.json'), JSON.stringify({ setupComplete: true, skippedSteps: [] }));
  fs.writeFileSync(path.join(dataDir, 'settings.toml'), [
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({ version: 1, repos: [repoEntry(repoDir, now)] }));
  fs.writeFileSync(path.join(dataDir, 'terminal-states', 'tile-root.json'), JSON.stringify({
    version: 1,
    activeTabId: tabs[0].id,
    tabs: tabs.map((tab) => ({
      id: tab.id,
      label: tab.label,
      kind: tab.kind,
      cliAgent: tab.cliAgent,
      repoName: tab.repoName,
      repoPath: tab.repoPath,
    })),
    savedAt: now,
  }));
  return { dataDir, repoDir, tabs };
}

function processLog(child) {
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-500000); });
  }
  return () => output;
}

async function waitForUrl(url, child, log, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${url} server exited ${child.exitCode}\n${log()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch { /* booting */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${url}\n${log()}`);
}

function signalProcessGroup(child, signal) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(-child.pid, signal); } catch { /* already stopped */ }
}

async function stopProcessGroup(child) {
  signalProcessGroup(child, 'SIGTERM');
  const deadline = Date.now() + 2500;
  while (child?.exitCode === null && Date.now() < deadline) await sleep(50);
  signalProcessGroup(child, 'SIGKILL');
}

export function cleanupTmuxSessions(sessionNames) {
  const cleaned = [];
  for (const sessionName of new Set(sessionNames)) {
    if (!/^cortex-dash-[a-f0-9]{32}$/.test(sessionName)) continue;
    try {
      execFileSync('tmux', benchTmuxArgs('kill-session', '-t', `=${sessionName}`), { stdio: 'ignore' });
      cleaned.push(sessionName);
    } catch { /* absent */ }
  }
  return cleaned;
}

export async function startIsolatedStack(root, seeded, requestedBuildMode = 'auto', { runTag = null, cpuProfile = false } = {}) {
  const apiPort = await freePort(root);
  let wsPort = await freePort(root);
  while (wsPort === apiPort) wsPort = await freePort(root);
  const productionAvailable = fs.existsSync(path.join(root, '.next', 'BUILD_ID'));
  const buildMode = requestedBuildMode === 'next-dev' || !productionAvailable ? 'next-dev' : 'production';
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(seeded.dataDir, 'ws-token'), token, { mode: 0o600 });
  const env = {
    ...process.env,
    NODE_ENV: buildMode === 'production' ? 'production' : 'development',
    PORT: String(apiPort),
    O8_API_PORT: String(apiPort),
    WS_PORT: String(wsPort),
    O8_WS_PORT: String(wsPort),
    O8_DATA_DIR: seeded.dataDir,
    CORTEX_IDE_DATA_DIR: seeded.dataDir,
    CORTEX_IDE_REPO_ROOT: seeded.repoDir,
    CORTEX_IDE_REVIEW_REPO_ROOT: seeded.repoDir,
    WS_TOKEN: token,
    O8_TERMINAL_BENCH: '1',
    O8_PERSISTENT_TERMINALS: '1',
    O8_DASH_TMUX_SERVER_NAME: BENCH_TMUX_SERVER_NAME,
    O8_INTERACTION_RUN_TAG: runTag ?? '',
  };
  delete env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete env.CLERK_PUBLISHABLE_KEY;

  const nextArgs = buildMode === 'production' ? ['scripts/start.mjs'] : ['scripts/dev.mjs', 'next'];
  const next = spawn(process.execPath, nextArgs, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stubUrl = pathToFileURL(path.join(root, 'scripts/register-server-only-stub.mjs')).href;
  const wsArgs = cpuProfile
    ? ['--inspect=127.0.0.1:0', '--import', 'tsx', 'src/ws-server.ts']
    : [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'src/ws-server.ts'];
  const ws = spawn(process.execPath, wsArgs, {
    cwd: root,
    env: { ...env, NODE_OPTIONS: [env.NODE_OPTIONS, `--import=${stubUrl}`].filter(Boolean).join(' ') },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const nextLog = processLog(next);
  const wsLog = processLog(ws);
  try {
    await Promise.all([
      waitForUrl(`http://127.0.0.1:${apiPort}/api/panel/status`, next, nextLog),
      waitForUrl(`http://127.0.0.1:${wsPort}/health`, ws, wsLog),
    ]);
  } catch (error) {
    await Promise.all([stopProcessGroup(next), stopProcessGroup(ws)]);
    throw error;
  }
  return {
    apiPort,
    wsPort,
    token,
    buildMode,
    devModeCpuWarning: buildMode === 'next-dev',
    nextPid: next.pid,
    wsPid: ws.pid,
    reviewRootIsolated: wsLog().includes(`[ws-server] Watching git at ${path.join(seeded.repoDir, '.git')} for diff changes`),
    logs: { next: nextLog, ws: wsLog },
    close: async () => {
      await Promise.all([stopProcessGroup(next), stopProcessGroup(ws)]);
      fs.rmSync(seeded.dataDir, { recursive: true, force: true });
    },
  };
}

function processGroup(processes, rootPid) {
  return [...descendantPids(processes, rootPid)].filter((pid) => processes.has(pid));
}

export function resolveProcessGroups(processes, stack, browserPid) {
  const browserTree = processGroup(processes, browserPid);
  return {
    applicationServer: processGroup(processes, stack.nextPid),
    realtimeServer: processGroup(processes, stack.wsPid),
    chromiumRenderer: browserTree.filter((pid) => processes.get(pid)?.command.includes('--type=renderer')),
  };
}

function processLabel(command) {
  if (command.includes('--type=renderer')) return 'chromium-renderer';
  if (command.includes('ws-server.ts')) return 'ws-server';
  if (command.includes('next-server')) return 'next-server';
  if (command.includes('next/dist/bin/next')) return 'next-launcher';
  if (command.includes('terminal-workload/generator.mjs')) return 'terminal-generator';
  if (command.includes('terminal-workload/rapid-generator.mjs')) return 'rapid-terminal-generator';
  return 'child-process';
}

function sameProcess(left, right) {
  return left?.pid === right?.pid
    && left?.ppid === right?.ppid
    && left?.command === right?.command;
}

export function describeProcessPidTree(processes, groups) {
  return Object.fromEntries(Object.entries(groups).map(([name, pids]) => [
    name,
    pids.flatMap((pid) => {
      const entry = processes.get(pid);
      return entry ? [{ pid, ppid: entry.ppid, process: processLabel(entry.command) }] : [];
    }),
  ]));
}

export function measureProcessGroupMemory(processes, groups) {
  const unavailableByGroup = {};
  const physicalBytes = Object.fromEntries(Object.entries(groups).map(([name, pids]) => {
    let physicalBytes = 0;
    const unavailable = [];
    for (const pid of pids) {
      const expected = processes.get(pid);
      const beforeProbe = snapshotProcesses().get(pid);
      if (!sameProcess(expected, beforeProbe)) {
        // A short-lived descendant that exited after the process-table sample
        // contributes no live footprint at probe time. It must not make the
        // stable launcher + serving-process aggregate unavailable.
        continue;
      }
      try {
        const measuredBytes = measureProcessPhysicalBytes(pid);
        const afterProbe = snapshotProcesses().get(pid);
        if (!sameProcess(beforeProbe, afterProbe)) {
          // Do not attribute a footprint to a PID whose identity changed
          // during measurement, and do not invalidate the stable remainder.
          continue;
        }
        physicalBytes += measuredBytes;
      } catch (error) {
        let stillRunning = true;
        try { process.kill(pid, 0); } catch { stillRunning = false; }
        if (stillRunning) unavailable.push({
          pid,
          process: processLabel(expected?.command ?? ''),
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    unavailableByGroup[name] = unavailable;
    return [name, unavailable.length === 0 ? physicalBytes : null];
  }));
  Object.defineProperty(physicalBytes, 'unavailable', { value: unavailableByGroup });
  return physicalBytes;
}

export function snapshotProcessCounters(takeSnapshot = snapshotProcesses, clock = () => performance.now()) {
  const startedAtMs = clock();
  const processes = takeSnapshot();
  return { processes, sampledAtMs: (startedAtMs + clock()) / 2 };
}

export function measureProcessGroups(
  before,
  after,
  groups,
  observationMs,
  physicalBytesStart = {},
  physicalBytesEnd = {},
) {
  const seconds = observationMs / 1000;
  return Object.fromEntries(Object.entries(groups).map(([name, pids]) => {
    let cpuSeconds = 0;
    for (const pid of pids) {
      const beforeProcess = before.get(pid);
      const afterProcess = after.get(pid);
      if (beforeProcess && afterProcess) {
        cpuSeconds += Math.max(0, afterProcess.cpuTimeSeconds - beforeProcess.cpuTimeSeconds);
      }
    }
    const physicalBytes = physicalBytesEnd[name] ?? null;
    return [name, {
      processCount: pids.filter((pid) => after.has(pid)).length,
      cpuPercent: seconds > 0 ? Number(((cpuSeconds / seconds) * 100).toFixed(2)) : null,
      physicalBytes,
      physicalBytesStart: physicalBytesStart[name] ?? null,
      physicalBytesGrowth: physicalBytes != null && physicalBytesStart[name] != null
        ? physicalBytes - physicalBytesStart[name]
        : null,
      physicalUnavailable: [
        ...(physicalBytesStart.unavailable?.[name] ?? []).map((entry) => ({ phase: 'start', ...entry })),
        ...(physicalBytesEnd.unavailable?.[name] ?? []).map((entry) => ({ phase: 'end', ...entry })),
      ],
    }];
  }));
}
