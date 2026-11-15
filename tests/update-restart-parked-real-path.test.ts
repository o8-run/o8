/**
 * #3722: an operator restart is blocked by live work, but not by tasks that are
 * only waiting for review or input. Lanes are persisted in an isolated database
 * and read back through the real GET /api/panel/update/apply route.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { publishRealtimeMutation } = vi.hoisted(() => ({ publishRealtimeMutation: vi.fn(async () => true) }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation }));
let sessions: unknown[] = [];
let beforeTerminalReply: (() => Promise<void>) | null = null;

const dataDir = mkdtempSync(join(tmpdir(), 'o8-update-parked-'));
const previous = { CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR, O8_DATA_DIR: process.env.O8_DATA_DIR,
  O8_WS_PORT: process.env.O8_WS_PORT, APPIMAGE: process.env.APPIMAGE };
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
// Native install admission needs a self-updatable identity on Linux too.
process.env.APPIMAGE = join(dataDir, 'fixture.AppImage');

// The idle window reads the live terminal inventory from the WebSocket server.
// This fixture answers that one route with no attached terminals.
let terminals: Server;
beforeAll(async () => {
  terminals = createServer(async (request, response) => {
    await beforeTerminalReply?.();
    response.setHeader('Content-Type', 'application/json');
    response.end(request.url === '/terminal-voice-sessions' ? JSON.stringify({ sessions }) : '{}');
  });
  await new Promise<void>(resolve => terminals.listen(0, '127.0.0.1', resolve));
  process.env.O8_WS_PORT = String((terminals.address() as AddressInfo).port);
});

afterAll(async () => {
  await new Promise<void>(resolve => terminals.close(() => resolve()));
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

const { createLane, setLaneStatus, getLane, attachSession } = await import('@/lib/lane/registry');
const { GET, POST } = await import('@/app/api/panel/update/apply/route');
const { setAppUpdateState } = await import('@/lib/app-update/relaunch-state');
const { describeUpdateBlockers } = await import('@/lib/app-update/update-card-view');

type IdlePayload = Parameters<typeof describeUpdateBlockers>[0] & {
  idle: { idle: boolean; idleExceptParked: boolean; parkedLanes: Array<{ label: string; status: string }> };
};

async function readIdle(): Promise<IdlePayload> {
  const response = await GET();
  expect(response.status).toBe(200);
  return await response.json() as IdlePayload;
}

function lane(label: string, status: Parameters<typeof setLaneStatus>[1]) {
  const created = createLane({ repoPath: join(dataDir, 'repo'), branch: `b-${label.replace(/\W+/g, '-')}`, runtime: 'codex', label });
  setLaneStatus(created.id, status, 'system');
  return created.id;
}

describe('update restart with parked tasks', () => {
  it('lets a confirmed restart pass tasks waiting for review or input, names them, and leaves them untouched', async () => {
    const reviewing = lane('Fix the login form', 'reviewing');
    const waiting = lane('Ask about the schema', 'awaiting_input');

    const payload = await readIdle();
    expect(payload.idle.idle).toBe(true);
    expect(payload.idle.active?.lanes).toEqual([]);
    expect(payload.idle.idleExceptParked).toBe(true);
    expect(payload.idle.parkedLanes.map(item => item.label).sort()).toEqual(['Ask about the schema', 'Fix the login form']);
    expect(describeUpdateBlockers(payload)).toEqual({
      live: [],
      parked: expect.arrayContaining(['Fix the login form (waiting for review)', 'Ask about the schema (waiting for input)']),
    });

    // Checking the restart gate does not change the waiting tasks.
    expect(getLane(reviewing)?.status).toBe('reviewing');
    expect(getLane(waiting)?.status).toBe('awaiting_input');
  });

  it('keeps blocking a restart while a task is running, and names it as live work', async () => {
    const running = lane('Build the release', 'running');
    const payload = await readIdle();
    expect(payload.idle.idle).toBe(false);
    expect(payload.idle.idleExceptParked).toBe(false);
    const blockers = describeUpdateBlockers(payload);
    expect(blockers.live).toEqual(['Build the release (running)']);
    expect(blockers.parked).toHaveLength(2);
    setLaneStatus(running, 'completed', 'system');
    expect((await readIdle()).idle.idleExceptParked).toBe(true);
  });
});

describe('native auto-apply through the real state route without UpdateCard', () => {
  it('admits parked-only work automatically and rechecks live work before restart', async () => {
    const { POST: control } = await import('@/app/api/panel/app/update-state/route');
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    await updateOperatorDefaults({ updateAutoApply: 'idle' });
    const id = lane('Automatic saved review', 'reviewing');
    setAppUpdateState({ updatePending: true, version: '0.1.999' });
    const send = async (autoApply: object) => (await control(new Request('http://localhost/api/panel/app/update-state', {
      method: 'POST', body: JSON.stringify({ autoApply }),
    }))).json();
    const admitted = await send({ action: 'admit', attemptId: 'fixture-native-attempt' });
    expect(admitted.allowed).toBe(true);
    expect(admitted.idle.idle).toBe(true);
    expect(admitted.attemptId).toEqual(expect.any(String));
    expect((await send({ action: 'admit', attemptId: 'fixture-native-attempt' })).attemptId).toBe(admitted.attemptId);
    const manual = await control(new Request('http://localhost/api/panel/app/update-state', {
      method: 'POST', body: JSON.stringify({ install: { outcome: 'started', version: '0.1.999' } }),
    }));
    expect(manual.status).toBe(409);
    sessions = [{ name: 'Build terminal', kind: 'managed-process', clientCount: 0 }];
    const blocked = await send({ action: 'restart', attemptId: admitted.attemptId });
    expect(blocked.allowed).toBe(false);
    expect(blocked.state.autoApply.blockers.live).toEqual(['Terminal Build terminal']);
    expect(blocked.state.autoApply.installed).toBe(true);
    sessions = [];
    const restart = await send({ action: 'restart', attemptId: admitted.attemptId });
    expect(restart.allowed).toBe(true);
    expect(restart.state.autoApply.phase).toBe('restarting');
    expect((await control(new Request('http://localhost/api/panel/app/update-state', {
      method: 'POST', body: JSON.stringify({ install: { outcome: 'started', version: '0.1.999' } }),
    }))).status).toBe(409);
    expect(restart.idle.parkedLanes).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
    expect(getLane(id)?.status).toBe('reviewing');
    await send({ action: 'failed', attemptId: admitted.attemptId, error: 'fixture finished' });
    await updateOperatorDefaults({ updateAutoApply: 'off' });
    expect((await send({ action: 'admit' })).allowed).toBe(false);
  });

  it('admits a replacement native task only after a stopped-task proof', async () => {
    const { POST: control } = await import('@/app/api/panel/app/update-state/route');
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    const { recordAppUpdateInstall, recordAutoApply } = await import('@/lib/app-update/relaunch-state');
    await updateOperatorDefaults({ updateAutoApply: 'idle' });
    const id = randomUUID();
    recordAppUpdateInstall({ outcome: 'started', version: '0.1.999' });
    recordAutoApply({ attemptId: id, version: '0.1.999', installed: false, phase: 'installing', blockers: { live: [], parked: [] }, error: null });
    setAppUpdateState({ updatePending: true, version: '0.1.999' });
    const send = () => control(new Request('http://localhost/api/panel/app/update-state', {
      method: 'POST', body: JSON.stringify({ autoApply: { action: 'admit', attemptId: randomUUID() } }),
    }));
    expect(await (await send()).json()).toMatchObject({ allowed: false });
    mkdirSync(join(dataDir, 'native-update-tasks'), { recursive: true });
    writeFileSync(join(dataDir, 'native-update-tasks', `${id}.json`), JSON.stringify({ attemptId: id, pid: process.pid, status: 'stopped' }));
    expect(await (await send()).json()).toMatchObject({ allowed: true });
    recordAutoApply(null);
    recordAppUpdateInstall({ outcome: 'failed', error: 'fixture finished' });
  });

  it('inspects current work under its validated restart reservation before cleanup', async () => {
    const { POST: control } = await import('@/app/api/panel/app/update-state/route');
    const id = randomUUID();
    const directory = join(dataDir, 'cli-operation-admission');
    mkdirSync(directory);
    writeFileSync(join(directory, `${id}.json`), JSON.stringify({ version: 1, id, kind: 'restart', pid: process.pid, startedAt: new Date().toISOString(), stage: 'preparing' }));
    const inspect = (force = false) => control(new Request('http://localhost/api/panel/app/update-state', { method: 'POST',
      body: JSON.stringify({ autoApply: { action: 'inspect-restart', reservationId: id, force } }),
    }));
    try {
      expect(await (await inspect()).json()).toMatchObject({ allowed: true });
      const { createInlineTerminalHost } = await import('@/lib/ws-server/terminal-host-client');
      const spawn = vi.fn();
      const host = createInlineTerminalHost({ spawn });
      expect(() => host.spawn({ file: 'sh', args: [], cwd: dataDir, env: {}, cols: 80, rows: 24 })).toThrow(/restart/i);
      expect(spawn).not.toHaveBeenCalled();
      sessions = [{ name: 'Late terminal', kind: 'managed-process', clientCount: 0 }];
      expect(await (await inspect()).json()).toMatchObject({ allowed: false });
      expect(await (await inspect(true)).json()).toMatchObject({ allowed: true });
      writeFileSync(join(dataDir, 'fixture-cli-update.lock'), 'CLI installer');
      expect(await (await inspect(true)).json()).toMatchObject({ allowed: true });
    } finally {
      sessions = [];
      rmSync(join(dataDir, 'fixture-cli-update.lock'), { force: true });
      rmSync(directory, { recursive: true });
    }
  });

  it('does not automatically readmit a failed installer version, but admits a new release', async () => {
    const { POST: control } = await import('@/app/api/panel/app/update-state/route');
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    const { recordAppUpdateInstall, recordAutoApply } = await import('@/lib/app-update/relaunch-state');
    await updateOperatorDefaults({ updateAutoApply: 'idle' });
    recordAutoApply(null);
    recordAppUpdateInstall({ outcome: 'failed', error: 'fixture reset' });
    setAppUpdateState({ updatePending: true, version: '0.1.999' });
    const send = async (autoApply: object) => (await control(new Request('http://localhost/api/panel/app/update-state', {
      method: 'POST', body: JSON.stringify({ autoApply }),
    }))).json();
    const first = await send({ action: 'admit', attemptId: randomUUID() });
    expect(first.allowed).toBe(true);
    await send({ action: 'failed', attemptId: first.attemptId, error: 'Windows extraction failed' });
    expect((await send({ action: 'admit', attemptId: randomUUID() })).allowed).toBe(false);
    setAppUpdateState({ updatePending: true, version: '0.2.0' });
    expect((await send({ action: 'admit', attemptId: randomUUID() })).allowed).toBe(true);
    recordAutoApply(null);
    recordAppUpdateInstall({ outcome: 'failed', error: 'fixture finished' });
  });

  it('does not claim a native install when manual installation starts during live inventory', async () => {
    const { POST: control } = await import('@/app/api/panel/app/update-state/route');
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    const { recordAppUpdateInstall, recordAutoApply } = await import('@/lib/app-update/relaunch-state');
    await updateOperatorDefaults({ updateAutoApply: 'idle' });
    recordAutoApply(null);
    recordAppUpdateInstall({ outcome: 'failed', error: 'fixture reset' });
    setAppUpdateState({ updatePending: true, version: '0.1.999' });
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    beforeTerminalReply = async () => { entered(); await paused; };
    try {
      const automatic = control(new Request('http://localhost/api/panel/app/update-state', {
        method: 'POST', body: JSON.stringify({ autoApply: { action: 'admit' } }),
      }));
      await reading;
      const manual = await control(new Request('http://localhost/api/panel/app/update-state', {
        method: 'POST', body: JSON.stringify({ install: { outcome: 'started', version: '0.1.999' } }),
      }));
      expect(manual.status).toBe(200);
      release();
      expect((await (await automatic).json()).allowed).toBe(false);
    } finally { release(); beforeTerminalReply = null; }
    recordAppUpdateInstall({ outcome: 'installed', version: '0.1.999' });
    const resumed = await control(new Request('http://localhost/api/panel/app/update-state', {
      method: 'POST', body: JSON.stringify({ autoApply: { action: 'admit' } }),
    }));
    expect(await resumed.json()).toMatchObject({ allowed: true, installed: true });
    recordAutoApply(null);
    recordAppUpdateInstall({ outcome: 'installed', version: '0.1.998' });
    const newer = await control(new Request('http://localhost/api/panel/app/update-state', {
      method: 'POST', body: JSON.stringify({ autoApply: { action: 'admit' } }),
    }));
    expect(await newer.json()).toMatchObject({ allowed: true, installed: false });
    recordAutoApply(null);
    recordAppUpdateInstall({ outcome: 'failed', error: 'fixture finished' });
    await updateOperatorDefaults({ updateAutoApply: 'off' });
  });
});

async function apply() {
  setAppUpdateState({ updatePending: true, version: '0.1.999' });
  return POST(new Request('http://localhost/api/panel/update/apply', { method: 'POST', body: '{}' }));
}

describe('remote apply with persisted parked lanes', () => {
  it('applies without force and preserves parked records', async () => {
    const id = lane('Persist through restart', 'reviewing');
    const response = await apply();
    expect(response.status).toBe(202);
    const payload = await response.json();
    expect(payload.idle.parkedLanes).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
    expect(getLane(id)?.status).toBe('reviewing');
    expect(publishRealtimeMutation).toHaveBeenCalled();
  });

  it('blocks a live terminal despite parked-only lanes', async () => {
    sessions = [{ name: 'live-worker', kind: 'managed-process', clientCount: 0 }];
    expect((await apply()).status).toBe(409);
    sessions = [];
  });

  it('blocks a live process even when its lane is reviewing', async () => {
    const id = lane('Review with worker', 'reviewing');
    attachSession(id, 'codex-owned:review-live');
    const directory = join(process.env.CORTEX_IDE_OWNED_CODEX_ROOT!, 'review-live');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'session.json'), JSON.stringify({ surfaceId: 'codex-owned:review-live', activeRun: { pid: process.pid } }));
    const response = await apply();
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.idle.parkedLanes.map((item: { id: string }) => item.id)).not.toContain(id);
    expect(describeUpdateBlockers(payload).live).toContain('Review with worker (reviewing)');
    setLaneStatus(id, 'completed', 'system');
    rmSync(directory, { recursive: true });
  });

  it('defers normal apply but accepts explicit force over a CLI installer', async () => {
    const lock = join(dataDir, 'fixture-cli-update.lock');
    writeFileSync(lock, 'fixture');
    expect((await apply()).status).toBe(409);
    expect((await POST(new Request('http://localhost/api/panel/update/apply', { method: 'POST', body: JSON.stringify({ force: true }) }))).status).toBe(202);
    rmSync(lock);
  });
});
