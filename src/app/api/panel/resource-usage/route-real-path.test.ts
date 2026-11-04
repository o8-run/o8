import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineIo } from '@/lib/lane/machine-resources';

vi.mock('server-only', () => ({}));
// The per-session sweep has its own coverage; this file exercises the machine block.
vi.mock('@/lib/lane/resource-attribution', () => ({
  collectResourceUsage: vi.fn(async () => ({ sessions: [], processes: [], total: { cpuPercent: 0, memBytes: 0, ramTotalBytes: 1 } })),
  killResourceRow: vi.fn(),
}));

const route = await import('./route');
const { setMachineIoForTests } = await import('@/lib/lane/machine-resources');
const fixture = (name: string) =>
  readFileSync(join(process.cwd(), 'src/lib/lane/__fixtures__/machine-resources', name), 'utf8');
const GB = 1024 ** 3;

/** Recorded host output, a fake clock, and a CPU that is 30% busy over any window. */
function host(platform: 'linux' | 'darwin') {
  let now = 0;
  const calls: string[] = [];
  const io: MachineIo = {
    platform,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    cpus: () => Array.from({ length: 2 }, () => ({ times: { user: 100 + 0.2 * now, nice: 0, sys: 50 + 0.1 * now, idle: 850 + 0.7 * now, irq: 0 } })),
    loadavg: () => [1.5, 1.25, 0.75],
    paths: () => ({ data: '/data', projects: '/projects' }),
    statfs: async (path) => path === '/data'
      ? { bsize: 4096, blocks: (500 * GB) / 4096, bfree: (200 * GB) / 4096, bavail: (180 * GB) / 4096 }
      : { bsize: 4096, blocks: (2000 * GB) / 4096, bfree: (1500 * GB) / 4096, bavail: (1500 * GB) / 4096 },
    readFile: async (path) => {
      calls.push(path);
      if (path === '/proc/meminfo') return fixture('linux-meminfo.txt');
      if (path === '/proc/net/dev') return fixture(now < 1000 ? 'linux-net-dev-0.txt' : 'linux-net-dev-1.txt');
      throw new Error(`unexpected read ${path}`);
    },
    run: async (command) => {
      calls.push(command);
      if (command === 'vm_stat') return fixture('darwin-vm_stat.txt');
      if (command === 'sysctl') return fixture('darwin-sysctl.txt');
      if (command === 'netstat') return fixture(now < 1000 ? 'darwin-netstat-0.txt' : 'darwin-netstat-1.txt');
      throw new Error(`unexpected command ${command}`);
    },
  };
  return { io, calls, advance: (ms: number) => { now += ms; } };
}

async function machine() {
  const response = await route.GET();
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.sessions).toEqual([]);
  return body.machine;
}

beforeEach(() => setMachineIoForTests(null));
afterAll(() => setMachineIoForTests(null));

describe('GET /api/panel/resource-usage machine block', () => {
  it('reports Linux CPU, load, memory, swap, both volumes and network from /proc and os', async () => {
    setMachineIoForTests(host('linux').io);
    expect(await machine()).toEqual({
      name: 'local',
      platform: 'linux',
      sampledAt: 1000,
      windowMs: 1000,
      cpuPercent: 30,
      loadAverage: [1.5, 1.25, 0.75],
      cores: 2,
      memory: { usedBytes: (16477348 - 13269900) * 1024, totalBytes: 16477348 * 1024 },
      swap: { usedBytes: 0, totalBytes: 0 },
      disks: {
        data: { totalBytes: 500 * GB, usedBytes: 300 * GB, freeBytes: 180 * GB },
        projects: { totalBytes: 2000 * GB, usedBytes: 500 * GB, freeBytes: 1500 * GB },
      },
      // eth0 only: loopback is excluded and the ifb devices were idle.
      network: { inBytesPerSec: 675283238 - 675274304, outBytesPerSec: 7829001 - 7823559 },
    });
  });

  it('reports macOS memory from vm_stat, swap from sysctl and network from netstat link rows', async () => {
    setMachineIoForTests(host('darwin').io);
    const body = await machine();
    expect(body).toMatchObject({
      platform: 'darwin',
      cpuPercent: 30,
      memory: { usedBytes: (393283 - 9214 + 131276 + 160742) * 16384, totalBytes: 16 * GB },
      swap: { usedBytes: 1843.25 * 1024 ** 2, totalBytes: 3072 * 1024 ** 2 },
      // en0 + utun0 link rows; lo0 and the per-address rows are not counted.
      network: { inBytesPerSec: 4_000_000 + 1000, outBytesPerSec: 400_000 + 1000 },
    });
  });

  it('samples at most once per two seconds, shares one read between callers, and deltas from the last sample', async () => {
    const linux = host('linux');
    setMachineIoForTests(linux.io);
    const [first, second] = await Promise.all([machine(), machine()]);
    expect(second).toEqual(first);
    const reads = linux.calls.length;
    linux.advance(1500);
    expect(await machine()).toEqual(first);
    expect(linux.calls.length).toBe(reads);
    linux.advance(600);
    const next = await machine();
    expect(linux.calls.length).toBeGreaterThan(reads);
    // The previous sample is the baseline, so no extra one-second wait.
    expect(next).toMatchObject({ sampledAt: 3100, windowMs: 2100, cpuPercent: 30, network: { inBytesPerSec: 0, outBytesPerSec: 0 } });
  });

  it('answers with machine null when a host read stalls, then samples again', async () => {
    vi.useFakeTimers();
    try {
      const linux = host('linux');
      let stalled = true;
      setMachineIoForTests({
        ...linux.io,
        statfs: (path) => (stalled ? new Promise(() => {}) : linux.io.statfs(path)),
      });
      const response = route.GET();
      await vi.advanceTimersByTimeAsync(5_000);
      const body = await (await response).json();
      expect(body.machine).toBeNull();
      expect(body.sessions).toEqual([]);
      stalled = false;
      linux.advance(3_000);
      const next = route.GET();
      await vi.advanceTimersByTimeAsync(0);
      expect((await (await next).json()).machine).toMatchObject({ cpuPercent: 30 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count container and bridge links on top of the physical interface', async () => {
    const { parseLinuxNetDev } = await import('@/lib/lane/machine-resources');
    const counters = (rx: number, tx: number) => `${rx} 1 0 0 0 0 0 0 ${tx} 1 0 0 0 0 0 0`;
    expect(parseLinuxNetDev([
      'Inter-|   Receive', ' face |bytes',
      `  eth0: ${counters(1000, 500)}`, `docker0: ${counters(400, 300)}`, `vethab12: ${counters(400, 300)}`,
      `br-1f2e: ${counters(400, 300)}`, `    lo: ${counters(9999, 9999)}`, `wlan0: ${counters(10, 5)}`,
    ].join('\n'))).toEqual({ rx: 1010, tx: 505 });
  });

  it('keeps the route answering with null fields when the host cannot be read', async () => {
    const linux = host('linux');
    setMachineIoForTests({
      ...linux.io,
      cpus: () => [],
      loadavg: () => [],
      readFile: async () => { throw new Error('denied'); },
      statfs: async () => { throw new Error('gone'); },
    });
    expect(await machine()).toMatchObject({
      cpuPercent: null,
      loadAverage: null,
      cores: null,
      memory: { usedBytes: null, totalBytes: null },
      swap: { usedBytes: null, totalBytes: null },
      disks: { data: null, projects: null },
      network: { inBytesPerSec: null, outBytesPerSec: null },
    });
  });
});
