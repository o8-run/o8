/** Read existing dashboard terminals through the server-owned terminal host. */
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { apiFetch, CliError, EXIT, resolveWsBase } from '../api.js';
import { resolveConfig, type ResolvedConfig } from '../config.js';
import { printJson, type OutputMode } from '../output.js';
import { runRemoteTerminal } from './machine.js';
import { TerminalProbeReplyFilter } from './terminal-probe-filter.js';
import {
  confirmOpenedPanes, openTerminalPanes, parsePanesArgs, runningPackets, workerTerminals, type PaneTerminal,
} from './terminal-panes.js';
import { installShortcut, parseShortcutArgs, removeShortcut } from './terminal-shortcut.js';
import { waitForTerminalOutput } from './terminal-wait.js';

interface TerminalSession { id: string; cols?: number; rows?: number }

function operatorConfig(): ResolvedConfig {
  const cfg = resolveConfig();
  if (cfg.source.token === 'worker' || cfg.source.token === 'spectator' || !cfg.token) {
    throw new CliError(
      'operator_required',
      'Terminal access requires the local operator credential.',
      EXIT.UNAUTHORIZED,
    );
  }
  return cfg;
}

function terminalUrl(cfg: ResolvedConfig, path: string): URL {
  const url = new URL(path, resolveWsBase(cfg));
  url.protocol = 'http:';
  return url;
}

async function terminalGet<T>(cfg: ResolvedConfig, url: URL): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new CliError('connection_refused', 'The o8 terminal host is unavailable.', EXIT.CONNECTION_REFUSED);
  }
  if (response.status === 401 || response.status === 403) {
    throw new CliError('unauthorized', 'Terminal host rejected the operator credential.', EXIT.UNAUTHORIZED);
  }
  if (response.status === 404) {
    throw new CliError('terminal_not_found', 'That live terminal session was not found.', EXIT.NOT_FOUND);
  }
  if (!response.ok) {
    throw new CliError('terminal_unavailable', `Terminal host returned ${response.status}.`, EXIT.CONFLICT);
  }
  return response.json() as Promise<T>;
}

async function listSessions(cfg: ResolvedConfig): Promise<TerminalSession[]> {
  const result = await terminalGet<{ sessions?: unknown }>(cfg, terminalUrl(cfg, '/terminal-sessions'));
  if (!Array.isArray(result.sessions)) {
    throw new CliError('invalid_response', 'Terminal host returned an invalid inventory.', EXIT.CONFLICT);
  }
  return result.sessions.filter((id): id is string => typeof id === 'string').map((id) => ({ id }));
}

/**
 * Terminals of running workers. They come from the fleet list, not the
 * dashboard shell inventory, and can only be read. `failed` is set when the
 * fleet list could not be read, so the caller can say workers are missing.
 */
async function listWorkerTerminals(cfg: ResolvedConfig): Promise<{ terminals: PaneTerminal[]; failed: boolean }> {
  try {
    const response = await apiFetch<{ fleetSessions?: unknown }>(cfg, '/api/mobile/inbox', {
      query: { workspaceReview: '0' }, timeoutMs: 8_000,
    });
    return { terminals: workerTerminals(response.data?.fleetSessions), failed: false };
  } catch {
    return { terminals: [], failed: true };
  }
}

/**
 * Packets whose worker is running. Most workers have no terminal, so a pane
 * follows the packet's transcript instead. `failed` is set when the lane list
 * could not be read.
 */
async function listRunningPackets(cfg: ResolvedConfig): Promise<{ terminals: PaneTerminal[]; failed: boolean }> {
  try {
    // Every lane, not only active ones: a packet's newest lane decides, and a finished one must be seen to count.
    const response = await apiFetch<{ lanes?: unknown }>(cfg, '/api/lanes', { query: { active: 'false' }, timeoutMs: 8_000 });
    if (!Array.isArray(response.data?.lanes)) return { terminals: [], failed: true };
    return { terminals: runningPackets(response.data.lanes), failed: false };
  } catch {
    return { terminals: [], failed: true };
  }
}

/** A dashboard shell is live, or, for read-only commands, a running worker's terminal is. */
async function requireLiveSession(cfg: ResolvedConfig, id: string, workersToo = false): Promise<void> {
  if ((await listSessions(cfg)).some((session) => session.id === id)) return;
  if (workersToo && (await listWorkerTerminals(cfg)).terminals.some((worker) => worker.id === id)) return;
  throw new CliError('terminal_not_found', `Terminal ${id} is not live.`, EXIT.NOT_FOUND);
}

/** A controller owns the writer slot only while this WebSocket is connected. */
function control(cfg: ResolvedConfig, id: string, mode: OutputMode, filterProbeReplies = false): Promise<number> {
  const url = new URL('/ws', resolveWsBase(cfg));
  url.searchParams.set('token', cfg.token!);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const decoder = new TextDecoder();
    const inputDecoder = new TextDecoder();
    let attached = false;
    let settled = false;
    let lineBuffer = '';
    const probeFilter = filterProbeReplies ? new TerminalProbeReplyFilter() : null;
    let probeFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false;
    const send = (frame: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    };
    const dimensions = () => ({ cols: process.stdout.columns || 120, rows: process.stdout.rows || 30 });
    const cleanup = () => {
      clearTimeout(connectTimer);
      if (probeFlushTimer) clearTimeout(probeFlushTimer);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.stdin.off('data', onInput);
      process.stdin.off('end', stop);
      process.stdout.off('resize', onResize);
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
      if (attached) send({ type: 'terminal-detach', sessionName: id });
      socket.close();
    };
    const fail = (error: CliError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const stop = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(EXIT.OK);
    };
    const onResize = () => {
      if (attached && mode.human) send({ type: 'terminal-resize', sessionName: id, ...dimensions() });
    };
    const onInput = (chunk: Buffer | string) => {
      if (!attached) return;
      if (mode.human) {
        const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const releaseAt = input.indexOf(0x1d); // Ctrl-] releases the CLI without killing the shell.
        const data = releaseAt < 0 ? input : input.subarray(0, releaseAt);
        if (data.length) {
          const text = inputDecoder.decode(data, { stream: true });
          const filtered = probeFilter ? probeFilter.push(text) : text;
          if (filtered) send({ type: 'terminal-input', sessionName: id, data: filtered });
          if (probeFlushTimer) clearTimeout(probeFlushTimer);
          probeFlushTimer = probeFilter?.hasPending ? setTimeout(() => {
            const remainder = probeFilter.flush();
            if (remainder) send({ type: 'terminal-input', sessionName: id, data: remainder });
            probeFlushTimer = null;
          }, probeFilter.pendingDelayMs) : null;
        }
        if (releaseAt >= 0) stop();
        return;
      }
      lineBuffer += String(chunk);
      let newline = lineBuffer.indexOf('\n');
      while (newline >= 0 && !settled) {
        const line = lineBuffer.slice(0, newline).trim();
        lineBuffer = lineBuffer.slice(newline + 1);
        if (line.length > 65_536) {
          fail(new CliError('invalid_args', 'Terminal input line exceeds 64 KiB.', EXIT.INVALID_ARGS));
          return;
        }
        if (line) {
          let frame: { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
          try { frame = JSON.parse(line); } catch {
            fail(new CliError('invalid_args', 'Terminal control input must be newline-delimited JSON.', EXIT.INVALID_ARGS));
            return;
          }
          if (frame.type === 'release') {
            stop();
            return;
          }
          if (frame.type === 'input' && typeof frame.data === 'string') {
            send({ type: 'terminal-input', sessionName: id, data: frame.data });
          } else if (frame.type === 'resize'
            && Number.isSafeInteger(frame.cols) && Number.isSafeInteger(frame.rows)
            && Number(frame.cols) >= 1 && Number(frame.cols) <= 500
            && Number(frame.rows) >= 1 && Number(frame.rows) <= 300) {
            send({ type: 'terminal-resize', sessionName: id, cols: frame.cols, rows: frame.rows });
          } else {
            fail(new CliError('invalid_args', 'Use input, resize, or release frames.', EXIT.INVALID_ARGS));
            return;
          }
        }
        newline = lineBuffer.indexOf('\n');
      }
      if (lineBuffer.length > 65_536) {
        fail(new CliError('invalid_args', 'Terminal input line exceeds 64 KiB.', EXIT.INVALID_ARGS));
      }
    };
    const connectTimer = setTimeout(() => fail(new CliError(
      'server_timeout', 'Timed out claiming terminal control.', EXIT.SERVER_TIMEOUT,
    )), 8_000);
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    socket.on('open', () => send({
      type: 'terminal-attach', sessionName: id, control: true,
      ...(mode.human ? dimensions() : {}),
    }));
    socket.on('message', (raw) => {
      let frame: { channel?: string; event?: string; data?: {
        sessionName?: string; data?: string; error?: string; code?: string; control?: boolean;
      } };
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame.channel !== 'terminal' || frame.data?.sessionName !== id) return;
      if (frame.event === 'error') {
        fail(new CliError(
          frame.data.code === 'terminal_busy' ? 'terminal_busy' : 'terminal_unavailable',
          frame.data.error ?? 'Terminal control was refused.',
          frame.data.code === 'terminal_busy' ? EXIT.CONFLICT : EXIT.NOT_FOUND,
        ));
        return;
      }
      if (frame.event === 'attached') {
        if (frame.data.control !== true) {
          fail(new CliError('invalid_response', 'Terminal host did not grant control.', EXIT.CONFLICT));
          return;
        }
        attached = true;
        clearTimeout(connectTimer);
        if (!mode.human) process.stdout.write(`${JSON.stringify({ schema: 'o8/cli/terminal.control/v1', event: 'attached', id })}\n`);
        process.stdin.on('data', onInput);
        process.stdin.on('end', stop);
        if (mode.human) {
          if (process.stdin.isTTY) process.stdin.setRawMode(true);
          process.stdout.on('resize', onResize);
        }
        process.stdin.resume();
        return;
      }
      if (frame.event === 'exited' && attached) {
        if (!mode.human) process.stdout.write(`${JSON.stringify({ schema: 'o8/cli/terminal.control/v1', event: 'exited', id })}\n`);
        stop();
        return;
      }
      if (frame.event === 'data' && attached && typeof frame.data.data === 'string') {
        const bytes = Buffer.from(frame.data.data, 'base64');
        if (mode.human) process.stdout.write(bytes);
        else {
          const output = decoder.decode(bytes, { stream: true });
          if (output) process.stdout.write(`${JSON.stringify({ schema: 'o8/cli/terminal.control/v1', event: 'data', id, text: output })}\n`);
        }
      }
    });
    socket.on('error', () => fail(new CliError(
      'connection_refused', 'Could not connect to the o8 terminal host.', EXIT.CONNECTION_REFUSED,
    )));
    socket.on('close', () => {
      if (settled) return;
      fail(new CliError('terminal_disconnected', 'Terminal control disconnected.', EXIT.CONNECTION_REFUSED));
    });
  });
}

function observe(cfg: ResolvedConfig, id: string, mode: OutputMode): Promise<number> {
  const url = new URL('/ws', resolveWsBase(cfg));
  url.searchParams.set('token', cfg.token!);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const decoder = new TextDecoder();
    let attached = false;
    let settled = false;
    const connectTimer = setTimeout(() => fail(new CliError(
      'server_timeout', 'Timed out attaching to the terminal.', EXIT.SERVER_TIMEOUT,
    )), 8_000);
    const cleanup = () => {
      clearTimeout(connectTimer);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      socket.close();
    };
    const fail = (error: CliError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const stop = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(EXIT.OK);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    socket.on('open', () => socket.send(JSON.stringify({
      type: 'terminal-attach', sessionName: id, readOnly: true,
    })));
    socket.on('message', (raw) => {
      let frame: { channel?: string; event?: string; data?: { sessionName?: string; data?: string; error?: string } };
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame.channel !== 'terminal' || frame.data?.sessionName !== id) return;
      if (frame.event === 'error') {
        fail(new CliError('terminal_not_found', frame.data.error ?? 'Terminal unavailable.', EXIT.NOT_FOUND));
        return;
      }
      if (frame.event === 'attached') {
        attached = true;
        clearTimeout(connectTimer);
        if (!mode.human) process.stdout.write(`${JSON.stringify({ schema: 'o8/cli/terminal.observe/v1', event: 'attached', id })}\n`);
        return;
      }
      if (frame.event === 'exited' && attached) {
        if (!mode.human) process.stdout.write(`${JSON.stringify({
          schema: 'o8/cli/terminal.observe/v1', event: 'exited', id,
        })}\n`);
        settled = true;
        cleanup();
        resolve(EXIT.OK);
        return;
      }
      if (frame.event === 'data' && attached && typeof frame.data.data === 'string') {
        const output = decoder.decode(Buffer.from(frame.data.data, 'base64'), { stream: true });
        if (!output) return;
        process.stdout.write(mode.human ? output : `${JSON.stringify({
          schema: 'o8/cli/terminal.observe/v1', event: 'data', id, text: output,
        })}\n`);
      }
    });
    socket.on('error', () => fail(new CliError(
      'connection_refused', 'Could not connect to the o8 terminal host.', EXIT.CONNECTION_REFUSED,
    )));
    socket.on('close', () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new CliError('terminal_disconnected', 'Terminal observation disconnected.', EXIT.CONNECTION_REFUSED));
    });
  });
}

/** The command that starts this same CLI, for a child process or a pane. */
function selfCommand(): string[] {
  const script = process.argv[1];
  if (!script) throw new CliError('invalid_args', 'Could not work out how to start o8 again.', EXIT.INVALID_ARGS);
  return [process.execPath, script];
}

/** Live session IDs on a saved SSH machine, read through this same CLI. */
function listRemoteSessionIds(machineKey: string): string[] {
  const [file, ...args] = selfCommand();
  let raw: string;
  try {
    raw = execFileSync(file, [...args, 'terminal', 'list', '--machine', machineKey], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // The child prints the same structured error this CLI would. Pass it on.
    const failed = error as { status?: unknown; stderr?: unknown };
    let remote: { code?: unknown; message?: unknown; hint?: unknown } | undefined;
    try {
      remote = (JSON.parse(String(failed.stderr ?? '')) as { error?: typeof remote }).error;
    } catch { /* fall through to the generic error */ }
    const exit = (Object.values(EXIT) as number[]).includes(failed.status as number)
      ? failed.status as typeof EXIT.CONFLICT : EXIT.CONFLICT;
    // The text may come from the remote host. Keep it one plain, bounded line.
    const plain = (value: unknown) => typeof value === 'string'
      ? value.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim().slice(0, 400) : '';
    throw new CliError(
      typeof remote?.code === 'string' && /^[a-z_]{1,64}$/.test(remote.code) ? remote.code : 'remote_terminal_error',
      plain(remote?.message) || 'Could not list terminals on that SSH machine.',
      exit,
      plain(remote?.hint) || undefined,
    );
  }
  try {
    const payload = JSON.parse(raw) as { sessions?: Array<{ id?: unknown }> };
    return (payload.sessions ?? []).flatMap((session) => typeof session.id === 'string' ? [session.id] : []);
  } catch {
    throw new CliError('invalid_remote_response', 'That SSH machine returned an invalid terminal inventory.', EXIT.CONFLICT);
  }
}

async function runTerminalPanes(mode: OutputMode, rest: string[]): Promise<number> {
  const { limit, machineKey } = parsePanesArgs(rest);
  // Both paths need the local operator credential before anything is listed or opened.
  const cfg = operatorConfig();
  const workers = machineKey ? { terminals: [], failed: false } : await listWorkerTerminals(cfg);
  const workerIds = new Set(workers.terminals.map((worker) => worker.id));
  const shellIds = machineKey ? listRemoteSessionIds(machineKey) : (await listSessions(cfg)).map((session) => session.id);
  const packets = machineKey ? { terminals: [], failed: false } : await listRunningPackets(cfg);
  // Work first, so a short limit shows agents before idle shells. A worker keeps its own title.
  const terminals = [
    ...packets.terminals,
    ...workers.terminals,
    ...shellIds.filter((id) => !workerIds.has(id)).map((id) => ({ id, title: 'shell' })),
  ];
  const warnings = [
    ...(packets.failed ? ['Could not list running packets.'] : []),
    ...(workers.failed ? ['Could not list worker terminals.'] : []),
  ];
  const started = openTerminalPanes({ terminals, limit, machineKey, env: process.env, self: selfCommand() });
  // Give each observer a moment to attach, then report any pane that is already gone.
  if (started.opened.length > 0) await new Promise((resolve) => setTimeout(resolve, 1500));
  const result = confirmOpenedPanes(started, process.env);
  if (mode.human) {
    const lines = [
      ...result.opened.map((pane) => `opened    ${pane.id}`),
      ...result.closed.map((id) => `closed    ${id}`),
      ...result.existing.map((id) => `existing  ${id}`),
      ...result.remaining.map((id) => `not shown ${id}`),
      ...result.skipped.map(() => 'skipped   (session ID is unsafe or too long to label)'),
      ...warnings.map((warning) => `warning   ${warning}`),
      ...(result.error ? [`error     ${result.error}`] : []),
    ];
    process.stdout.write(lines.length ? `${lines.join('\n')}\n` : 'No running packets or live terminals.\n');
  } else {
    printJson({ schema: 'o8/cli/terminal.panes/v1', ...result, warnings });
  }
  return result.error ? EXIT.CONFLICT : EXIT.OK;
}

/** Add or remove the Rex action that opens the terminals tab. It only edits Rex's config. */
function runTerminalShortcut(mode: OutputMode, rest: string[]): number {
  const { key, remove } = parseShortcutArgs(rest);
  const result = remove
    ? removeShortcut({ env: process.env })
    : installShortcut({ self: selfCommand(), key, env: process.env });
  if (mode.human) {
    const lines = result.action === 'installed'
      ? [
        `Added "Show o8 Terminals" to Rex${result.key ? `, bound to ${result.key}` : ''}.`,
        `Find it in the Rex command palette, or run \`rex do o8_terminals\`.`,
        `File: ${result.file}`,
      ]
      : result.action === 'removed'
        ? ['Removed "Show o8 Terminals" from Rex.']
        : ['The Rex shortcut is not installed.'];
    if (result.hint) lines.push(result.hint);
    process.stdout.write(`${lines.join('\n')}\n`);
  } else {
    printJson({ schema: 'o8/cli/terminal.shortcut/v1', ...result });
  }
  return EXIT.OK;
}

export async function runTerminal(mode: OutputMode, sub: string | undefined, rest: string[]): Promise<number> {
  if (!['list', 'show', 'observe', 'control', 'wait', 'panes', 'shortcut'].includes(sub ?? '')) {
    throw new CliError('invalid_args', 'Use `o8 terminal list|show|observe|control|wait|panes|shortcut`.', EXIT.INVALID_ARGS);
  }
  if (sub === 'panes') return runTerminalPanes(mode, rest);
  if (sub === 'shortcut') return runTerminalShortcut(mode, rest);
  const machineAt = rest.indexOf('--machine');
  if (machineAt >= 0) {
    const key = rest[machineAt + 1];
    if (!key || rest.lastIndexOf('--machine') !== machineAt) {
      throw new CliError('invalid_args', 'Use exactly one `--machine <label-or-id>`.', EXIT.INVALID_ARGS);
    }
    const localRest = rest.filter((_, index) => index !== machineAt && index !== machineAt + 1);
    return runRemoteTerminal(mode, sub!, localRest, key);
  }
  const cfg = operatorConfig();
  if (sub === 'list') {
    if (rest.length > 0) throw new CliError('invalid_args', 'terminal list takes no arguments.', EXIT.INVALID_ARGS);
    const sessions = await listSessions(cfg);
    if (mode.human) process.stdout.write(sessions.map((session) => session.id).join('\n') + (sessions.length ? '\n' : ''));
    else printJson({ schema: 'o8/cli/terminal.list/v1', sessions });
    return EXIT.OK;
  }
  const id = rest[0]?.trim();
  if (!id) throw new CliError('invalid_args', `terminal ${sub} requires an exact session ID.`, EXIT.INVALID_ARGS);
  if (sub === 'wait') {
    let match: string | null = null;
    let timeoutMs = 30_000;
    if ((rest.length - 1) % 2 !== 0) {
      throw new CliError('invalid_args', 'Use `terminal wait <id> --match <text> [--timeout ms]`.', EXIT.INVALID_ARGS);
    }
    for (let i = 1; i < rest.length; i += 2) {
      if (rest[i] === '--match' && match === null) match = rest[i + 1];
      else if (rest[i] === '--timeout' && /^\d+$/.test(rest[i + 1] ?? '')) timeoutMs = Number(rest[i + 1]);
      else throw new CliError('invalid_args', 'Use one --match and optional --timeout.', EXIT.INVALID_ARGS);
    }
    if (!match || match.length > 256 || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1 || timeoutMs > 600_000) {
      throw new CliError('invalid_args', '--match must be 1..256 characters and --timeout 1..600000 ms.', EXIT.INVALID_ARGS);
    }
    await requireLiveSession(cfg, id);
    return waitForTerminalOutput(cfg, id, match, timeoutMs, mode);
  }
  if (sub === 'observe' || sub === 'control') {
    const filterProbeReplies = sub === 'control' && rest.length === 2 && rest[1] === '--filter-probe-replies';
    if (rest.length !== 1 && !filterProbeReplies) throw new CliError('invalid_args', `terminal ${sub} takes one session ID.`, EXIT.INVALID_ARGS);
    await requireLiveSession(cfg, id, sub === 'observe');
    return sub === 'control' ? control(cfg, id, mode, filterProbeReplies) : observe(cfg, id, mode);
  }
  let lines = 200;
  if (rest.length > 1) {
    if (rest.length !== 3 || rest[1] !== '--lines' || !/^\d+$/.test(rest[2] ?? '')) {
      throw new CliError('invalid_args', 'Use `terminal show <id> [--lines 1..1000]`.', EXIT.INVALID_ARGS);
    }
    lines = Number(rest[2]);
  }
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > 1000) {
    throw new CliError('invalid_args', '--lines must be between 1 and 1000.', EXIT.INVALID_ARGS);
  }
  await requireLiveSession(cfg, id);
  const url = terminalUrl(cfg, '/terminal-snapshot');
  url.searchParams.set('sessionName', id);
  url.searchParams.set('lines', String(lines));
  const snapshot = await terminalGet<{ session: TerminalSession; text: string }>(cfg, url);
  if (mode.human) process.stdout.write(snapshot.text);
  else printJson({ schema: 'o8/cli/terminal.show/v1', ...snapshot });
  return EXIT.OK;
}
