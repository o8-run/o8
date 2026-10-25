import { execFile, execFileSync, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dashSessionNameForOwnerKey } from '@/lib/ws-server/dash-terminal-persistence';
import { DASH_PROFILE_OWNER_OPTION, dashProfileOwnerId } from '@/lib/terminal/dash-session-owner';
import {
  probeMetadataLockProcessIdentitySync,
  sameMetadataLockProcessIdentity,
  type MetadataLockProcessIdentity,
} from '@/lib/worktree/metadata-lock-process-identity';
import { renderTerminalBytes } from './helpers/headless-terminal';
import { tmuxIntegrationAvailable } from './helpers/tmux-prerequisite';

type WireFrame = {
  channel?: string;
  event?: string;
  data?: {
    data?: string;
    requestId?: string;
    sessionName?: string;
    exitCode?: number;
    exitCodeSource?: string;
  };
};

const ownerKey = 'workspace:terminal-restart-real-path';
const expectedSessionName = dashSessionNameForOwnerKey(ownerKey)!;
const beforeMarker = `O8_BEFORE_RESTART_${process.pid}`;
const afterMarker = `O8_AFTER_RESTART_${process.pid}`;
const dataDir = mkdtempSync(join(tmpdir(), 'o8-dash-terminal-restart-'));
const repoDir = join(dataDir, 'repository');
const identityPath = join(dataDir, 'interactive-program.json');
const token = 'dash-terminal-restart-token';
const dashboardServerName = `o8-dashboard-restart-test-${process.pid}`;
const tmuxArgs = (...args: string[]) => ['-L', dashboardServerName, ...args];
const sockets = new Set<WebSocket>();
let apiServer: Server;
let apiPort = 0;
let wsPort = 0;
let wsProcess: ChildProcess | null = null;
let wsClosed: Promise<void> = Promise.resolve();
let serverOutput = '';

const tmuxAvailable = tmuxIntegrationAvailable();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing test port'));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}. ${serverOutput.slice(-4_000)}`);
}

async function startWsServer(overrides: Partial<NodeJS.ProcessEnv> = {}) {
  serverOutput = '';
  wsProcess = execFile(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs',
    '--import=tsx',
    'src/ws-server.ts',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: dataDir,
      USERPROFILE: dataDir,
      ZDOTDIR: dataDir,
      // Keep system login-shell logout hooks from recreating the removed fixture.
      SHELL_SESSIONS_DISABLE: '1',
      XDG_CONFIG_HOME: join(dataDir, '.config'),
      XDG_STATE_HOME: join(dataDir, '.local', 'state'),
      XDG_CACHE_HOME: join(dataDir, '.cache'),
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_DATA_DIR: dataDir,
      CORTEX_IDE_REVIEW_REPO_ROOT: repoDir,
      O8_API_PORT: String(apiPort),
      O8_WS_PORT: String(wsPort),
      O8_PERSISTENT_TERMINALS: '1',
      O8_DASH_TMUX_SERVER_NAME: dashboardServerName,
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`,
      TMUX: '',
      ...overrides,
    },
  });
  const child = wsProcess;
  wsClosed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  wsProcess.stdout?.on('data', (chunk) => { serverOutput += String(chunk); });
  wsProcess.stderr?.on('data', (chunk) => { serverOutput += String(chunk); });
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${wsPort}/health`)).ok;
    } catch {
      return false;
    }
  }, 'ws server health', 60_000);
}

async function stopWsServer() {
  const processToStop = wsProcess;
  wsProcess = null;
  if (!processToStop) return;
  if (processToStop.exitCode === null && processToStop.signalCode === null) processToStop.kill('SIGTERM');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      wsClosed,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('ws server did not close')), 10_000); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function captureFixtureProcesses(): Map<number, MetadataLockProcessIdentity> {
  const identities = new Map<number, MetadataLockProcessIdentity>();
  if (!tmuxAvailable) return identities;
  const panes = spawnSync('tmux', tmuxArgs('list-panes', '-a', '-F', '#{pid} #{pane_pid}'), { encoding: 'utf8' });
  if (panes.error) throw panes.error;
  if (panes.status !== 0 && !/no server running|error connecting.*No such file/i.test(panes.stderr)) {
    throw new Error(`Cannot inspect fixture tmux processes: ${panes.stderr}`);
  }
  const pids = new Set((panes.stdout ?? '').trim().split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0));
  if (existsSync(identityPath)) pids.add((JSON.parse(readFileSync(identityPath, 'utf8')) as { pid: number }).pid);
  for (const pid of pids) {
    const probe = probeMetadataLockProcessIdentitySync(pid);
    if (probe.state === 'unknown') throw new Error(`Cannot identify fixture process ${pid}: ${probe.detail}`);
    if (probe.state === 'live') identities.set(pid, probe.identity);
  }
  return identities;
}

async function connectClient() {
  const frames: WireFrame[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
  sockets.add(socket);
  socket.on('message', (raw) => frames.push(JSON.parse(String(raw)) as WireFrame));
  socket.on('close', () => sockets.delete(socket));
  await once(socket, 'open');
  await waitFor(
    () => frames.some((frame) => frame.channel === 'system' && frame.event === 'connected'),
    'authenticated WebSocket connection',
  );
  return { socket, frames };
}

function terminalText(frames: WireFrame[], sessionName: string) {
  return frames
    .filter((frame) => frame.channel === 'terminal' && frame.event === 'data' && frame.data?.sessionName === sessionName)
    .map((frame) => Buffer.from(frame.data?.data ?? '', 'base64').toString('utf8'))
    .join('');
}

function capturePane() {
  return execFileSync('tmux', tmuxArgs('capture-pane', '-p', '-S', '-', '-t', expectedSessionName), {
    encoding: 'utf8',
  });
}

beforeAll(async () => {
  if (!tmuxAvailable) return;
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(repoDir);
  const gitEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'test', PATH: process.env.PATH, HOME: dataDir, TMPDIR: dataDir,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  };
  execFileSync('git', ['init', '--template=', '-q', repoDir], { env: gitEnv });
  execFileSync('git', ['-C', repoDir, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Fixture'], { env: gitEnv });
  writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, { mode: 0o600 });
  apiPort = await freePort();
  wsPort = await freePort();
  apiServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${apiPort}`);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/api/command-center/snapshot') {
      response.end(JSON.stringify({
        fleet: { agents: [], meta: { mode: 'live' } },
        review: null,
        reviewError: null,
        browserInventory: { browsers: [], generatedAt: new Date().toISOString() },
        attachedBrowser: null,
        browserError: null,
      }));
      return;
    }
    response.end('{}');
  });
  apiServer.listen(apiPort, '127.0.0.1');
  await once(apiServer, 'listening');
  await startWsServer();
}, 70_000);

afterAll(async () => {
  const fixtureProcesses = captureFixtureProcesses();
  for (const socket of sockets) socket.close();
  await stopWsServer();
  if (apiServer?.listening) await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  try {
    execFileSync('tmux', tmuxArgs('kill-server'), { stdio: 'ignore' });
  } catch { /* the assertion may fail before the backing session is created */ }
  try {
    await waitFor(() => [...fixtureProcesses].every(([pid, identity]) => {
      const probe = probeMetadataLockProcessIdentitySync(pid);
      return probe.state === 'absent'
        || (probe.state === 'live' && !sameMetadataLockProcessIdentity(identity, probe.identity));
    }), 'fixture tmux server, login shell, and interactive program exit');
  } catch (error) {
    throw new Error(`Preserved fixture ${dataDir}; processes=${[...fixtureProcesses.keys()]}; entries=${readdirSync(dataDir).join(', ')}. ${String(error)}`);
  }
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, 45_000);

describe.runIf(tmuxAvailable)('dashboard terminal restart through the real WebSocket path', () => {
  it('refuses cleanup of another persisted profile on the shared server', async () => {
    const foreignProfile = join(dataDir, 'foreign-profile');
    mkdirSync(foreignProfile);
    const foreignSession = 'cortex-dash-foreign-cleanup';
    execFileSync('tmux', tmuxArgs('new-session', '-d', '-s', foreignSession, '/bin/sh'));
    execFileSync('tmux', tmuxArgs('set-option', '-t', `=${foreignSession}:`, DASH_PROFILE_OWNER_OPTION, dashProfileOwnerId(foreignProfile)));
    const ownedSession = 'cortex-dash-owned-cleanup';
    execFileSync('tmux', tmuxArgs('new-session', '-d', '-s', ownedSession, '/bin/sh'));
    execFileSync('tmux', tmuxArgs('set-option', '-t', `=${ownedSession}:`, DASH_PROFILE_OWNER_OPTION, dashProfileOwnerId(dataDir)));
    writeFileSync(join(foreignProfile, 'terminal-state.json'), JSON.stringify({ tabs: [{ tmuxSession: foreignSession }] }));
    writeFileSync(join(dataDir, 'terminal-state.json'), JSON.stringify({ tabs: [{ tmuxSession: ownedSession }] }));
    const identity = () => execFileSync('tmux', tmuxArgs('display-message', '-p', '-t', `=${foreignSession}:`, '#{pid}:#{session_id}:#{pane_pid}'), { encoding: 'utf8' });
    const before = identity();
    const response = await fetch(`http://127.0.0.1:${wsPort}/terminal-signal`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionName: foreignSession, signal: 'SIGTERM' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'terminal_profile_mismatch' });
    expect(identity()).toBe(before);
    expect(JSON.parse(readFileSync(join(foreignProfile, 'terminal-state.json'), 'utf8')).tabs)
      .toEqual([{ tmuxSession: foreignSession }]);
    const signal = (sessionName: string, value: string) => fetch(`http://127.0.0.1:${wsPort}/terminal-signal`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionName, signal: value }),
    });
    expect((await signal('cortex-dash-foreign', 'SIGTERM')).status).toBe(403);
    expect((await signal(ownedSession, 'SIGINT')).status).toBe(200);
    expect(() => execFileSync('tmux', tmuxArgs('has-session', '-t', `=${ownedSession}`))).not.toThrow();
    expect((await signal(ownedSession, 'SIGTERM')).status).toBe(200);
    expect(spawnSync('tmux', tmuxArgs('has-session', '-t', `=${ownedSession}`)).status).toBe(1);
    expect(identity()).toBe(before);
  });

  describe('selector ownership with an inherited tmux server', () => {
    const foreignProfile = join(dataDir, 'selector-foreign-profile');
    const anchor = 'cortex-dash-selector-anchor';
    function create(name: string, profile: string) {
      execFileSync('tmux', tmuxArgs('new-session', '-d', '-s', name, '/bin/sh'));
      execFileSync('tmux', tmuxArgs('set-option', '-t', `=${name}:`, DASH_PROFILE_OWNER_OPTION, dashProfileOwnerId(profile)));
      writeFileSync(join(profile, 'terminal-state.json'), JSON.stringify({ tabs: [{ tmuxSession: name }] }));
    }
    const identity = (name: string) => execFileSync('tmux', tmuxArgs('display-message', '-p', '-t', `=${name}:`,
      '#{pid}:#{session_id}:#{pane_pid}'), { encoding: 'utf8' }).trim();
    const signal = (sessionName: string, value: string) => fetch(`http://127.0.0.1:${wsPort}/terminal-signal`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionName, signal: value }),
    });
    beforeAll(async () => {
      mkdirSync(foreignProfile);
      create(anchor, dataDir);
      const inherited = execFileSync('tmux', tmuxArgs('display-message', '-p', '-t', `=${anchor}:`,
        '#{socket_path},#{pid},0'), { encoding: 'utf8' }).trim();
      await stopWsServer();
      await startWsServer({ TMUX: inherited });
    });
    afterAll(async () => {
      await stopWsServer();
      await startWsServer();
    });

    it.each(['name', '=name', '$id', 'session:window', 'name prefix'])('fences the %s selector by its resolved session owner', async (kind) => {
      const suffix = kind === '=name' ? 'exact' : kind.replace(/\W/gu, '');
      const owned = `cortex-dash-selector-owned-${suffix}`;
      const foreign = `cortex-dash-selector-foreign-${suffix}`;
      create(owned, dataDir);
      create(foreign, foreignProfile);
      if (kind === '$id') execFileSync('tmux', tmuxArgs('split-window', '-d', '-t', `=${owned}:`, '/bin/sh'));
      const foreignBefore = identity(foreign);
      const ownedBefore = identity(owned);
      const selector = (name: string, resolved: string) => kind === '=name' ? `=${name}`
        : kind === '$id' ? resolved.split(':')[1]
          : kind === 'session:window' ? `${name}:0`
            : kind === 'name prefix' ? name.slice(0, -2) : name;
      const refused = await signal(selector(foreign, foreignBefore), 'SIGTERM');
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: 'terminal_profile_mismatch' });
      expect(identity(foreign)).toBe(foreignBefore);
      expect((await signal(selector(owned, ownedBefore), 'SIGINT')).status).toBe(200);
      expect(identity(owned)).toBe(ownedBefore);
      expect((await signal(selector(owned, ownedBefore), 'SIGTERM')).status).toBe(200);
      expect(spawnSync('tmux', tmuxArgs('has-session', '-t', `=${owned}`)).status).toBe(1);
      expect(identity(foreign)).toBe(foreignBefore);
      expect(JSON.parse(readFileSync(join(foreignProfile, 'terminal-state.json'), 'utf8')).tabs)
        .toEqual([{ tmuxSession: foreign }]);
    });

    it('refuses ambiguous and unresolved selectors without acting on either profile', async () => {
      const owned = 'cortex-dash-selector-ambiguous-owned';
      const foreign = 'cortex-dash-selector-ambiguous-foreign';
      create(owned, dataDir);
      create(foreign, foreignProfile);
      const legacy = 'cortex-dash-selector-untagged';
      execFileSync('tmux', tmuxArgs('new-session', '-d', '-s', legacy, '/bin/sh'));
      const before = [identity(owned), identity(foreign), identity(legacy)];
      for (const selector of ['cortex-dash-selector-ambiguous-', '=absent-session', '$99999999', ':99999999',
        legacy, `=${legacy}`, before[2].split(':')[1], `${legacy}:0`, legacy.slice(0, -2), `${owned};`]) {
        expect((await signal(selector, 'SIGTERM')).status).toBe(403);
        expect([identity(owned), identity(foreign), identity(legacy)]).toEqual(before);
      }
    });

    it('signals a direct process only by its literal bridge identity', async () => {
      const client = await connectClient();
      const requestId = 'selector-direct-process';
      client.socket.send(JSON.stringify({ type: 'terminal-create', requestId, directPty: true, cols: 80, rows: 24, cwd: repoDir }));
      await waitFor(() => client.frames.some((frame) => frame.event === 'created' && frame.data?.requestId === requestId), 'direct process creation');
      const sessionName = client.frames.find((frame) => frame.event === 'created' && frame.data?.requestId === requestId)!.data!.sessionName!;
      client.socket.send(JSON.stringify({ type: 'terminal-attach', sessionName, cols: 80, rows: 24 }));
      await waitFor(() => client.frames.some((frame) => frame.event === 'attached' && frame.data?.sessionName === sessionName), 'direct process attachment');
      expect((await signal(`=${sessionName}`, 'SIGTERM')).status).toBe(403);
      expect((await signal(sessionName, 'SIGINT')).status).toBe(200);
      const marker = 'O8_DIRECT_PROCESS_STILL_RUNNING';
      client.socket.send(JSON.stringify({ type: 'terminal-input', sessionName, data: `printf '${marker}\\n'\n` }));
      await waitFor(() => terminalText(client.frames, sessionName).includes(marker), 'direct process remains responsive');
      expect((await signal(sessionName, 'SIGTERM')).status).toBe(200);
      await waitFor(() => client.frames.some((frame) => frame.event === 'exited' && frame.data?.sessionName === sessionName), 'direct process termination');
      client.socket.close();
    });
  });

  it.each([{ directPty: true, code: 0 }, { directPty: true, code: 7 }, { directPty: false, code: 7 }])('reports exit provenance for a real shell: %j', async ({ directPty, code }) => {
    const client = await connectClient();
    const requestId = `exit-${directPty}-${code}`;
    client.socket.send(JSON.stringify({ type: 'terminal-create', cols: 100, rows: 25, requestId, directPty, cwd: repoDir }));
    await waitFor(() => client.frames.some((frame) => frame.event === 'created' && frame.data?.requestId === requestId), 'exit fixture creation');
    const sessionName = client.frames.find((frame) => frame.event === 'created' && frame.data?.requestId === requestId)!.data!.sessionName!;
    client.socket.send(JSON.stringify({ type: 'terminal-attach', sessionName, cols: 100, rows: 25 }));
    await waitFor(() => client.frames.some((frame) => frame.event === 'attached' && frame.data?.sessionName === sessionName), 'exit fixture attachment');
    client.socket.send(JSON.stringify({ type: 'terminal-input', sessionName, data: `printf 'O8_EXIT_MARKER_${code}\\n'; exit ${code}\n` }));
    await waitFor(() => client.frames.some((frame) => frame.event === 'exited' && frame.data?.sessionName === sessionName), 'real shell exit');
    const exit = client.frames.find((frame) => frame.event === 'exited' && frame.data?.sessionName === sessionName)!.data!;
    expect(exit.exitCodeSource).toBe(directPty ? 'process' : 'transport');
    if (directPty) expect(exit.exitCode).toBe(code);
    expect(terminalText(client.frames, sessionName)).toContain(`O8_EXIT_MARKER_${code}`);
    client.socket.close();
  }, 35_000);

  it('reclaims one owned tmux session with scrollback and the same running interactive program after server loss', async () => {
    const first = await connectClient();
    first.socket.send(JSON.stringify({
      type: 'terminal-create',
      cols: 120,
      rows: 30,
      requestId: 'first-create',
      ownerKey,
      cwd: repoDir,
    }));
    await waitFor(
      () => first.frames.some((frame) => frame.channel === 'terminal'
        && frame.event === 'created'
        && frame.data?.requestId === 'first-create'),
      'first terminal creation',
    );
    const firstCreated = first.frames.find((frame) => frame.data?.requestId === 'first-create');
    expect(firstCreated?.data?.sessionName).toBe(expectedSessionName);

    first.socket.send(JSON.stringify({
      type: 'terminal-attach',
      sessionName: expectedSessionName,
      cols: 120,
      rows: 30,
    }));
    await waitFor(
      () => first.frames.some((frame) => frame.channel === 'terminal'
        && frame.event === 'attached'
        && frame.data?.sessionName === expectedSessionName),
      'first terminal attachment',
    );
    first.socket.send(JSON.stringify({
      type: 'terminal-input',
      sessionName: expectedSessionName,
      data: `printf '${beforeMarker}\\n'\n`,
    }));
    await waitFor(() => capturePane().includes(beforeMarker), 'pre-restart terminal output');

    const heartbeatPath = join(dataDir, 'interactive-program-heartbeat');
    const programPath = join(dataDir, 'interactive-program.cjs');
    const nonce = `restart-${process.pid}-${Date.now()}`;
    writeFileSync(programPath, `
      const fs = require('node:fs');
      const readline = require('node:readline');
      const nonce = ${JSON.stringify(nonce)};
      fs.writeFileSync(${JSON.stringify(identityPath)}, JSON.stringify({ pid: process.pid, nonce }));
      const timer = setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeatPath)}, String(Date.now())), 100);
      console.log('O8_PROGRAM_READY_' + nonce + '_' + process.pid);
      readline.createInterface({ input: process.stdin }).on('line', line => {
        if (line === 'probe') console.log('O8_PROGRAM_REPLY_' + nonce + '_' + process.pid);
        if (line === 'quit') { clearInterval(timer); process.exit(0); }
      });
    `);
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    first.socket.send(JSON.stringify({
      type: 'terminal-input', sessionName: expectedSessionName,
      data: `${shellQuote(process.execPath)} ${shellQuote(programPath)}\n`,
    }));
    await waitFor(() => existsSync(identityPath) && existsSync(heartbeatPath), 'interactive program startup');
    const program = JSON.parse(readFileSync(identityPath, 'utf8')) as { pid: number; nonce: string };
    expect(program.nonce).toBe(nonce);
    const readyMarker = `O8_PROGRAM_READY_${nonce}_${program.pid}`;
    await waitFor(() => capturePane().includes(readyMarker), 'interactive program ready output');

    first.socket.close();
    await once(first.socket, 'close');
    await stopWsServer();
    expect(capturePane()).toContain(beforeMarker);
    const stoppedAt = Date.now();
    await waitFor(() => Number(readFileSync(heartbeatPath, 'utf8')) > stoppedAt, 'program keeps running with the server stopped');
    expect(() => process.kill(program.pid, 0)).not.toThrow();

    await startWsServer();
    const second = await connectClient();
    second.socket.send(JSON.stringify({
      type: 'terminal-create',
      cols: 120,
      rows: 30,
      requestId: 'second-create',
      ownerKey,
      cwd: repoDir,
    }));
    await waitFor(
      () => second.frames.some((frame) => frame.channel === 'terminal'
        && frame.event === 'created'
        && frame.data?.requestId === 'second-create'),
      'owned terminal reclamation',
    );
    const secondCreated = second.frames.find((frame) => frame.data?.requestId === 'second-create');
    expect(secondCreated?.data?.sessionName).toBe(expectedSessionName);
    await waitFor(
      () => second.frames.some((frame) => frame.channel === 'terminal'
        && frame.event === 'attached'
        && frame.data?.sessionName === expectedSessionName),
      'restarted terminal attachment',
    );
    await waitFor(
      () => terminalText(second.frames, expectedSessionName).includes(beforeMarker),
      'restored terminal scrollback',
    );
    const restoredLines = await renderTerminalBytes([terminalText(second.frames, expectedSessionName)], { cols: 120, rows: 30, scrollback: 50_000 });
    expect(restoredLines.join('\n')).toContain(beforeMarker);
    expect(restoredLines.join('\n')).toContain(readyMarker);
    expect(JSON.parse(readFileSync(identityPath, 'utf8'))).toEqual(program);
    second.socket.send(JSON.stringify({
      type: 'terminal-input', sessionName: expectedSessionName, data: 'probe\n',
    }));
    await waitFor(
      () => terminalText(second.frames, expectedSessionName).includes(`O8_PROGRAM_REPLY_${nonce}_${program.pid}`),
      'the original interactive program answers after reconnect',
    );
    second.socket.send(JSON.stringify({
      type: 'terminal-input', sessionName: expectedSessionName, data: 'quit\n',
    }));
    await waitFor(() => {
      try { process.kill(program.pid, 0); return false; } catch { return true; }
    }, 'fixture program exits before returning to the shell');

    second.socket.send(JSON.stringify({
      type: 'terminal-input',
      sessionName: expectedSessionName,
      data: `printf '${afterMarker}\\n'\n`,
    }));
    await waitFor(() => capturePane().includes(afterMarker), 'post-restart terminal output');
    expect(capturePane()).toContain(beforeMarker);
    const matchingSessions = execFileSync('tmux', tmuxArgs('list-sessions', '-F', '#{session_name}'), { encoding: 'utf8' })
      .split('\n')
      .filter((name) => name === expectedSessionName);
    expect(matchingSessions).toEqual([expectedSessionName]);
  }, 100_000);
});
