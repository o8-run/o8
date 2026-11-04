/**
 * Machine resources — host-wide CPU, load, memory, swap, disk and network for
 * the Resources panel's Machine section.
 *
 * One sampler per server process. A sample is reused for MIN_INTERVAL_MS and
 * concurrent callers share the in-flight read, so any number of panels polling
 * the route cost at most one host read every two seconds. CPU and network are
 * deltas: against the previous sample when it is 1–10 s old, otherwise over a
 * fresh one-second window. Every field is null when its source can't be read.
 *
 * Linux reads /proc and os.*; macOS runs vm_stat, sysctl and netstat. Volumes
 * use statfs on both, the same call the worktree storage code already uses.
 */

import { execFile } from '@/lib/providers/child-process';
import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import { getDataDir } from '@/lib/data-dir-migration';

const execFileAsync = promisify(execFile);

export const MIN_INTERVAL_MS = 2_000;
const CPU_WINDOW_MS = 1_000;
const MAX_BASELINE_AGE_MS = 10_000;

export interface MachineVolume {
  usedBytes: number;
  freeBytes: number;
  totalBytes: number;
}

export interface MachineResources {
  name: 'local';
  platform: string;
  /** Epoch ms when the sample was taken; the panel's sparkline keys on it. */
  sampledAt: number;
  /** Span the CPU and network deltas cover, in ms. */
  windowMs: number | null;
  /** Whole-machine busy percent across all cores (0–100). */
  cpuPercent: number | null;
  loadAverage: [number, number, number] | null;
  cores: number | null;
  memory: { usedBytes: number | null; totalBytes: number | null };
  swap: { usedBytes: number | null; totalBytes: number | null };
  disks: { data: MachineVolume | null; projects: MachineVolume | null };
  network: { inBytesPerSec: number | null; outBytesPerSec: number | null };
}

/** Everything the sampler touches on the host, so tests can feed recorded output. */
export interface MachineIo {
  platform: NodeJS.Platform;
  readFile(path: string): Promise<string>;
  run(command: string, args: string[]): Promise<string>;
  statfs(path: string): Promise<{ bsize: number; blocks: number; bfree: number; bavail: number }>;
  cpus(): Pick<os.CpuInfo, 'times'>[];
  loadavg(): number[];
  now(): number;
  sleep(ms: number): Promise<void>;
  paths(): { data: string; projects: string };
}

interface Counters {
  at: number;
  cpu: { idle: number; total: number } | null;
  net: { rx: number; tx: number } | null;
}

interface SamplerState {
  value: MachineResources | null;
  at: number;
  pending: Promise<MachineResources> | null;
  baseline: Counters | null;
}

const realIo: MachineIo = {
  platform: process.platform,
  readFile: (path) => readFile(path, 'utf8'),
  run: async (command, args) =>
    (await execFileAsync(command, args, { windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 })).stdout,
  statfs: (path) => statfs(path),
  cpus: () => os.cpus(),
  loadavg: () => os.loadavg(),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  paths: () => ({
    data: getDataDir(),
    projects: process.env.CORTEX_IDE_REPO || process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd(),
  }),
};

const memory = globalThis as typeof globalThis & {
  __o8MachineResourcesV1?: { io: MachineIo; state: SamplerState };
};

function sampler() {
  memory.__o8MachineResourcesV1 ??= { io: realIo, state: { value: null, at: 0, pending: null, baseline: null } };
  return memory.__o8MachineResourcesV1;
}

/** Tests swap in recorded host output; `null` restores the real host. */
export function setMachineIoForTests(io: MachineIo | null) {
  memory.__o8MachineResourcesV1 = { io: io ?? realIo, state: { value: null, at: 0, pending: null, baseline: null } };
}

const finite = (value: number) => (Number.isFinite(value) ? value : null);

export function parseLinuxMeminfo(text: string) {
  const kb = (key: string) => {
    const match = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'));
    return match ? Number(match[1]) * 1024 : null;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  const swapTotal = kb('SwapTotal');
  const swapFree = kb('SwapFree');
  return {
    memory: { usedBytes: total != null && available != null ? total - available : null, totalBytes: total },
    swap: { usedBytes: swapTotal != null && swapFree != null ? swapTotal - swapFree : null, totalBytes: swapTotal },
  };
}

/** Sums every interface except loopback. */
export function parseLinuxNetDev(text: string) {
  let rx = 0;
  let tx = 0;
  let seen = false;
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([^:\s]+):\s*(.*)$/);
    if (!match || match[1] === 'lo') continue;
    const fields = match[2]!.trim().split(/\s+/).map(Number);
    if (fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) continue;
    rx += fields[0]!;
    tx += fields[8]!;
    seen = true;
  }
  return seen ? { rx, tx } : null;
}

/** App, wired and compressed pages, the same "Memory Used" the system monitor shows. */
export function parseDarwinVmStat(text: string) {
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  const pages = (label: string) => {
    const match = text.match(new RegExp(`^${label}:\\s+(\\d+)\\.?`, 'm'));
    return match ? Number(match[1]) : null;
  };
  const anonymous = pages('Anonymous pages');
  const purgeable = pages('Pages purgeable') ?? 0;
  const wired = pages('Pages wired down');
  const compressed = pages('Pages occupied by compressor') ?? 0;
  if (!Number.isFinite(pageSize) || anonymous == null || wired == null) return null;
  return (Math.max(0, anonymous - purgeable) + wired + compressed) * pageSize;
}

const UNIT: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** `sysctl hw.memsize vm.swapusage` output. */
export function parseDarwinSysctl(text: string) {
  const total = Number(text.match(/^hw\.memsize:\s*(\d+)/m)?.[1]);
  const size = (key: string) => {
    const match = text.match(new RegExp(`${key} = ([\\d.]+)([KMGT])`));
    return match ? Math.round(Number(match[1]) * UNIT[match[2]!]!) : null;
  };
  return {
    totalBytes: Number.isFinite(total) && total > 0 ? total : null,
    swap: { usedBytes: size('used'), totalBytes: size('total') },
  };
}

/** `netstat -ibn`: link rows only (one per interface), loopback excluded. */
export function parseDarwinNetstat(text: string) {
  let rx = 0;
  let tx = 0;
  let seen = false;
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10 || !parts[2]?.startsWith('<Link#') || parts[0]!.startsWith('lo')) continue;
    // Address may be blank, so read the counters from the right.
    const inBytes = Number(parts[parts.length - 5]);
    const outBytes = Number(parts[parts.length - 2]);
    if (!Number.isFinite(inBytes) || !Number.isFinite(outBytes)) continue;
    rx += inBytes;
    tx += outBytes;
    seen = true;
  }
  return seen ? { rx, tx } : null;
}

function cpuTimes(io: MachineIo) {
  const cpus = io.cpus();
  if (!cpus.length) return null;
  let idle = 0;
  let total = 0;
  for (const { times } of cpus) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

async function netCounters(io: MachineIo) {
  try {
    return io.platform === 'darwin'
      ? parseDarwinNetstat(await io.run('netstat', ['-ibn']))
      : parseLinuxNetDev(await io.readFile('/proc/net/dev'));
  } catch {
    return null;
  }
}

async function counters(io: MachineIo): Promise<Counters> {
  const net = await netCounters(io);
  return { at: io.now(), cpu: cpuTimes(io), net };
}

async function memoryAndSwap(io: MachineIo): Promise<Pick<MachineResources, 'memory' | 'swap'>> {
  if (io.platform === 'darwin') {
    const [vm, sysctl] = await Promise.all([
      io.run('vm_stat', []).then(parseDarwinVmStat, () => null),
      io.run('sysctl', ['hw.memsize', 'vm.swapusage']).then(parseDarwinSysctl, () => null),
    ]);
    return {
      memory: { usedBytes: vm, totalBytes: sysctl?.totalBytes ?? null },
      swap: sysctl?.swap ?? { usedBytes: null, totalBytes: null },
    };
  }
  try {
    return parseLinuxMeminfo(await io.readFile('/proc/meminfo'));
  } catch {
    return { memory: { usedBytes: null, totalBytes: null }, swap: { usedBytes: null, totalBytes: null } };
  }
}

async function volume(io: MachineIo, path: string): Promise<MachineVolume | null> {
  try {
    const stat = await io.statfs(path);
    const totalBytes = stat.blocks * stat.bsize;
    if (!(totalBytes > 0)) return null;
    return { totalBytes, usedBytes: (stat.blocks - stat.bfree) * stat.bsize, freeBytes: stat.bavail * stat.bsize };
  } catch {
    return null;
  }
}

async function take(io: MachineIo, state: SamplerState): Promise<MachineResources> {
  const now = io.now();
  let base = state.baseline;
  if (!base || now - base.at < CPU_WINDOW_MS || now - base.at > MAX_BASELINE_AGE_MS) {
    base = await counters(io);
    await io.sleep(CPU_WINDOW_MS);
  }
  const paths = io.paths();
  const [current, mem, data, projects] = await Promise.all([
    counters(io),
    memoryAndSwap(io),
    volume(io, paths.data),
    volume(io, paths.projects),
  ]);
  state.baseline = current;
  const windowMs = current.at - base.at;
  const seconds = windowMs / 1000;
  let cpuPercent: number | null = null;
  if (base.cpu && current.cpu && current.cpu.total > base.cpu.total) {
    const busy = 1 - (current.cpu.idle - base.cpu.idle) / (current.cpu.total - base.cpu.total);
    cpuPercent = Math.round(Math.min(1, Math.max(0, busy)) * 1000) / 10;
  }
  const rate = (from: number | undefined, to: number | undefined) =>
    from != null && to != null && to >= from && seconds > 0 ? Math.round((to - from) / seconds) : null;
  const load = io.loadavg().map(finite);
  const cores = io.cpus().length;
  return {
    name: 'local',
    platform: io.platform,
    sampledAt: current.at,
    windowMs: windowMs > 0 ? windowMs : null,
    cpuPercent,
    loadAverage: load.length === 3 && load.every((n) => n != null) ? (load as [number, number, number]) : null,
    cores: cores > 0 ? cores : null,
    memory: mem.memory,
    swap: mem.swap,
    disks: { data, projects },
    network: { inBytesPerSec: rate(base.net?.rx, current.net?.rx), outBytesPerSec: rate(base.net?.tx, current.net?.tx) },
  };
}

/** The cached machine sample; reads the host at most once per MIN_INTERVAL_MS. */
export function sampleMachineResources(): Promise<MachineResources> {
  const { io, state } = sampler();
  if (state.pending) return state.pending;
  if (state.value && io.now() - state.at < MIN_INTERVAL_MS) return Promise.resolve(state.value);
  const pending = take(io, state)
    .then((value) => {
      state.value = value;
      state.at = io.now();
      return value;
    })
    .finally(() => {
      if (state.pending === pending) state.pending = null;
    });
  state.pending = pending;
  return pending;
}
