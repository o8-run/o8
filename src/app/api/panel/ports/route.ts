export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { serverTimingHeaders } from '@/lib/performance/server-timing';
import { execFileReadOnly } from '@/lib/providers/child-process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { classifyProbe, deriveServerLabel, type HttpProbeResult, type PortKind } from '@/lib/panel/port-classify';
import { getDataDir } from '@/lib/data-dir-migration';

interface PortEntry {
  port: number;
  pid: number;
  process: string;
  /** Human label ("Next.js", "Vite", "Python http.server", …). */
  label: string;
  cwd: string;
  repo: string | null;
  /** page = openable web page (2xx html / redirect) · service = everything else. */
  kind: PortKind;
}

interface PortGroup {
  repo: string;
  repoPath: string;
  ports: number[];
}

// ── Response cache (ports don't change fast enough to scan every request) ──
let portsCache: { data: unknown; ts: number } | null = null;
const PORTS_CACHE_TTL_MS = 10_000; // 10s cache — ports don't change every second
// One scan at a time: requests that miss the cache together share it.
let scanning: Promise<unknown> | null = null;
// A listening process keeps its cwd and command line, so each pid is resolved once.
const processByPid = new Map<number, { process: string; cwd: string; command: string }>();

const execFileAsync = promisify(execFileReadOnly);

/** Runs a read-only tool without blocking the event loop; a non-zero exit still yields its output. */
async function readTool(file: string, args: string[], timeout: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(file, args, { windowsHide: true, encoding: 'utf-8', timeout });
    return String(stdout).trim();
  } catch (err) {
    const stdout = (err as { stdout?: unknown }).stdout;
    if (typeof stdout === 'string' && stdout.trim()) return stdout.trim();
    throw err;
  }
}

// Well-known system ports to ignore
const IGNORE_PORTS = new Set([22, 53, 80, 443, 631, 5000, 5353, 7000]);
const IGNORE_PROCESSES = new Set([
  'rapportd', 'mDNSResponder', 'systemd', 'launchd', 'loginwindow', 'WindowServer',
  'Google Drive', 'CinemaGradeHelper', 'sharingd', 'replicatord', 'identityservicesd',
  'ControlCenter', 'Finder', 'AirPlayXPCHelper', 'WiFiAgent', 'bluetoothd',
]);

// Known dev runtimes + infra whose non-page listeners are still worth showing
// under the collapsed "N more services" toggle (a project API server, a local
// database). Everything else that isn't a page is dropped as pure noise.
const DEV_PROCESSES = new Set(['node', 'next-server', 'tsx', 'bun', 'deno', 'python', 'Python', 'python3', 'go', 'cargo', 'ruby', 'java', 'uvicorn', 'gunicorn', 'flask']);
const INFRA_PROCESSES = ['postgres', 'postmaster', 'redis', 'mysqld', 'mariadbd', 'mongod', 'memcached', 'elasticsearch', 'rabbitmq', 'etcd', 'clickhouse'];

// o8's own machinery, matched on the command line (NOT a hardcoded port) so the
// app never lists its own MCP bridges, WebSocket server, or bundled Next server
// as if they were the operator's dev servers.
const O8_INFRA_COMMAND = /operator-mcp-server|cortex-mcp-server|tauri-plugin-mcp|openclaw|ws-server(\.mjs)?\b|[/\\]out[/\\]server[/\\]server\.js/i;

// Browsers answer their remote-debug ports (e.g. Chrome :9222) with an HTML
// page — a probe would tag them "page", but they're never a dev server the
// operator wants to open. Excluded by process identity, not by port.
const NON_DEV_PROCESS = /google chrome|chromium|firefox|safari|microsoft edge|\bbrave\b|\bopera\b|\barc\b/i;

function o8DataDir(): string {
  return getDataDir();
}

function readPortFile(name: string): number | null {
  try {
    const p = join(o8DataDir(), name);
    if (!existsSync(p)) return null;
    const n = parseInt(readFileSync(p, 'utf-8').trim(), 10);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
  } catch { return null; }
}

function intEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function portFromUrl(url: string | undefined): number | null {
  if (!url) return null;
  try {
    const n = parseInt(new URL(url).port, 10);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
  } catch { return null; }
}

/**
 * Every port that belongs to o8 itself — the API/frontend port, the WebSocket
 * port, and (in dev-bridge mode) the separate dev-server frontend. Resolved
 * dynamically from the api-port helpers, the `~/.o8` port files, and env vars —
 * never hardcoded — because the app's own frontend serves HTML and would
 * otherwise show up as an openable "dev server."
 */
function resolveO8OwnPorts(): Set<number> {
  const own = new Set<number>();
  const add = (n: number | null | undefined) => { if (typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 65536) own.add(n); };
  try {
    const info = resolvePortInfo();
    add(info.apiPort);
    add(info.wsPort);
  } catch { /* fall through to file/env resolution */ }
  add(readPortFile('api-port'));
  add(readPortFile('ws-port'));
  add(intEnv('O8_API_PORT'));
  add(intEnv('O8_WS_PORT'));
  add(intEnv('PORT'));
  add(intEnv('WS_PORT'));
  add(intEnv('CORTEX_IDE_PORT'));
  add(portFromUrl(process.env.O8_DEV_FRONTEND_URL));
  return own;
}

/**
 * Fast loopback HTTP probe. Reads only the response headers (body is cancelled)
 * so the classify decision stays under ~400ms even for slow dev servers.
 */
async function probePort(port: number): Promise<HttpProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 400);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'user-agent': 'o8-port-probe' },
    });
    const contentType = res.headers.get('content-type');
    try { await res.body?.cancel(); } catch { /* body already consumed */ }
    return { reachable: true, status: res.status, contentType };
  } catch {
    return { reachable: false, status: null, contentType: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  const startedAt = performance.now();
  if (portsCache && (Date.now() - portsCache.ts) < PORTS_CACHE_TTL_MS) {
    return NextResponse.json(portsCache.data, { headers: serverTimingHeaders(startedAt) });
  }
  scanning ??= scanPorts().finally(() => { scanning = null; });
  return NextResponse.json(await scanning, { headers: serverTimingHeaders(startedAt) });
}

async function scanPorts(): Promise<unknown> {
  try {
    const raw = await readTool('lsof', ['-i', '-P', '-n', '-sTCP:LISTEN', '-F', 'pcn'], 5000);

    // Parse lsof output (field mode: p=pid, c=command, n=name).
    interface RawEntry { port: number; pid: number; process: string; cwd: string; command: string; repo: string | null }
    const entries: RawEntry[] = [];
    let currentPid = 0;
    let currentProcess = '';

    for (const line of raw.split('\n')) {
      if (line.startsWith('p')) {
        currentPid = parseInt(line.slice(1), 10);
      } else if (line.startsWith('c')) {
        currentProcess = line.slice(1);
      } else if (line.startsWith('n')) {
        const match = line.match(/:(\d+)$/);
        if (!match) continue;
        const port = parseInt(match[1], 10);
        if (IGNORE_PORTS.has(port)) continue;
        if (IGNORE_PROCESSES.has(currentProcess)) continue;
        if (port < 1024 && currentProcess !== 'node') continue;
        // Dedup the same process double-binding IPv4 + IPv6 on one (pid, port).
        if (!entries.some(e => e.pid === currentPid && e.port === port)) {
          entries.push({ port, pid: currentPid, process: currentProcess, cwd: '', command: '', repo: null });
        }
      }
    }

    // Drop o8's own web ports up front — the app's own UI is never a dev server.
    const o8OwnPorts = resolveO8OwnPorts();
    let candidates = entries.filter(e => !o8OwnPorts.has(e.port));

    // Resolve CWD + full command line in two batched calls, only for pids not seen before.
    const uniquePids = [...new Set(candidates.map(e => e.pid))];
    for (const pid of processByPid.keys()) if (!uniquePids.includes(pid)) processByPid.delete(pid);
    // A reused pid shows up under a different process name and is looked up again.
    const processOf = new Map(candidates.map(e => [e.pid, e.process]));
    const newPids = uniquePids.filter(pid => processByPid.get(pid)?.process !== processOf.get(pid));
    if (newPids.length > 0) {
      const pidList = newPids.join(',');
      const cwdByPid = new Map<number, string>();
      try {
        const cwdRaw = await readTool('lsof', ['-p', pidList, '-a', '-d', 'cwd', '-Fn'], 3000);
        let pid = 0;
        for (const line of cwdRaw.split('\n')) {
          if (line.startsWith('p')) pid = parseInt(line.slice(1), 10);
          else if (line.startsWith('n') && pid) cwdByPid.set(pid, line.slice(1));
        }
      } catch { /* CWD resolution failed — entries keep empty cwd */ }

      const cmdByPid = new Map<number, string>();
      try {
        const psRaw = await readTool('ps', ['-o', 'pid=,command=', '-p', pidList], 3000);
        for (const line of psRaw.split('\n')) {
          const m = line.trim().match(/^(\d+)\s+(.*)$/);
          if (m) cmdByPid.set(parseInt(m[1], 10), m[2]);
        }
      } catch { /* command resolution failed — labels fall back to process name */ }

      for (const entry of candidates) {
        entry.cwd = cwdByPid.get(entry.pid) ?? '';
        entry.command = cmdByPid.get(entry.pid) ?? '';
      }
      // Remember only complete answers so a failed lookup is retried on the next scan.
      for (const pid of newPids) {
        const cwd = cwdByPid.get(pid);
        const command = cmdByPid.get(pid);
        if (cwd !== undefined && command !== undefined) processByPid.set(pid, { process: processOf.get(pid) ?? '', cwd, command });
      }
    }
    for (const entry of candidates) {
      const known = processByPid.get(entry.pid);
      if (known?.process === entry.process) { entry.cwd = known.cwd; entry.command = known.command; }
    }

    // Drop o8's own MCP bridges / WS server / bundled server (by command
    // signature) and browsers' remote-debug ports (by process identity).
    candidates = candidates.filter(e =>
      !O8_INFRA_COMMAND.test(`${e.process} ${e.command}`) && !NON_DEV_PROCESS.test(e.process));

    // Attribute each port to a registered repo by CWD (longest path wins).
    let repos: { name: string; localPath: string }[] = [];
    try {
      const repoData = JSON.parse(readFileSync(join(getDataDir(), 'repos.json'), 'utf-8'));
      repos = (Array.isArray(repoData) ? repoData : repoData.repos ?? []).map(
        (r: { name?: string; localPath?: string }) => ({ name: r.name ?? '', localPath: r.localPath ?? '' }),
      );
    } catch { /* no repo registry */ }
    const sortedRepos = [...repos].sort((a, b) => b.localPath.length - a.localPath.length);
    for (const entry of candidates) {
      if (!entry.cwd) continue;
      for (const repo of sortedRepos) {
        if (repo.localPath && entry.cwd.startsWith(repo.localPath)) { entry.repo = repo.name; break; }
      }
    }

    // Probe every candidate in parallel → page vs service.
    const kinds = await Promise.all(candidates.map(e => probePort(e.port)));
    const classified: PortEntry[] = candidates.map((e, i) => ({
      port: e.port,
      pid: e.pid,
      process: e.process,
      label: deriveServerLabel(e.process, e.command),
      cwd: e.cwd,
      repo: e.repo,
      kind: classifyProbe(kinds[i]),
    }));

    // Pages: every openable web page. Services: only dev/infra-relevant listeners
    // (a project API server, a local database) — never random OS daemons.
    const isRelevantService = (e: PortEntry) =>
      e.repo !== null
      || DEV_PROCESSES.has(e.process)
      || INFRA_PROCESSES.some(p => e.process.toLowerCase().includes(p));
    const shown = classified.filter(e => e.kind === 'page' || isRelevantService(e));

    // One row per port number for the UI (prefer a page when two processes collide).
    const byPort = new Map<number, PortEntry>();
    for (const entry of shown) {
      const existing = byPort.get(entry.port);
      if (!existing || (entry.kind === 'page' && existing.kind !== 'page')) byPort.set(entry.port, entry);
    }
    const ports = [...byPort.values()].sort((a, b) => a.port - b.port);

    // Group by repo — consumed by the mobile dev-host typeahead + repo running
    // indicators (kept for backward compatibility with those surfaces).
    const groups: PortGroup[] = [];
    const repoMap = new Map<string, PortGroup>();
    for (const entry of ports) {
      const key = entry.repo ?? entry.cwd ?? 'Unknown';
      if (!repoMap.has(key)) {
        const group: PortGroup = {
          repo: entry.repo ?? (entry.cwd ? entry.cwd.split('/').pop() ?? 'Unknown' : 'Unknown'),
          repoPath: entry.cwd,
          ports: [],
        };
        repoMap.set(key, group);
        groups.push(group);
      }
      repoMap.get(key)!.ports.push(entry.port);
    }
    for (const g of groups) g.ports.sort((a, b) => a - b);

    const pageCount = ports.filter(e => e.kind === 'page').length;
    const result = {
      ports,
      groups,
      pageCount,
      serviceCount: ports.length - pageCount,
      total: ports.length,
    };
    portsCache = { data: result, ts: Date.now() };
    return result;
  } catch (err) {
    return {
      ports: [],
      groups: [],
      pageCount: 0,
      serviceCount: 0,
      total: 0,
      error: err instanceof Error ? err.message : 'Failed to scan ports',
    };
  }
}
