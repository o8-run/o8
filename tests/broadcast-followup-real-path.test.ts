/**
 * Broadcast follow-up proofs through the real spectator route handlers.
 * The projection and credential files resolve their data directory at import,
 * so the fixture is established before the dynamic route imports below.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-broadcast-followup-'));
const OPERATOR_TOKEN = 'operator-broadcast-followup-token-0123456789';
const SHORT_DEVICE_TOKEN = 'dv!43y';
writeFileSync(join(dataDir, 'ws-token'), `${OPERATOR_TOKEN}\n`, 'utf8');
writeFileSync(
  join(dataDir, 'mobile-device-tokens'),
  `${createHash('sha256').update(SHORT_DEVICE_TOKEN).digest('hex')}\n`,
  'utf8',
);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

// A spectator is a minted token record, not a bare hash in the projection file.
const { getSpectatorTokenStore } = await import('@/lib/broadcast/spectator-token-store');
const { readActiveSpectatorTokenHashes, writeActiveSpectatorTokenHashes } = await import('@/lib/broadcast/spectator-token-file');
const SPECTATOR_TOKEN = getSpectatorTokenStore().mint({
  label: 'broadcast follow-up',
  repoGrants: [
    '/tmp/broadcast-redaction-route',
    '/tmp/broadcast-payload-bound',
    '/tmp/broadcast-scan-bound',
  ],
}).bearer;
const broadcastEvents = await import('@/app/api/broadcast/events/route');
const broadcastPost = await import('@/app/api/broadcast/post/route');
const broadcastSnapshot = await import('@/app/api/broadcast/snapshot/route');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { decodeBroadcastCursor } = await import('@/lib/broadcast/events');
const { getSqlite } = await import('@/lib/db');
const { appendEvent, createLane } = await import('@/lib/lane/registry');

function spectatorRequest(path: string, token = SPECTATOR_TOKEN): NextRequest {
  return new NextRequest(`http://localhost:3001${path}`, {
    method: 'GET',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${token}`,
    },
  });
}

function postRequest(token: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3001/api/broadcast/post', {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  delete process.env.O8_BROADCAST_TEST_AUTH;
  delete process.env.WS_TOKEN;
});

describe('Broadcast follow-up bounds and redaction through real routes', () => {
  it('uses a canonical spectator with explicit grants for every fixture repository', async () => {
    const response = await broadcastEvents.GET(spectatorRequest('/api/broadcast/events?limit=1'));
    expect(response.status).toBe(200);
    expect(getSpectatorTokenStore().resolveBearer(SPECTATOR_TOKEN)).toMatchObject({
      repoGrants: [
        '/tmp/broadcast-payload-bound',
        '/tmp/broadcast-redaction-route',
        '/tmp/broadcast-scan-bound',
      ],
      revokedAt: null,
    });
  });

  it('refuses a projection-only credential through both reader routes without granting canonical authority', async () => {
    const token = 'o8sp_projection_only_fixture';
    const projection = [...readActiveSpectatorTokenHashes()];
    const hash = createHash('sha256').update(token).digest('hex');
    writeActiveSpectatorTokenHashes([...projection, hash]);
    try {
      expect(readActiveSpectatorTokenHashes().has(hash)).toBe(true);
      expect(getSpectatorTokenStore().resolveBearer(token)).toBeNull();
      for (const [route, path] of [
        [broadcastEvents, '/api/broadcast/events?limit=1'],
        [broadcastSnapshot, '/api/broadcast/snapshot?events=1'],
      ] as const) {
        const response = await route.GET(spectatorRequest(path, token));
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: 'broadcast_reader_forbidden' },
        });
      }
    } finally {
      writeActiveSpectatorTokenHashes(projection);
    }
    const response = await broadcastSnapshot.GET(spectatorRequest('/api/broadcast/snapshot?events=1'));
    expect(response.status).toBe(200);
  });

  it('redacts sensitive keys plus live operator, device, and short secret environment values', async () => {
    const shortOperatorToken = 'op!42x';
    const shortEnvironmentSecret = 'ev!44z';
    process.env.WS_TOKEN = shortOperatorToken;
    process.env.O8_BROADCAST_TEST_AUTH = shortEnvironmentSecret;
    // A flag-sized value under a secret-looking key must not scrub digits out
    // of ordinary text ("#1800" once rendered as "#[redacted-env]800").
    process.env.O8_BROADCAST_TEST_FLAG_TOKEN = '1';
    // Long values under ordinary keys are not secrets (NODE_ENV=production).
    process.env.O8_BROADCAST_TEST_MODE = 'production';
    const lane = createLane({
      label: 'Broadcast redaction route',
      repoPath: '/tmp/broadcast-redaction-route',
      branch: `agent/broadcast-redaction-${Date.now()}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: `packet-broadcast-redaction-${Date.now()}`,
    });
    const sensitiveValues = {
      cookie: 'raw-cookie-shape',
      pw: 'raw-pw-shape',
      auth: 'raw-auth-shape',
      sessionKey: 'raw-session-camel-shape',
      session_key: 'raw-session-snake-shape',
      'ws-token': 'raw-ws-dash-shape',
      ws_token: 'raw-ws-snake-shape',
      'device-token': 'raw-device-dash-shape',
      device_token: 'raw-device-snake-shape',
    };
    appendEvent(lane.id, 'agent_report', 'orchestrator', {
      event: 'progress',
      message: 'redaction route proof for #1800 through the production launcher',
      metadata: {
        ...sensitiveValues,
        first: shortOperatorToken,
        second: SHORT_DEVICE_TOKEN,
        third: shortEnvironmentSecret,
      },
    });

    const response = await broadcastEvents.GET(spectatorRequest(
      `/api/broadcast/events?kinds=progress&lane=${encodeURIComponent(lane.id)}`,
    ));
    expect(response.status).toBe(200);
    const serialized = await response.text();
    for (const raw of [
      ...Object.values(sensitiveValues),
      shortOperatorToken,
      SHORT_DEVICE_TOKEN,
      shortEnvironmentSecret,
    ]) {
      expect(serialized).not.toContain(raw);
    }
    expect(serialized).toContain('[redacted');
    expect(serialized).not.toContain('[redacted-env]800');
    expect(serialized).toContain('#1800');
    expect(serialized).toContain('production launcher');
  });

  it('redacts a file-sourced operator token and worker bearers embedded in text on every reader route', async () => {
    // The operator token comes from the data directory, as in production: no WS_TOKEN in the
    // environment, so only the live context can find it inside a sentence or a quoted value.
    delete process.env.WS_TOKEN;
    const readOnlyWorker = 'o8ro_Zm9vYmFyLWJhei1xdXV4LWZpeHR1cmUtcmVhZC1vbmx5LTA';
    const brainSignature = 'c2lnbmF0dXJlLWZpeHR1cmUtMDEyMzQ1Njc4OWFiY2Rl-';
    const brainWorker = `o8br_eyJyZXBvUGF0aCI6Ii90bXAvZml4dHVyZSJ9.${brainSignature}`;
    const lane = createLane({
      label: 'Broadcast embedded redaction',
      repoPath: '/tmp/broadcast-redaction-route',
      branch: `agent/broadcast-embedded-${Date.now()}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: `packet-broadcast-embedded-${Date.now()}`,
    });
    appendEvent(lane.id, 'agent_report', 'orchestrator', {
      event: 'progress',
      message: `the ws token is ${OPERATOR_TOKEN} now`,
      metadata: {
        note: `token="${OPERATOR_TOKEN}"`,
        worker: `read-only bearer ${readOnlyWorker} in use`,
        brain: `brain grant ${brainWorker} issued`,
      },
    });
    getSqlite().prepare(`
      INSERT INTO broadcast_events (id, kind, actor, audience, text, lane_id, packet_id, metadata_json, created_at)
      VALUES (?, 'commentary', 'symon', NULL, ?, NULL, NULL, '{}', ?)
    `).run(`commentary-embedded-${lane.id}`, `symon read ${OPERATOR_TOKEN} and ${brainWorker} aloud`, new Date().toISOString());

    const broadcastCommentary = await import('@/app/api/broadcast/commentary/route');
    for (const [route, path] of [
      [broadcastEvents, `/api/broadcast/events?kinds=progress&lane=${encodeURIComponent(lane.id)}`],
      [broadcastSnapshot, '/api/broadcast/snapshot?events=100'],
      [broadcastCommentary, '/api/broadcast/commentary?limit=100'],
    ] as const) {
      const response = await route.GET(spectatorRequest(path));
      expect(response.status, path).toBe(200);
      const serialized = await response.text();
      for (const raw of [OPERATOR_TOKEN, readOnlyWorker, brainWorker, brainSignature]) {
        expect(serialized, `${path} leaks ${raw.slice(0, 8)}`).not.toContain(raw);
      }
      expect(serialized, path).toContain('[redacted-token]');
    }
  });

  // Seeds `text` into a lane event (message and a payload value) and a commentary row, then
  // returns what a spectator reads from each reader route.
  async function spectatorReads(label: string, text: string): Promise<Array<[string, string]>> {
    delete process.env.WS_TOKEN;
    const lane = createLane({
      label: `Broadcast ${label}`,
      repoPath: '/tmp/broadcast-redaction-route',
      branch: `agent/broadcast-${label}-${Date.now()}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: `packet-broadcast-${label}-${Date.now()}`,
    });
    appendEvent(lane.id, 'agent_report', 'orchestrator', { event: 'progress', message: text, metadata: { note: text } });
    getSqlite().prepare(`
      INSERT INTO broadcast_events (id, kind, actor, audience, text, lane_id, packet_id, metadata_json, created_at)
      VALUES (?, 'commentary', 'symon', NULL, ?, NULL, NULL, '{}', ?)
    `).run(`commentary-${label}-${lane.id}`, text, new Date().toISOString());
    const broadcastCommentary = await import('@/app/api/broadcast/commentary/route');
    const reads: Array<[string, string]> = [];
    for (const [route, path] of [
      [broadcastEvents, `/api/broadcast/events?kinds=progress&lane=${encodeURIComponent(lane.id)}`],
      [broadcastSnapshot, '/api/broadcast/snapshot?events=100'],
      [broadcastCommentary, '/api/broadcast/commentary?limit=100'],
    ] as const) {
      const response = await route.GET(spectatorRequest(path));
      expect(response.status, path).toBe(200);
      reads.push([path, await response.text()]);
    }
    return reads;
  }

  const bearerBody = 'Zm9vYmFyLWJhei1xdXV4LWZpeHR1cmUtYmVhcmVyLTAxMjM0NQ';

  it('redacts worker bearers glued to a preceding word, escape or encoding', async () => {
    const packet = `o8pw_${bearerBody}`;
    const brain = `o8br_eyJyZXBvUGF0aCI6Ii90bXAvZ2x1ZWQifQ.c2lnbmF0dXJlLWdsdWVkLWZpeHR1cmU`;
    const reads = await spectatorReads('glued', `token%3D${packet} WORKER_${packet} \u001b[32m${brain}\u001b[0m`);
    for (const [path, body] of reads) {
      for (const raw of [bearerBody, 'c2lnbmF0dXJlLWdsdWVkLWZpeHR1cmU']) expect(body, `${path} leaks a glued bearer`).not.toContain(raw);
    }
  });

  it('redacts the local worker token from the data directory wherever it appears', async () => {
    const workerToken = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
    writeFileSync(join(dataDir, 'worker-token'), workerToken, 'utf8');
    try {
      const reads = await spectatorReads('worker-token', `worker env carried ${workerToken} into the report`);
      for (const [path, body] of reads) {
        expect(body, `${path} leaks the local worker token`).not.toContain(workerToken);
        expect(body, path).toContain('[redacted-token]');
      }
    } finally {
      rmSync(join(dataDir, 'worker-token'), { force: true });
    }
  });

  it('redacts an active device token inside text', async () => {
    const deviceToken = 'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f';
    const devices = join(dataDir, 'mobile-device-tokens');
    const before = readFileSync(devices, 'utf8');
    appendFileSync(devices, `${createHash('sha256').update(deviceToken).digest('hex')}\n`, 'utf8');
    try {
      const reads = await spectatorReads('device-run', `paired device token=${deviceToken} today`);
      for (const [path, body] of reads) expect(body, `${path} leaks a device token`).not.toContain(deviceToken);
    } finally {
      writeFileSync(devices, before, 'utf8');
    }
  });

  it('redacts customer worker, plugin, o8d and read-only worker bearers', async () => {
    const tokens = [`o8wt_${bearerBody}`, `o8p_${bearerBody}x`, `o8d_${bearerBody}y`, `o8ro_${bearerBody}z`];
    const reads = await spectatorReads('prefixes', `issued ${tokens.join(' and ')} for the run`);
    for (const [path, body] of reads) {
      for (const token of tokens) expect(body, `${path} leaks ${token.slice(0, 5)}`).not.toContain(token.slice(5));
    }
  });

  it('redacts a bearer that ends in a dash, dash included', async () => {
    const reads = await spectatorReads('trailing-dash', `grant o8pw_${bearerBody}-- then done`);
    for (const [path, body] of reads) {
      expect(body, path).toContain('[redacted-token]');
      expect(body, `${path} leaves the trailing dash`).not.toContain('[redacted-token]-');
    }
  });

  it('caps a projected event payload at 8 KB and marks it truncated', async () => {
    const lane = createLane({
      label: 'Broadcast payload bound',
      repoPath: '/tmp/broadcast-payload-bound',
      branch: `agent/broadcast-payload-${Date.now()}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: `packet-broadcast-payload-${Date.now()}`,
    });
    appendEvent(lane.id, 'agent_report', 'orchestrator', {
      event: 'progress',
      message: `large-payload-${'x'.repeat(64 * 1024)}`,
    });

    const response = await broadcastEvents.GET(spectatorRequest(
      `/api/broadcast/events?kinds=progress&lane=${encodeURIComponent(lane.id)}`,
    ));
    expect(response.status).toBe(200);
    const page = await response.json() as { events: Array<{ payload: Record<string, unknown> }> };
    expect(page.events).toHaveLength(1);
    expect(page.events[0].payload).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(JSON.stringify(page.events[0].payload), 'utf8')).toBeLessThanOrEqual(8 * 1024);
  });

  it('stops after 5,000 non-matching ledger rows and returns a cursor the client can continue', async () => {
    const lane = createLane({
      label: 'Broadcast scan bound',
      repoPath: '/tmp/broadcast-scan-bound',
      branch: `agent/broadcast-scan-${Date.now()}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: `packet-broadcast-scan-${Date.now()}`,
    });
    const insert = getSqlite().prepare(`
      INSERT INTO lane_events (id, lane_id, verb, actor, payload_json, timestamp)
      VALUES (?, ?, 'heartbeat', 'system', '{}', ?)
    `);
    getSqlite().transaction(() => {
      const start = Date.parse('2035-01-01T00:00:00.000Z');
      for (let index = 0; index < 6_000; index += 1) {
        insert.run(`broadcast-scan-${lane.id}-${index}`, lane.id, new Date(start + index).toISOString());
      }
    })();

    const firstResponse = await broadcastEvents.GET(spectatorRequest(
      `/api/broadcast/events?kinds=message&lane=${encodeURIComponent(lane.id)}`,
    ));
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as { events: unknown[]; cursor: string; hasMore: boolean };
    expect(first.events).toEqual([]);
    expect(first.hasMore).toBe(true);
    const firstCursor = decodeBroadcastCursor(first.cursor);
    expect(firstCursor?.positions.lane).toBeGreaterThan(0);

    const secondResponse = await broadcastEvents.GET(spectatorRequest(
      `/api/broadcast/events?kinds=message&lane=${encodeURIComponent(lane.id)}&cursor=${encodeURIComponent(first.cursor)}`,
    ));
    const second = await secondResponse.json() as { events: unknown[]; cursor: string; hasMore: boolean };
    expect(second.events).toEqual([]);
    expect(second.hasMore).toBe(false);
    expect(second.cursor).not.toBe(first.cursor);
    expect(decodeBroadcastCursor(second.cursor)?.positions.lane).toBeGreaterThan(firstCursor?.positions.lane ?? 0);

    const snapshotResponse = await broadcastSnapshot.GET(spectatorRequest(
      '/api/broadcast/snapshot?events=5',
    ));
    expect(snapshotResponse.status).toBe(200);
    await expect(snapshotResponse.json()).resolves.toMatchObject({ recentEvents: [] });
  });

  it('sets focus only for an operator and projects it directly in the snapshot', async () => {
    const operatorResponse = await broadcastPost.POST(postRequest(OPERATOR_TOKEN, {
      kind: 'focus',
      title: 'Broadcast real-path focus',
      goal: 'Prove the spectator projection.',
      issue: 1842,
    }));
    expect(operatorResponse.status).toBe(200);

    const workerToken = mintPacketWorkerToken(`packet-broadcast-focus-${Date.now()}`);
    const workerResponse = await broadcastPost.POST(postRequest(workerToken, {
      kind: 'focus',
      title: 'Worker cannot replace focus',
    }));
    expect(workerResponse.status).toBe(403);
    await expect(workerResponse.json()).resolves.toMatchObject({
      error: { code: 'broadcast_focus_forbidden' },
    });

    const spectatorResponse = await broadcastPost.POST(postRequest(SPECTATOR_TOKEN, {
      kind: 'focus',
      title: 'Spectator cannot replace focus',
    }));
    expect(spectatorResponse.status).toBe(403);

    const snapshotResponse = await broadcastSnapshot.GET(spectatorRequest('/api/broadcast/snapshot?events=1'));
    expect(snapshotResponse.status).toBe(200);
    await expect(snapshotResponse.json()).resolves.toMatchObject({
      focus: {
        title: 'Broadcast real-path focus',
        goal: 'Prove the spectator projection.',
        issue: 1842,
        startedAt: expect.any(String),
      },
    });

    const clearResponse = await broadcastPost.POST(postRequest(OPERATOR_TOKEN, {
      kind: 'focus',
      clear: true,
    }));
    expect(clearResponse.status).toBe(200);
    const clearedSnapshot = await broadcastSnapshot.GET(spectatorRequest('/api/broadcast/snapshot?events=1'));
    await expect(clearedSnapshot.json()).resolves.toMatchObject({ focus: null });
  });
});
