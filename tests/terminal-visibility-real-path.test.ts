import { execFile, execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dashSessionNameForOwnerKey, dashTmuxArgs } from '@/lib/ws-server/dash-terminal-persistence';
import { renderTerminalBytes } from './helpers/headless-terminal';
import { cliBundleAlias } from '../cli/bundle-alias.mjs';

type WireFrame = {
  channel?: string;
  event?: string;
  data?: {
    code?: string;
    cols?: number;
    data?: string;
    epoch?: number;
    historyTruncated?: boolean;
    lastGoodOffset?: number;
    reason?: string;
    requestId?: string;
    rows?: number;
    sessionName?: string;
    source?: string;
    waitedMs?: number;
  };
};

type ReceivedFrame = { frame: WireFrame; at: number };

const ownerKey = `workspace:terminal-visibility-real-path-${process.pid}`;
const sessionName = dashSessionNameForOwnerKey(ownerKey)!;
const duplicateOwnerKey = `workspace:terminal-visibility-duplicate-${process.pid}`;
const duplicateSessionName = dashSessionNameForOwnerKey(duplicateOwnerKey)!;
const cliSessionName = dashSessionNameForOwnerKey(`workspace:terminal-cli-${process.pid}`)!;
const controlSessionName = dashSessionNameForOwnerKey(`workspace:terminal-control-${process.pid}`)!;
const observerSessionName = `cortex-observer-${process.pid}`;
const plainSessionName = `cortex-plain-visibility-${process.pid}`;
const OVERFLOW_TERMINAL = { cols: 120, rows: 30 } as const;
const DUPLICATE_TERMINAL = { cols: 120, rows: 40 } as const;
const dataDir = mkdtempSync(join(tmpdir(), 'o8-terminal-visibility-'));
const token = `terminal-visibility-${process.pid}`;
const cliBundle = join(dataDir, 'o8.mjs');
const sockets = new Set<WebSocket>();
let apiServer: Server;
let apiPort = 0;
let wsPort = 0;
let wsProcess: ChildProcess | null = null;
let serverOutput = '';

const tmuxAvailable = process.platform !== 'win32' && (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

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

async function waitFor(predicate: () => boolean | Promise<boolean>, description: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}. ${serverOutput.slice(-4_000)}`);
}

async function startWsServer() {
  wsProcess = execFile(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs',
    '--import=tsx',
    'src/ws-server.ts',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      O8_DATA_DIR: dataDir,
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_API_PORT: String(apiPort),
      O8_WS_PORT: String(wsPort),
      O8_PERSISTENT_TERMINALS: '1',
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`,
    },
  });
  wsProcess.stdout?.on('data', (chunk) => { serverOutput += String(chunk); });
  wsProcess.stderr?.on('data', (chunk) => { serverOutput += String(chunk); });
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${wsPort}/health`)).ok;
    } catch {
      return false;
    }
  }, 'ws-server health', 30_000);
}

async function stopWsServer() {
  if (!wsProcess || wsProcess.exitCode !== null) return;
  wsProcess.kill('SIGTERM');
  await Promise.race([
    once(wsProcess, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('ws-server did not stop')), 10_000)),
  ]);
  wsProcess = null;
}

async function connectClient() {
  const received: ReceivedFrame[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
  sockets.add(socket);
  socket.on('message', (raw) => received.push({ frame: JSON.parse(String(raw)) as WireFrame, at: performance.now() }));
  socket.on('close', () => sockets.delete(socket));
  await once(socket, 'open');
  await waitFor(
    () => received.some(({ frame }) => frame.channel === 'system' && frame.event === 'connected'),
    'authenticated WebSocket client',
  );
  return { socket, received };
}

function terminalFrames(received: ReceivedFrame[], startIndex: number, targetSession = sessionName) {
  return received.slice(startIndex).filter(({ frame }) => (
    frame.channel === 'terminal'
    && frame.event === 'data'
    && frame.data?.sessionName === targetSession
  ));
}

function terminalText(received: ReceivedFrame[], startIndex = 0, targetSession = sessionName) {
  return terminalFrames(received, startIndex, targetSession)
    .map(({ frame }) => Buffer.from(frame.data?.data ?? '', 'base64').toString('utf8'))
    .join('');
}

function capturePane(targetSession = sessionName) {
  const args = ['capture-pane', '-p', '-t', targetSession];
  return execFileSync('tmux', targetSession === observerSessionName ? args : dashTmuxArgs(...args), { encoding: 'utf8' });
}

function tmuxWindowDimensions(targetSession: string) {
  const args = ['display-message', '-p', '-t', targetSession, '#{window_width} #{window_height}'];
  return execFileSync('tmux', targetSession === observerSessionName ? args : dashTmuxArgs(...args), { encoding: 'utf8' }).trim();
}

function observerTmuxClientFlags() {
  return execFileSync('tmux', ['list-clients', '-t', observerSessionName, '-F', '#{client_readonly}'], { encoding: 'utf8' }).trim().split('\n');
}

function normalizeTerminalLines(lines: string[]) {
  const normalized = lines.map((line) => line.replace(/\s+$/u, ''));
  while (normalized.at(-1) === '') normalized.pop();
  return normalized;
}

function normalizeTerminalText(value: string) {
  return normalizeTerminalLines(value.replaceAll('\r', '').split('\n'));
}

async function reconstructedText(
  received: ReceivedFrame[],
  resyncIndex: number,
  targetSession: string,
  dimensions: { cols: number; rows: number },
) {
  const resync = received[resyncIndex]?.frame;
  const snapshot = Buffer.from(resync?.data?.data ?? '', 'base64').toString('utf8');
  const postResyncChunks = terminalFrames(received, resyncIndex + 1, targetSession)
    .map(({ frame }) => Buffer.from(frame.data?.data ?? '', 'base64').toString('utf8'));
  return normalizeTerminalLines(await renderTerminalBytes(
    [snapshot, ...postResyncChunks],
    { ...dimensions, scrollback: 20_000 },
  ));
}

function assertRenderedScreen(rendered: string[], oracle: string[], rows: number) {
  expect(oracle.length).toBeGreaterThanOrEqual(rows);
  const renderedScreen = rendered.slice(-rows);
  const oracleScreen = oracle.slice(-rows);
  if (
    renderedScreen.length === oracleScreen.length
    && renderedScreen.every((line, index) => line === oracleScreen[index])
  ) return;
  const differences: string[] = [];
  const count = Math.max(renderedScreen.length, oracleScreen.length);
  for (let index = 0; index < count && differences.length < 20; index += 1) {
    if (renderedScreen[index] === oracleScreen[index]) continue;
    const renderedLine = (renderedScreen[index] ?? '<missing>').replaceAll('\x1b', 'ESC');
    const oracleLine = (oracleScreen[index] ?? '<missing>').replaceAll('\x1b', 'ESC');
    differences.push(`${index}: rendered=${JSON.stringify(renderedLine)} oracle=${JSON.stringify(oracleLine)}`);
  }
  throw new Error(`rendered terminal screen differs from tmux oracle:\n${differences.join('\n')}`);
}

async function quiescentOracle(
  client: { received: ReceivedFrame[] },
  targetSession: string,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matchingData = terminalFrames(client.received, 0, targetSession);
    const lastDataAt = matchingData.at(-1)?.at ?? 0;
    if (performance.now() - lastDataAt < 300) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      continue;
    }
    const first = capturePane(targetSession);
    const dataCount = matchingData.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = capturePane(targetSession);
    const currentData = terminalFrames(client.received, 0, targetSession);
    const currentLastDataAt = currentData.at(-1)?.at ?? 0;
    if (
      first === second
      && currentData.length === dataCount
      && performance.now() - currentLastDataAt >= 300
    ) return normalizeTerminalText(second);
  }
  throw new Error(`Timed out waiting for quiescent tmux oracle for ${targetSession}`);
}

async function spawnOrReadPty(session: string, shellCommand = 'true') {
  const response = await fetch(`http://127.0.0.1:${wsPort}/terminal-spawn`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionName: session, shellCommand, cwd: process.cwd() }),
  });
  expect(response.ok).toBe(true);
  const payload = await response.json() as { pid?: number };
  return payload;
}

beforeAll(async () => {
  if (!tmuxAvailable) return;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, { mode: 0o600 });
  await build({
    entryPoints: [join(process.cwd(), 'cli/src/index.ts')],
    alias: cliBundleAlias,
    outfile: cliBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    define: { __O8_CLI_VERSION__: JSON.stringify('test-fixture') },
    banner: { js: `import { createRequire as __o8_createRequire } from 'node:module';
import { fileURLToPath as __o8_fileURLToPath } from 'node:url';
import { dirname as __o8_dirname } from 'node:path';
const require = __o8_createRequire(import.meta.url); globalThis.require = require;
const __filename = __o8_fileURLToPath(import.meta.url); const __dirname = __o8_dirname(__filename);` },
  });
  apiPort = await freePort();
  wsPort = await freePort();
  apiServer = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
  });
  apiServer.listen(apiPort, '127.0.0.1');
  await once(apiServer, 'listening');
  await startWsServer();
}, 40_000);

afterAll(async () => {
  for (const socket of sockets) socket.close();
  await stopWsServer().catch(() => undefined);
  if (apiServer?.listening) await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  try { execFileSync('tmux', dashTmuxArgs('kill-session', '-t', sessionName), { stdio: 'ignore' }); } catch { /* not created */ }
  try { execFileSync('tmux', dashTmuxArgs('kill-session', '-t', duplicateSessionName), { stdio: 'ignore' }); } catch { /* not created */ }
  try { execFileSync('tmux', dashTmuxArgs('kill-session', '-t', cliSessionName), { stdio: 'ignore' }); } catch { /* not created */ }
  try { execFileSync('tmux', ['kill-session', '-t', observerSessionName], { stdio: 'ignore' }); } catch { /* not created */ }
  rmSync(dataDir, { recursive: true, force: true });
});

describe.runIf(tmuxAvailable)('terminal visibility through the real WebSocket and PTY path', () => {
  it('observes the source grid without allowing input or resize, then keeps writable attachment interactive', async () => {
    execFileSync('tmux', ['new-session', '-d', '-s', observerSessionName, '-x', '117', '-y', '31']);
    expect(tmuxWindowDimensions(observerSessionName)).toBe('117 31');

    const observer = await connectClient();
    observer.socket.send(JSON.stringify({
      type: 'terminal-attach', sessionName: observerSessionName, cols: 42, rows: 12, readOnly: true,
    }));
    await waitFor(() => observer.received.some(({ frame }) => (
      frame.channel === 'terminal' && frame.event === 'attached' && frame.data?.sessionName === observerSessionName
    )), 'read-only terminal attachment');
    const attached = observer.received.find(({ frame }) => (
      frame.event === 'attached' && frame.data?.sessionName === observerSessionName
    ))?.frame.data;
    expect([attached?.cols, attached?.rows]).toEqual([117, 32]);
    expect(tmuxWindowDimensions(observerSessionName)).toBe('117 31');

    observer.socket.send(JSON.stringify({
      type: 'terminal-input', sessionName: observerSessionName, data: "printf 'O8_OBSERVER_WROTE\\n'\r",
    }));
    observer.socket.send(JSON.stringify({
      type: 'terminal-resize', sessionName: observerSessionName, cols: 42, rows: 12,
    }));
    observer.socket.send(JSON.stringify({
      type: 'terminal-visibility', sessionName: observerSessionName, visible: true,
      epoch: 1, needsResync: true, cols: 42, rows: 12,
    }));
    await waitFor(() => observer.received.some(({ frame }) => (
      frame.event === 'resync' && frame.data?.sessionName === observerSessionName && frame.data?.epoch === 1
    )), 'read-only reveal');
    expect(tmuxWindowDimensions(observerSessionName)).toBe('117 31');
    expect(capturePane(observerSessionName)).not.toContain('O8_OBSERVER_WROTE');

    const writer = await connectClient();
    writer.socket.send(JSON.stringify({
      type: 'terminal-attach', sessionName: observerSessionName, cols: 117, rows: 31,
    }));
    await waitFor(() => writer.received.some(({ frame }) => (
      frame.event === 'attached' && frame.data?.sessionName === observerSessionName
    )), 'writable terminal attachment');
    writer.socket.send(JSON.stringify({
      type: 'terminal-input', sessionName: observerSessionName, data: "printf 'O8_WRITER_WORKS\\n'\r",
    }));
    await waitFor(() => capturePane(observerSessionName).includes('O8_WRITER_WORKS'), 'writable terminal input');
    writer.socket.send(JSON.stringify({
      type: 'terminal-resize', sessionName: observerSessionName, cols: 100, rows: 27,
    }));
    await waitFor(() => observer.received.some(({ frame }) => (
      frame.event === 'dimensions' && frame.data?.sessionName === observerSessionName
      && frame.data?.cols === 100 && frame.data?.rows === 27
    )), 'observer source dimensions update');
    await waitFor(() => tmuxWindowDimensions(observerSessionName).startsWith('100 '), 'writable owner resize');

    observer.socket.close();
    await once(observer.socket, 'close');
    const reconnected = await connectClient();
    reconnected.socket.send(JSON.stringify({
      type: 'terminal-attach', sessionName: observerSessionName, cols: 40, rows: 10, readOnly: true,
    }));
    await waitFor(() => reconnected.received.some(({ frame }) => (
      frame.event === 'attached' && frame.data?.sessionName === observerSessionName
    )), 'read-only reconnect');
    const sourceDimensions = tmuxWindowDimensions(observerSessionName);
    reconnected.socket.send(JSON.stringify({
      type: 'terminal-input', sessionName: observerSessionName, data: "printf 'O8_RECONNECTED_WROTE\\n'\r",
    }));
    reconnected.socket.send(JSON.stringify({
      type: 'terminal-resize', sessionName: observerSessionName, cols: 40, rows: 10,
    }));
    reconnected.socket.send(JSON.stringify({
      type: 'terminal-visibility', sessionName: observerSessionName, visible: true,
      epoch: 1, needsResync: true, cols: 40, rows: 10,
    }));
    await waitFor(() => reconnected.received.some(({ frame }) => (
      frame.event === 'resync' && frame.data?.sessionName === observerSessionName && frame.data?.epoch === 1
    )), 'read-only reconnect reveal');
    expect(tmuxWindowDimensions(observerSessionName)).toBe(sourceDimensions);
    expect(capturePane(observerSessionName)).not.toContain('O8_RECONNECTED_WROTE');

    writer.socket.send(JSON.stringify({ type: 'terminal-detach', sessionName: observerSessionName }));
    await waitFor(() => writer.received.some(({ frame }) => (
      frame.event === 'detached' && frame.data?.sessionName === observerSessionName
    )), 'writable owner detach');
    await waitFor(() => observerTmuxClientFlags().join(',') === '1', 'observer ignore-size client restored');
  }, 30_000);

  it('coalesces hidden delivery, resyncs from tmux after overflow, and keeps the PTY', async () => {
    const visible = await connectClient();
    const hidden = await connectClient();
    visible.socket.send(JSON.stringify({
      type: 'terminal-create', ownerKey, requestId: 'visibility-create', ...OVERFLOW_TERMINAL,
    }));
    await waitFor(() => visible.received.some(({ frame }) => (
      frame.channel === 'terminal' && frame.event === 'created' && frame.data?.requestId === 'visibility-create'
    )), 'terminal creation');

    for (const client of [visible, hidden]) {
      client.socket.send(JSON.stringify({ type: 'terminal-attach', sessionName, ...OVERFLOW_TERMINAL }));
      await waitFor(() => client.received.some(({ frame }) => (
        frame.channel === 'terminal' && frame.event === 'attached' && frame.data?.sessionName === sessionName
      )), 'terminal attachment');
    }
    visible.socket.send(JSON.stringify({ type: 'terminal-visibility', sessionName, visible: true, epoch: 1 }));
    hidden.socket.send(JSON.stringify({ type: 'terminal-visibility', sessionName, visible: false, epoch: 1 }));
    await waitFor(() => visible.received.some(({ frame }) => frame.event === 'visibility-ready' && frame.data?.epoch === 1), 'visible acknowledgement');
    const pidBefore = (await spawnOrReadPty(sessionName)).pid;
    expect(pidBefore).toBeTypeOf('number');

    const visibleStart = visible.received.length;
    const hiddenStart = hidden.received.length;
    visible.socket.send(JSON.stringify({
      type: 'terminal-input',
      sessionName,
      data: "i=0; while [ $i -lt 40 ]; do printf 'O8SEQ_%03d\\n' \"$i\"; i=$((i+1)); sleep 0.025; done\r",
    }));
    await waitFor(() => terminalText(visible.received, visibleStart).includes('O8SEQ_039'), 'visible sequence');
    await waitFor(() => terminalText(hidden.received, hiddenStart).includes('O8SEQ_039'), 'hidden coalesced sequence');

    const visibleData = terminalFrames(visible.received, visibleStart);
    const hiddenData = terminalFrames(hidden.received, hiddenStart);
    expect(visibleData.length).toBeGreaterThan(8);
    expect(hiddenData.length).toBeLessThan(visibleData.length);
    const hiddenIntervals = hiddenData.slice(1).map((entry, index) => entry.at - hiddenData[index].at);
    expect(Math.min(...hiddenIntervals)).toBeGreaterThan(175);

    const paintedRows = Array.from({ length: OVERFLOW_TERMINAL.rows }, (_, index) => (
      `O8_RESYNC_ROW_${String(index).padStart(2, '0')}${index === OVERFLOW_TERMINAL.rows - 1 ? ' O8_OVERFLOW_DONE' : ''}`
    ));
    const paintedScreen = `\x1b[2J\x1b[H${paintedRows
      .map((line, index) => `\x1b[${index + 1};1H${line}`)
      .join('')}`;
    const overflowScript = `const line='Z'.repeat(4095)+'\\n';let elapsed=0;const timer=setInterval(()=>{process.stdout.write(line);elapsed+=5;if(elapsed>=400){clearInterval(timer);process.stdout.write(Buffer.from('${Buffer.from(paintedScreen).toString('base64')}','base64'));}},5)`;
    visible.socket.send(JSON.stringify({
      type: 'terminal-input',
      sessionName,
      data: `${process.execPath} -e "${overflowScript}"\r`,
    }));
    await waitFor(() => terminalText(visible.received, visibleStart).includes('O8_OVERFLOW_DONE'), 'overflow command completion');
    await waitFor(() => hidden.received.some(({ frame }) => (
      frame.event === 'diagnostic' && frame.data?.code === 'terminal_hidden_overflow'
    )), 'hidden overflow diagnostic');
    const overflow = hidden.received.find(({ frame }) => frame.event === 'diagnostic' && frame.data?.code === 'terminal_hidden_overflow');
    expect(overflow?.frame.data?.lastGoodOffset).toBeTypeOf('number');

    await waitFor(
      () => terminalText(visible.received, visibleStart).includes('O8_RESYNC_ROW_29 O8_OVERFLOW_DONE'),
      'full resync screen paint',
    );

    const revealStart = hidden.received.length;
    hidden.socket.send(JSON.stringify({ type: 'terminal-visibility', sessionName, visible: true, epoch: 2 }));
    await waitFor(() => hidden.received.some(({ frame }) => frame.event === 'resync' && frame.data?.epoch === 2), 'tmux resync snapshot');
    const resyncIndex = hidden.received.findIndex(({ frame }, index) => (
      index >= revealStart && frame.event === 'resync' && frame.data?.epoch === 2
    ));
    const resync = hidden.received[resyncIndex]?.frame;
    expect(resync?.data?.source).toBe('tmux');
    expect(resync?.data?.historyTruncated).toBe(false);
    const snapshot = Buffer.from(resync?.data?.data ?? '', 'base64').toString('utf8');
    expect(snapshot).toContain('O8_OVERFLOW_DONE');
    const oracle = await quiescentOracle(hidden, sessionName);
    const snapshotBuffer = await renderTerminalBytes(
      [snapshot],
      { ...OVERFLOW_TERMINAL, scrollback: 20_000, trimTrailingBlankLines: false },
    );
    const snapshotScreen = snapshotBuffer.slice(-OVERFLOW_TERMINAL.rows)
      .map((line) => line.replace(/\s+$/u, ''));
    // Tmux history cannot be compared because xterm.js drops CSI n S scrolls (#1979).
    assertRenderedScreen(snapshotScreen, oracle, OVERFLOW_TERMINAL.rows);
    const reconstruction = await reconstructedText(
      hidden.received,
      resyncIndex,
      sessionName,
      OVERFLOW_TERMINAL,
    );
    assertRenderedScreen(reconstruction, oracle, OVERFLOW_TERMINAL.rows);
    expect(hidden.received.slice(revealStart).some(({ frame }) => (
      frame.event === 'diagnostic' && frame.data?.code === 'terminal_resync_unsettled'
    ))).toBe(false);
    expect((await spawnOrReadPty(sessionName)).pid).toBe(pidBefore);
  }, 60_000);

  it('does not duplicate in-flight numbered output across an immediate reveal', async () => {
    const visible = await connectClient();
    const hidden = await connectClient();
    visible.socket.send(JSON.stringify({
      type: 'terminal-create', ownerKey: duplicateOwnerKey, requestId: 'duplicate-create', ...DUPLICATE_TERMINAL,
    }));
    await waitFor(() => visible.received.some(({ frame }) => (
      frame.channel === 'terminal' && frame.event === 'created' && frame.data?.requestId === 'duplicate-create'
    )), 'duplicate terminal creation');
    for (const client of [visible, hidden]) {
      client.socket.send(JSON.stringify({
        type: 'terminal-attach', sessionName: duplicateSessionName, ...DUPLICATE_TERMINAL,
      }));
      await waitFor(() => client.received.some(({ frame }) => (
        frame.channel === 'terminal' && frame.event === 'attached' && frame.data?.sessionName === duplicateSessionName
      )), 'duplicate terminal attachment');
    }
    visible.socket.send(JSON.stringify({ type: 'terminal-visibility', sessionName: duplicateSessionName, visible: true, epoch: 1 }));
    hidden.socket.send(JSON.stringify({ type: 'terminal-visibility', sessionName: duplicateSessionName, visible: false, epoch: 1 }));
    await waitFor(() => visible.received.some(({ frame }) => (
      frame.event === 'visibility-ready' && frame.data?.sessionName === duplicateSessionName
    )), 'duplicate visible acknowledgement');
    const pidBefore = (await spawnOrReadPty(duplicateSessionName)).pid;
    const revealStart = hidden.received.length;
    hidden.socket.send(JSON.stringify({
      type: 'terminal-input',
      sessionName: duplicateSessionName,
      data: "i=0; while [ $i -lt 200 ]; do printf 'O8_DUP_%03d\\n' \"$i\"; i=$((i+1)); done\r",
    }));
    hidden.socket.send(JSON.stringify({
      type: 'terminal-visibility',
      sessionName: duplicateSessionName,
      visible: true,
      epoch: 2,
      needsResync: true,
    }));
    await waitFor(() => hidden.received.some(({ frame }, index) => (
      index >= revealStart
      && frame.event === 'resync'
      && frame.data?.sessionName === duplicateSessionName
      && frame.data?.epoch === 2
    )), 'immediate-reveal resync');
    const resyncIndex = hidden.received.findIndex(({ frame }, index) => (
      index >= revealStart
      && frame.event === 'resync'
      && frame.data?.sessionName === duplicateSessionName
      && frame.data?.epoch === 2
    ));
    const resyncSnapshot = Buffer.from(
      hidden.received[resyncIndex]?.frame.data?.data ?? '',
      'base64',
    ).toString('utf8');
    await waitFor(() => (
      `${resyncSnapshot}${terminalText(hidden.received, resyncIndex + 1, duplicateSessionName)}`
        .includes('O8_DUP_199')
    ), 'immediate-reveal sequence completion');
    const oracle = await quiescentOracle(hidden, duplicateSessionName);
    const reconstruction = await reconstructedText(
      hidden.received,
      resyncIndex,
      duplicateSessionName,
      DUPLICATE_TERMINAL,
    );
    assertRenderedScreen(reconstruction, oracle, DUPLICATE_TERMINAL.rows);
    const renderedScreenText = reconstruction.slice(-DUPLICATE_TERMINAL.rows).join('\n');
    for (let index = 170; index < 200; index += 1) {
      const marker = `O8_DUP_${String(index).padStart(3, '0')}`;
      expect(renderedScreenText.split(marker).length - 1, marker).toBe(1);
    }
    expect((await spawnOrReadPty(duplicateSessionName)).pid).toBe(pidBefore);
  }, 45_000);

  it('marks plain-PTY replay as truncated when the scrollback ring overflowed', async () => {
    const hidden = await connectClient();
    const visible = await connectClient();
    const code = "setTimeout(()=>process.stdout.write('P'.repeat(700000)+'\\nO8_PLAIN_DONE\\n'),300);setTimeout(()=>{},10000)";
    const spawned = await spawnOrReadPty(
      plainSessionName,
      `${process.execPath} -e \"${code}\"`,
    );
    expect(spawned.pid).toBeTypeOf('number');
    hidden.socket.send(JSON.stringify({ type: 'terminal-attach', sessionName: plainSessionName, cols: 120, rows: 30 }));
    await waitFor(() => hidden.received.some(({ frame }) => (
      frame.event === 'attached' && frame.data?.sessionName === plainSessionName
    )), 'plain PTY attachment');
    hidden.socket.send(JSON.stringify({ type: 'terminal-visibility', sessionName: plainSessionName, visible: false, epoch: 1 }));
    visible.socket.send(JSON.stringify({ type: 'terminal-attach', sessionName: plainSessionName, cols: 120, rows: 30 }));
    await waitFor(() => visible.received.some(({ frame }) => (
      frame.event === 'attached' && frame.data?.sessionName === plainSessionName
    )), 'plain PTY visible attachment');
    visible.socket.send(JSON.stringify({ type: 'terminal-visibility', sessionName: plainSessionName, visible: true, epoch: 1 }));
    await waitFor(() => hidden.received.some(({ frame }) => (
      frame.event === 'diagnostic'
      && frame.data?.sessionName === plainSessionName
      && frame.data?.code === 'terminal_hidden_overflow'
    )), 'plain PTY hidden overflow');
    await waitFor(() => terminalText(visible.received, 0, plainSessionName).includes('O8_PLAIN_DONE'), 'plain PTY final screen');

    hidden.socket.send(JSON.stringify({ type: 'terminal-visibility', sessionName: plainSessionName, visible: true, epoch: 2 }));
    await waitFor(() => hidden.received.some(({ frame }) => (
      frame.event === 'resync' && frame.data?.sessionName === plainSessionName && frame.data?.epoch === 2
    )), 'plain PTY resync');
    const resync = hidden.received.find(({ frame }) => (
      frame.event === 'resync' && frame.data?.sessionName === plainSessionName && frame.data?.epoch === 2
    ))?.frame;
    expect(resync?.data?.source).toBe('scrollback');
    expect(resync?.data?.historyTruncated).toBe(true);
    const replayed = Buffer.from(resync?.data?.data ?? '', 'base64').toString('utf8');
    expect(replayed).toContain('[terminal history truncated during hidden replay]');
    expect(replayed).toContain('O8_PLAIN_DONE');
    expect((await spawnOrReadPty(plainSessionName)).pid).toBe(spawned.pid);
  }, 30_000);

  it('lists, snapshots, and observes the same detached shell after a server restart through the CLI', async () => {
    const writer = await connectClient();
    writer.socket.send(JSON.stringify({
      type: 'terminal-create', ownerKey: `workspace:terminal-cli-${process.pid}`,
      requestId: 'cli-create', cols: 100, rows: 30,
    }));
    await waitFor(() => writer.received.some(({ frame }) => (
      frame.event === 'created' && frame.data?.sessionName === cliSessionName
    )), 'CLI fixture session reservation');
    writer.socket.send(JSON.stringify({ type: 'terminal-attach', sessionName: cliSessionName, cols: 100, rows: 30 }));
    await waitFor(() => writer.received.some(({ frame }) => (
      frame.event === 'attached' && frame.data?.sessionName === cliSessionName
    )), 'CLI fixture terminal attachment');
    writer.socket.send(JSON.stringify({
      type: 'terminal-input', sessionName: cliSessionName, data: "printf 'O8_CLI_BEFORE_RESTART\\n'\r",
    }));
    await waitFor(() => capturePane(cliSessionName).includes('O8_CLI_BEFORE_RESTART'), 'CLI fixture shell output');
    writer.socket.close();
    await stopWsServer();
    await startWsServer();

    const cliEnv: NodeJS.ProcessEnv = {
      ...process.env,
      O8_DATA_DIR: dataDir,
      O8_API_PORT: String(apiPort),
      O8_WS_PORT: String(wsPort),
      O8_API_TOKEN: token,
    };
    delete cliEnv.O8_WORKER_TOKEN;
    const cli = (...args: string[]) => execFileSync(
      process.execPath,
      [cliBundle, 'terminal', ...args],
      { cwd: process.cwd(), env: cliEnv, encoding: 'utf8', timeout: 15_000 },
    );
    const listed = JSON.parse(cli('list')) as { sessions: Array<{ id: string }> };
    expect(listed.sessions.some((session) => session.id === cliSessionName)).toBe(true);
    const snapshot = JSON.parse(cli('show', cliSessionName, '--lines', '80')) as {
      session: { id: string; cols: number; rows: number }; text: string;
    };
    expect(snapshot.session.id).toBe(cliSessionName);
    expect(snapshot.session.cols).toBeGreaterThan(0);
    expect(snapshot.text).toContain('O8_CLI_BEFORE_RESTART');
    const oneLine = JSON.parse(cli('show', cliSessionName, '--lines', '1')) as { text: string };
    expect(oneLine.text.trimEnd().split('\n')).toHaveLength(1);

    const observed = spawn(process.execPath, [
      cliBundle, 'terminal', 'observe', cliSessionName,
    ], { cwd: process.cwd(), env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const observedClosed = once(observed, 'close');
    let observedText = '';
    observed.stdout.on('data', (chunk) => { observedText += String(chunk); });
    try {
      await waitFor(() => observedText.includes('"event":"attached"'), 'CLI observer attachment');
      execFileSync('tmux', dashTmuxArgs(
        'send-keys', '-t', cliSessionName, "printf 'O8_CLI_AFTER_RESTART\\n'", 'Enter',
      ));
      await waitFor(() => observedText.includes('O8_CLI_AFTER_RESTART'), 'CLI live terminal output');
      expect(tmuxWindowDimensions(cliSessionName)).toBe('100 30');
      execFileSync('tmux', dashTmuxArgs('kill-session', '-t', cliSessionName));
      await waitFor(() => observedText.includes('"event":"exited"'), 'CLI terminal exit');
      expect((await observedClosed)[0]).toBe(0);
    } finally {
      if (observed.exitCode === null) observed.kill('SIGTERM');
      await observedClosed;
    }
    const missing = spawnSync(process.execPath, [cliBundle, 'terminal', 'show', 'cortex-dash-does-not-exist'], {
      cwd: process.cwd(), env: cliEnv, encoding: 'utf8',
    });
    expect(missing.status).toBe(4);
    const worker = spawnSync(process.execPath, [cliBundle, 'terminal', 'list'], {
      cwd: process.cwd(), env: { ...cliEnv, O8_WORKER_TOKEN: 'worker-token' }, encoding: 'utf8',
    });
    expect(worker.status).toBe(3);
    expect(worker.stderr).toContain('operator_required');
    const anonymous = await fetch(`http://127.0.0.1:${wsPort}/terminal-snapshot?sessionName=${cliSessionName}`);
    expect(anonymous.status).toBe(401);
    const foreign = await fetch(`http://127.0.0.1:${wsPort}/terminal-snapshot?sessionName=${observerSessionName}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(foreign.status).toBe(404);
  }, 60_000);

  it('controls one existing shell exclusively, releases it, and reconnects after server restart', async () => {
    const ui = await connectClient();
    ui.socket.send(JSON.stringify({
      type: 'terminal-create', ownerKey: `workspace:terminal-control-${process.pid}`,
      requestId: 'control-create', cols: 100, rows: 30,
    }));
    await waitFor(() => ui.received.some(({ frame }) => (
      frame.event === 'created' && frame.data?.sessionName === controlSessionName
    )), 'control shell reservation');
    ui.socket.send(JSON.stringify({ type: 'terminal-attach', sessionName: controlSessionName, cols: 100, rows: 30 }));
    await waitFor(() => ui.received.some(({ frame }) => (
      frame.event === 'attached' && frame.data?.sessionName === controlSessionName
    )), 'control shell UI attachment');

    const cliEnv: NodeJS.ProcessEnv = { ...process.env, O8_DATA_DIR: dataDir, O8_API_PORT: String(apiPort),
      O8_WS_PORT: String(wsPort), O8_API_TOKEN: token };
    delete cliEnv.O8_WORKER_TOKEN;
    const first = spawnSync(process.execPath, [cliBundle, 'terminal', 'control', controlSessionName], {
      cwd: process.cwd(), env: cliEnv, encoding: 'utf8', input: '', timeout: 10_000,
    });
    expect(first.status).toBe(5);
    expect(first.stderr).toContain('terminal_busy');
    ui.socket.close();
    await waitFor(() => ui.socket.readyState === WebSocket.CLOSED, 'UI writer release');

    const observer = await connectClient();
    observer.socket.send(JSON.stringify({ type: 'terminal-attach', sessionName: controlSessionName, readOnly: true }));
    await waitFor(() => observer.received.some(({ frame }) => (
      frame.event === 'attached' && frame.data?.sessionName === controlSessionName
    )), 'read-only observer');
    const dimensionsBeforeControl = tmuxWindowDimensions(controlSessionName);
    const control = spawn(process.execPath, [cliBundle, 'terminal', 'control', controlSessionName], {
      cwd: process.cwd(), env: cliEnv, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const controlClosed = once(control, 'close');
    let output = '';
    control.stdout.on('data', (chunk) => { output += String(chunk); });
    try {
      await waitFor(() => output.includes('"event":"attached"'), 'CLI control claim');
      expect(tmuxWindowDimensions(controlSessionName)).toBe(dimensionsBeforeControl);
      const second = spawnSync(process.execPath, [cliBundle, 'terminal', 'control', controlSessionName], {
        cwd: process.cwd(), env: cliEnv, encoding: 'utf8', input: '', timeout: 10_000,
      });
      expect(second.status).toBe(5);
      expect(second.stderr).toContain('terminal_busy');
      const blockedUi = await connectClient();
      blockedUi.socket.send(JSON.stringify({ type: 'terminal-attach', sessionName: controlSessionName }));
      await waitFor(() => blockedUi.received.some(({ frame }) => (
        frame.event === 'error' && frame.data?.sessionName === controlSessionName
      )), 'UI writer conflict');
      expect(blockedUi.received.find(({ frame }) => frame.event === 'error')?.frame.data?.code).toBe('terminal_busy');
      blockedUi.socket.close();
      for (const [path, body] of [
        ['/terminal-voice-input', { sessionName: controlSessionName, text: 'O8_VOICE_MUST_NOT_WRITE' }],
        ['/terminal-exec', { sessionName: controlSessionName, command: 'O8_EXEC_MUST_NOT_WRITE' }],
      ] as const) {
        const response = await fetch(`http://127.0.0.1:${wsPort}${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(409);
      }
      control.stdin.write(`${JSON.stringify({ type: 'input', data: "printf 'O8_CONTROL_RECONNECTED\\n'\r" })}\n`);
      await waitFor(() => capturePane(controlSessionName).includes('O8_CONTROL_RECONNECTED'), 'CLI input in original shell');
      expect(capturePane(controlSessionName)).not.toContain('O8_VOICE_MUST_NOT_WRITE');
      expect(capturePane(controlSessionName)).not.toContain('O8_EXEC_MUST_NOT_WRITE');
      observer.socket.send(JSON.stringify({ type: 'terminal-input', sessionName: controlSessionName, data: 'O8_OBSERVER_MUST_NOT_WRITE' }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(capturePane(controlSessionName)).not.toContain('O8_OBSERVER_MUST_NOT_WRITE');
      control.stdin.write(`${JSON.stringify({ type: 'release' })}\n`);
      expect((await controlClosed)[0]).toBe(0);
    } finally {
      if (control.exitCode === null) control.kill('SIGTERM');
      await controlClosed;
    }
    const restoredUi = await connectClient();
    restoredUi.socket.send(JSON.stringify({ type: 'terminal-attach', sessionName: controlSessionName }));
    await waitFor(() => restoredUi.received.some(({ frame }) => (
      frame.event === 'attached' && frame.data?.sessionName === controlSessionName
    )), 'UI writer after release');
    restoredUi.socket.close();
    await waitFor(() => restoredUi.socket.readyState === WebSocket.CLOSED, 'restored UI writer release');
    const human = spawn(process.execPath, [cliBundle, '--human', 'terminal', 'control', controlSessionName], {
      cwd: process.cwd(), env: cliEnv, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const humanClosed = once(human, 'close');
    let humanOutput = '';
    human.stdout.on('data', (chunk) => { humanOutput += String(chunk); });
    try {
      await waitFor(() => humanOutput.includes('O8_CONTROL_RECONNECTED'), 'interactive shell replay');
      const unicodeCommand = Buffer.from("printf 'O8_UTF8_é_OK\\n'\r");
      const splitAt = unicodeCommand.indexOf(0xc3) + 1;
      human.stdin.write(unicodeCommand.subarray(0, splitAt));
      await new Promise((resolve) => setTimeout(resolve, 30));
      human.stdin.write(unicodeCommand.subarray(splitAt));
      await waitFor(() => capturePane(controlSessionName).includes('O8_UTF8_é_OK'), 'split UTF-8 terminal input');
      human.stdin.write(Buffer.from([0x1d]));
      expect((await humanClosed)[0]).toBe(0);
    } finally {
      if (human.exitCode === null) human.kill('SIGTERM');
      await humanClosed;
    }
    const dimensionsBeforeRestart = tmuxWindowDimensions(controlSessionName);
    await stopWsServer();
    await startWsServer();
    const next = spawn(process.execPath, [cliBundle, 'terminal', 'control', controlSessionName], {
      cwd: process.cwd(), env: cliEnv, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const nextClosed = once(next, 'close');
    let nextOutput = '';
    next.stdout.on('data', (chunk) => { nextOutput += String(chunk); });
    try {
      await waitFor(() => nextOutput.includes('"event":"attached"'), 'CLI control after restart');
      expect(tmuxWindowDimensions(controlSessionName)).toBe(dimensionsBeforeRestart);
      next.stdin.write(`${JSON.stringify({ type: 'release' })}\n`);
      expect((await nextClosed)[0]).toBe(0);
    } finally {
      if (next.exitCode === null) next.kill('SIGTERM');
      await nextClosed;
      execFileSync('tmux', dashTmuxArgs('kill-session', '-t', controlSessionName));
    }
  }, 60_000);
});
