import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let resting = true;
vi.mock('./idle-gate', () => ({ idleGateResting: () => resting }));

const { evaluatePark, parkBlockers, parkReport, resetParkReport, startParkReport } = await import('./park-report');

const AFTER_MS = 5 * 60_000;
let dir: string;
let launcher: Server;
let received: string[];
let reply: string;

beforeEach(async () => {
  resetParkReport();
  resting = true;
  received = [];
  reply = JSON.stringify({ ok: true, state: 'parking' });
  dir = mkdtempSync(join(tmpdir(), 'o8-park-'));
  const socket = join(dir, 'launcher.sock');
  launcher = createServer((peer) => {
    let bytes = '';
    peer.on('data', (chunk) => { bytes += chunk.toString(); });
    peer.on('end', () => { received.push(bytes); peer.end(`${reply}\n`); });
  });
  await new Promise<void>((resolve) => launcher.listen(socket, resolve));
  vi.stubEnv('O8_LAUNCHER_SOCKET', socket);
  vi.stubEnv('O8_PARK_NODE', '1');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  resetParkReport();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => launcher.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

async function settle(): Promise<void> {
  await vi.waitFor(() => expect(parkReport().lastRequest).not.toBeNull());
}

it('asks the launcher to park only after everything has been clear for the full period', async () => {
  let terminal: string | null = 'terminal not backed by tmux';
  startParkReport({ terminals: () => terminal });
  const t0 = 1_000_000;

  evaluatePark(t0);
  expect(parkReport().blockers).toEqual(['terminal not backed by tmux']);

  terminal = null;
  evaluatePark(t0 + 1_000);
  expect(parkReport().clearSince).toBe(new Date(t0 + 1_000).toISOString());
  evaluatePark(t0 + AFTER_MS);
  expect(received).toEqual([]);

  evaluatePark(t0 + 1_000 + AFTER_MS);
  await settle();
  expect(received).toEqual(['{"op":"park-node"}']);
  expect(parkReport().lastRequest?.result).toBe('parking');
  expect(parkReport().blockedBy).toEqual({ 'terminal not backed by tmux': 1 });

  // The launcher is stopping Node now: no second request while it does.
  evaluatePark(t0 + 2 * AFTER_MS);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(received).toHaveLength(1);
});

it('starts the clear period over when the gate wakes or a check blocks', () => {
  let review: string | null = null;
  startParkReport({ review: () => review });
  const t0 = 1_000_000;
  evaluatePark(t0);
  resting = false;
  evaluatePark(t0 + AFTER_MS - 1);
  expect(parkReport().blockers).toEqual(['idle gate awake']);
  resting = true;
  review = 'lane in review';
  evaluatePark(t0 + AFTER_MS);
  expect(parkReport().clearSince).toBeNull();
  expect(received).toEqual([]);
});

it('reports a check that throws as a reason instead of parking', () => {
  startParkReport({ cloudJob: () => { throw new Error('no table'); } });
  expect(parkBlockers()).toEqual(['cloudJob check failed']);
});

it('stops asking when the launcher has parking off', async () => {
  reply = JSON.stringify({ ok: false, error: 'Parking is off' });
  startParkReport({});
  evaluatePark(0);
  evaluatePark(AFTER_MS);
  await settle();
  expect(parkReport().lastRequest?.result).toBe('Parking is off');
  evaluatePark(AFTER_MS * 3);
  evaluatePark(AFTER_MS * 5);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(received).toHaveLength(1);
});

it('does nothing without the switch', () => {
  vi.stubEnv('O8_PARK_NODE', '');
  const interval = vi.spyOn(globalThis, 'setInterval');
  startParkReport({});
  expect(interval).not.toHaveBeenCalled();
  expect(parkReport().enabled).toBe(false);
});
