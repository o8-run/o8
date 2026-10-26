#!/usr/bin/env node
import { safeErrorText } from '@/lib/mcp/api-error';
/**
 * o8 Operator MCP Server — stdio JSON-RPC 2.0 server that lets users
 * control o8 from their Claude Code terminal.
 *
 * Spawned as a child process via --mcp-config.
 * Communicates over stdin/stdout with newline-delimited JSON.
 *
 * Environment:
 *   O8_API_BASE — e.g. http://localhost:47100 (default)
 */

// MUST run before shared imports: re-exec onto Node 22 before native addon loads.
import './operator-node22-reexec';

// MUST run before handler imports that may initialize persistent stores.
import './orphan-exit-bootstrap';

// Neutralizes the `server-only` marker for this standalone Node process.
import './neutralize-server-only';

import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFileSync, execSync } from '@/lib/providers/child-process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_API_PORT } from '@/lib/panel/api-port';
import { setApiBase } from '@/lib/mcp/operator-handlers/shared';
import {
  handleOperatorMcpMessage,
  type OperatorMcpRequest as JsonRpcRequest,
  type OperatorMcpResponse as JsonRpcResponse,
} from '@/lib/mcp/operator-mcp-host';
import { getDataDir } from '@/lib/data-dir-migration';
import { modernMcpHttpStatus, prepareMcpHttp } from './operator-mcp-protocol';

const ORPHAN_MIN_AGE_SECONDS = 30;
const OPERATOR_COMMAND_RE = /^(?:\S+\/)?(?:npm|npx|node|tsx)\b.*(?:^|\s)\S*operator-mcp-server\.ts(?:\s|$)/;
type ProcessRow = { pid: number; ppid: number; ageSeconds: number; args: string };

function parseElapsedSeconds(raw: string): number {
  const [dayText, timeText] = raw.includes('-') ? raw.split('-', 2) : ['0', raw];
  const days = Number(dayText);
  const segments = timeText.split(':').map(Number);
  if (!Number.isFinite(days) || segments.length > 3 || segments.some((part) => !Number.isFinite(part))) {
    return -1;
  }
  while (segments.length < 3) segments.unshift(0);
  const [hours = 0, minutes = 0, seconds = 0] = segments;
  return (days * 24 * 60 * 60) + (hours * 60 * 60) + (minutes * 60) + seconds;
}

function listProcessRows(): ProcessRow[] {
  const output = execFileSync('ps', ['-e', '-o', 'pid=,ppid=,etime=,command='], {
    windowsHide: true,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 3000,
  });
  const rows: ProcessRow[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    rows.push({
      pid: parseInt(match[1], 10),
      ppid: parseInt(match[2], 10),
      ageSeconds: parseElapsedSeconds(match[3]),
      args: match[4] || '',
    });
  }
  return rows;
}

function isOperatorMcpCommand(args: string): boolean { return OPERATOR_COMMAND_RE.test(args.trim()); }

function isAncestorPid(pid: number, selfPid: number, rowsByPid: Map<number, ProcessRow>): boolean {
  let currentPid = rowsByPid.get(selfPid)?.ppid ?? process.ppid;
  const seen = new Set<number>();
  while (currentPid > 1 && !seen.has(currentPid)) {
    if (currentPid === pid) return true;
    seen.add(currentPid);
    currentPid = rowsByPid.get(currentPid)?.ppid ?? 0;
  }
  return false;
}

function isDetachedOperatorTree(row: ProcessRow, rowsByPid: Map<number, ProcessRow>): boolean {
  let parentPid = row.ppid;
  const seen = new Set<number>();
  while (parentPid > 1 && !seen.has(parentPid)) {
    seen.add(parentPid);
    const parent = rowsByPid.get(parentPid);
    if (!parent || !isOperatorMcpCommand(parent.args)) return false;
    parentPid = parent.ppid;
  }
  return parentPid === 1;
}

function nodeLabelFromArgs(args: string): string {
  const cellar = args.match(/\/node(?:@[\d.]+)?\/(\d+\.\d+\.\d+(?:_\d+)?)\/bin\/node/)?.[1];
  const nodeAt = args.match(/node@(\d+(?:\.\d+)*)/)?.[1];
  return cellar?.replace(/_/g, '.') ?? (nodeAt ? `node@${nodeAt}` : 'unknown');
}

function killOrphanInstances(): void {
  if (process.env.O8_MCP_NO_ORPHAN_KILL === '1') return;
  try {
    const myPid = process.pid;
    const myParentPid = process.ppid;
    const rows = listProcessRows();
    const rowsByPid = new Map(rows.map((row) => [row.pid, row]));
    const myParentParentPid = rowsByPid.get(myParentPid)?.ppid ?? 0;

    for (const row of rows) {
      if (row.pid === myPid) continue;
      if (!isOperatorMcpCommand(row.args)) continue;
      if (row.ageSeconds < ORPHAN_MIN_AGE_SECONDS) continue;
      if (isAncestorPid(row.pid, myPid, rowsByPid)) continue;
      if (row.ppid === myParentPid) continue;
      if (myParentParentPid > 1 && row.ppid === myParentParentPid) continue;
      if (!isDetachedOperatorTree(row, rowsByPid)) continue;

      try {
        process.kill(row.pid, 'SIGTERM');
        console.error(`[mcp-operator] killed orphan PID ${row.pid} (parent=${row.ppid}, node=${nodeLabelFromArgs(row.args)})`);
        const killTimer = setTimeout(() => {
          try {
            process.kill(row.pid, 0);
            process.kill(row.pid, 'SIGKILL');
          } catch { /* already gone */ }
        }, 2000) as ReturnType<typeof setTimeout> & { unref?: () => void };
        killTimer.unref?.();
      } catch { /* ignore per-process kill failures */ }
    }
  } catch (err) {
    console.error(`[mcp-operator] orphan cleanup failed: ${err}`);
  }
}

// ── Pre-flight diagnostics (run once at startup) ──
// Verifies that the binaries the MCP tools depend on are actually
// installed. Missing binaries don't crash the server — users can still
// call tools that don't need them — but the warnings surface in stderr
// so a broken install fails loudly rather than silently.
function checkBinary(name: string): boolean {
  try {
    execSync(`command -v ${name} 2>/dev/null`, { windowsHide: true, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runPreflightDiagnostics(): void {
  const missing: string[] = [];
  // codex is required for dispatch_mission / create_mission to actually spawn an agent.
  if (!checkBinary('codex')) missing.push('codex');
  // gh is required for create_mission when loading real GitHub issues.
  if (!checkBinary('gh')) missing.push('gh');

  if (missing.length > 0) {
    console.error(
      `[o8-operator] Pre-flight warning: missing binaries on PATH: ${missing.join(', ')}. ` +
      `Tools that depend on them will fail with a clear error. ` +
      `Install with: \`npm i -g @openai/codex\` / \`brew install gh\`.`,
    );
  }
}

// ── Config ──


/**
 * Resolve the backend base URL. Priority:
 *   1. ~/.o8/api-port file (always reflects the running app — survives port
 *      swaps, dev-frontend mode flips, and stale parent-shell env vars)
 *   2. O8_API_BASE env var (explicit override)
 *   3. O8_API_PORT env var (set by Tauri sidecar at spawn time)
 *   4. Port-block default http://localhost:47100 (sidecar-free workflow)
 *
 * File-first is critical: Claude Code spawns this MCP from a parent shell
 * whose env may have been set before a port change (e.g. operator started
 * Claude Code while prod was on 3001, then the Tauri shell swapped to a
 * dev-frontend URL on 3010 — the parent O8_API_BASE is now stale). The
 * file is updated by the Tauri sidecar on every boot, so it's the only
 * signal that always agrees with the live backend.
 */
function resolveApiBase(): string {
  try {
    const portFile = join(getDataDir(), 'api-port');
    if (existsSync(portFile)) {
      const raw = readFileSync(portFile, 'utf-8').trim();
      const n = parseInt(raw, 10);
      if (Number.isInteger(n) && n > 0 && n < 65536) {
        return `http://127.0.0.1:${n}`;
      }
    }
  } catch { /* fall through */ }
  if (process.env.O8_API_BASE) return process.env.O8_API_BASE;
  if (process.env.O8_API_PORT) {
    return `http://127.0.0.1:${process.env.O8_API_PORT}`;
  }
  return `http://localhost:${DEFAULT_API_PORT}`;
}

const API_BASE = resolveApiBase();
setApiBase(API_BASE);

// Tool definitions and dispatch live in operator-mcp-host.ts so the in-app
// HTTP route and this compatibility entrypoint share one registry.
const buildResponse = handleOperatorMcpMessage;

function send(message: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

// ── Process Resilience ──
// Prevent unhandled rejections from killing the MCP server process.
// The server must survive dev server restarts, transient API failures, etc.
process.on('uncaughtException', (err) => {
  console.error(`[o8-operator] Uncaught exception (survived): ${err.message}`);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[o8-operator] Unhandled rejection (survived): ${reason}`);
});

// ── Transports ──

/** stdio (default): one process per client, spawned via --mcp-config. */
function startStdio(): void {
  // De-dupe stray stdio instances (a per-client-spawn hazard) before serving.
  killOrphanInstances();
  runPreflightDiagnostics();

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch (err) {
      // Malformed JSON-RPC line — log it (a silent drop leaves the client
      // hanging until its own timeout) but keep the server alive.
      console.error(`[o8-operator] Dropped malformed JSON-RPC line (${line.length} bytes): ${err}`);
      return;
    }
    buildResponse(msg)
      .then((resp) => { if (resp) send(resp); })
      .catch((err) => {
        if (msg.id !== undefined && msg.id !== null) {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: safeErrorText(err) } });
        }
      });
  });
  rl.on('close', () => process.exit(0));
}

/** Streamable-HTTP (daemon): ONE shared instance for every client, run under a
 *  launchd KeepAlive agent — the fleet pattern (discord/ugc/playwright). A
 *  plain POST /mcp routes each JSON-RPC message through buildResponse. No
 *  orphan-killing here: the daemon IS the single instance, and culling siblings
 *  would fight launchd. */
function startHttp(port: number): void {
  runPreflightDiagnostics();

  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: 'o8-operator', api: resolveApiBase() }));
      return;
    }
    if (req.method !== 'POST' || path !== '/mcp') {
      res.writeHead(req.method === 'GET' ? 405 : 404);
      res.end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 8 * 1024 * 1024) req.destroy(); // 8MB guard
    });
    req.on('end', () => {
      void (async () => {
        // Follow the LIVE o8 backend port — it shifts across app relaunches /
        // dev-bridge, and a daemon (unlike a per-session stdio spawn) outlives
        // those shifts. resolveApiBase() reads ~/.o8/api-port first.
        setApiBase(resolveApiBase());

        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
          return;
        }

        const protocol = prepareMcpHttp(parsed, new Headers(req.headers as Record<string, string>));
        if (protocol.refusal) {
          res.writeHead(protocol.status ?? 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(protocol.refusal));
          return;
        }
        const batch = Array.isArray(parsed);
        const messages = (batch ? parsed : [parsed]) as JsonRpcRequest[];
        const responses: JsonRpcResponse[] = [];
        for (const message of messages) {
          try {
            const resp = await buildResponse(message);
            if (resp) responses.push(resp);
          } catch (err) {
            if (message && message.id !== undefined && message.id !== null) {
              responses.push({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: safeErrorText(err) } });
            }
          }
        }

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        // A Streamable-HTTP client expects a session id on initialize (a bare
        // reply downgrades some clients to SSE).
        if (!protocol.modern && messages.some((m) => m && m.method === 'initialize')) headers['Mcp-Session-Id'] = randomUUID();

        if (!responses.length) {
          res.writeHead(202, headers);
          res.end();
          return;
        }
        res.writeHead(protocol.modern ? modernMcpHttpStatus(responses[0]) : 200, headers);
        res.end(JSON.stringify(batch ? responses : responses[0]));
      })();
    });
  });

  // A listen/server error (most often EADDRINUSE from a stale instance during
  // a restart) is FATAL — exit so launchd KeepAlive respawns us once the port
  // clears. Without this the global uncaughtException handler would swallow it
  // and leave a zombie (alive but not listening) that KeepAlive never restarts.
  server.on('error', (err) => {
    console.error(`[o8-operator] HTTP server error — exiting for KeepAlive restart: ${err.message}`);
    process.exit(1);
  });

  // Tool calls can be slow (webview eval, merges) — don't let the HTTP layer
  // time them out.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  // Bind 127.0.0.1 EXPLICITLY — defaulting can land on IPv6 ::1 and break IPv4
  // loopback clients (the playwright daemon hit exactly that).
  server.listen(port, '127.0.0.1', () => {
    console.error(`[o8-operator] HTTP transport on http://127.0.0.1:${port}/mcp (api ${resolveApiBase()})`);
  });
}

// ── Entry ──

const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const transport = flagValue('--transport') ?? process.env.O8_MCP_TRANSPORT ?? 'stdio';

if (transport === 'http') {
  const port = Number(flagValue('--port')) || Number(process.env.O8_MCP_PORT) || 18795;
  startHttp(port);
} else {
  startStdio();
}
