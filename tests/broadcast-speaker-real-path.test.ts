import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: (handler: unknown) => handler,
}));

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-broadcast-speaker-'));
const operatorToken = 'broadcast-speaker-operator-token-0123456789';
writeFileSync(path.join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { getSqlite } = await import('@/lib/db');
const { appendBroadcastEvent } = await import('@/lib/broadcast/post');
const { recordCalendarAttention } = await import('@/lib/broadcast/calendar-attention');
const { recordAutomationAttention } = await import('@/lib/broadcast/automation-attention');
const { BroadcastSpeaker, startBroadcastSpeakerLoop } = await import('@/lib/broadcast/speaker');
const { appendEvent, createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { createApproval, recordOrchestratorReview } = await import('@/lib/approvals/store');
const commentaryRoute = await import('@/app/api/broadcast/commentary/route');
const sayRoute = await import('@/app/api/broadcast/say/route');
const whyRoute = await import('@/app/api/broadcast/why/route');

function operatorRequest(url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${operatorToken}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function loadCommentary(cursor: string | null) {
  const query = cursor ? `?since=${encodeURIComponent(cursor)}` : '';
  const response = commentaryRoute.GET(operatorRequest(`http://localhost:3001/api/broadcast/commentary${query}`));
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    commentary: Array<{ id: string; actor: string; text: string; timestamp: string; priority: boolean }>;
    cursor: string | null;
    hasMore: boolean;
  }>;
}

const voiceOn = {
  broadcastVoice: 'on' as const,
  lullMinutes: 60,
  maxPerHour: 20,
  quietHours: 'off' as const,
  quietStart: '22:00',
  quietEnd: '08:00',
  attention: true,
  approvals: true,
  reviews: true,
  failures: true,
  completions: true,
  calendar: true,
  timeCheckins: true,
};

async function emptyCommentary() {
  return { commentary: [], cursor: null, hasMore: false };
}

describe('Broadcast speaker real path', () => {
  it('logs one warning for a continuous commentary outage', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Commentary unavailable.' },
    }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stop = startBroadcastSpeakerLoop();
    try {
      // #5326: with voice off (the default) the loop polls on every 15th tick.
      await vi.advanceTimersByTimeAsync(15_500);
      const speakerWarnings = warning.mock.calls.filter(([message]) => (
        String(message).startsWith('[broadcast-speaker]')
      ));
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
      expect(speakerWarnings).toHaveLength(1);
    } finally {
      stop();
      warning.mockRestore();
      fetchMock.mockRestore();
      vi.useRealTimers();
    }
  });

  it('advances the route cursor, prevents overlap, summarizes overflow, and lets say preempt pending lines', async () => {
    const base = Date.now();
    for (let index = 1; index <= 5; index += 1) {
      appendBroadcastEvent({
        kind: 'commentary',
        actor: 'mister',
        text: `Queued line ${index}.`,
      }, { sqlite: getSqlite(), now: new Date(base + index) });
    }

    let active = 0;
    let maxActive = 0;
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const spoken: string[] = [];
    const speak = vi.fn(async (text: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      spoken.push(text);
      if (spoken.length === 1) await firstHeld;
      active -= 1;
    });
    const speaker = new BroadcastSpeaker({ sqlite: getSqlite(), speak, loadCommentary, includeExisting: true });

    const firstTick = await speaker.tick({ now: new Date(base + 10), settings: voiceOn });
    expect(firstTick.cursor).toEqual(expect.any(String));
    expect(spoken).toEqual([
      'Queued updates condensed: Queued line 1. Queued line 2. Queued line 3.',
    ]);
    expect(speaker.state()).toMatchObject({ queued: 2, speaking: true });
    expect((getSqlite().prepare(`SELECT COUNT(*) AS count FROM broadcast_events WHERE json_extract(metadata_json, '$.speakerQueueDrop') = 1`).get() as { count: number }).count)
      .toBe(0);
    expect((getSqlite().prepare(`SELECT COUNT(*) AS count FROM broadcast_events WHERE json_extract(metadata_json, '$.speakerQueueSummary') = 1`).get() as { count: number }).count)
      .toBe(2);
    const represented = getSqlite().prepare(`
      SELECT json_extract(metadata_json, '$.representedEventIds') AS ids
      FROM broadcast_events
      WHERE json_extract(metadata_json, '$.speakerQueueSummary') = 1
      ORDER BY sequence DESC LIMIT 1
    `).get() as { ids: string };
    expect(JSON.parse(represented.ids)).toHaveLength(3);

    const sayResponse = await sayRoute.POST(operatorRequest(
      'http://localhost:3001/api/broadcast/say',
      { text: 'Priority line.' },
    ));
    expect(sayResponse.status).toBe(200);
    const priorityPage = await loadCommentary(speaker.state().cursor);
    expect(priorityPage.commentary).toContainEqual(expect.objectContaining({
      text: 'Priority line.',
      priority: true,
    }));
    await speaker.tick({ now: new Date(base + 20), settings: voiceOn });
    expect((speaker as unknown as { queue: Array<{ text: string; priority: boolean }> }).queue.map((line) => ({
      text: line.text,
      priority: line.priority,
    }))).toEqual([
      { text: 'Priority line.', priority: true },
      { text: 'Queued line 4.', priority: false },
      { text: 'Queued line 5.', priority: false },
    ]);
    releaseFirst();
    await speaker.flush();

    expect(spoken).toEqual([
      'Queued updates condensed: Queued line 1. Queued line 2. Queued line 3.',
      'Priority line.',
      'Queued line 4.',
      'Queued line 5.',
    ]);
    expect(maxActive).toBe(1);
    const delivered = getSqlite().prepare(`
      SELECT json_extract(metadata_json, '$.speechHeardAt') AS heardAt
      FROM broadcast_events WHERE text LIKE 'Queued line %' OR text = 'Priority line.'
    `).all() as Array<{ heardAt: string | null }>;
    expect(delivered).toHaveLength(6);
    expect(delivered.every((row) => typeof row.heardAt === 'string')).toBe(true);
    const catchUp = await loadCommentary(null);
    expect(catchUp.commentary.filter((line) => line.text.startsWith('Queued line') || line.text === 'Priority line.'))
      .toEqual(expect.arrayContaining(Array.from({ length: 6 }, () => expect.objectContaining({ suppressed: true }))));
    const empty = await loadCommentary(speaker.state().cursor);
    expect(empty.commentary).toEqual([]);
  });

  it('skips historical priority speech across startup pages and still delivers a fresh explicit request while muted', async () => {
    const base = new Date('2026-08-01T12:00:00.000Z');
    const sqlite = getSqlite();
    for (let index = 0; index < 105; index += 1) {
      appendBroadcastEvent({ kind: 'commentary', actor: 'symon', text: `Historical voice test ${index}.` }, {
        sqlite,
        now: new Date(base.getTime() + index),
        metadata: { speechPriority: true, onDemand: true },
      });
    }
    const speak = vi.fn(async () => undefined);
    const loader = vi.fn(loadCommentary);
    const settings = { ...voiceOn, broadcastVoice: 'off' as const, quietHours: 'on' as const,
      quietStart: '08:00', quietEnd: '08:00' };
    const speaker = new BroadcastSpeaker({ sqlite, speak, loadCommentary: loader });
    await speaker.tick({ settings });
    await speaker.flush();
    expect(loader.mock.calls.length).toBeGreaterThan(1);
    expect(speak).not.toHaveBeenCalled();
    expect(speaker.state()).toMatchObject({ queued: 0, speaking: false });

    const response = await sayRoute.POST(operatorRequest('http://localhost:3001/api/broadcast/say', {
      text: 'Fresh requested voice check.',
    }));
    expect(response.status).toBe(200);
    const { event } = await response.json() as { event: { id: string } };
    await speaker.tick({ settings });
    await speaker.flush();
    expect(speak).toHaveBeenCalledExactlyOnceWith('Fresh requested voice check.');
    const receipt = sqlite.prepare(`
      SELECT json_extract(metadata_json, '$.speechHeardAt') AS heardAt FROM broadcast_events WHERE id = ?
    `).get(event.id) as { heardAt: string };
    expect(Number.isFinite(Date.parse(receipt.heardAt))).toBe(true);

    const restarted = new BroadcastSpeaker({ sqlite, speak, loadCommentary });
    await restarted.tick({ settings });
    await restarted.flush();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM broadcast_events WHERE text LIKE 'Historical voice test %'").get())
      .toEqual({ count: 105 });

    const deliveredPage = await loadCommentary(speaker.state().cursor);
    expect(deliveredPage.commentary).toEqual([]);
  });

  it('coalesces a persisted merge, approval, and verdict burst without repeating or overlapping facts', async () => {
    let active = 0;
    let maxActive = 0;
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const spoken: string[] = [];
    const speaker = new BroadcastSpeaker({
      sqlite: getSqlite(),
      speak: async (text) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        spoken.push(text);
        if (spoken.length === 1) await firstHeld;
        active -= 1;
      },
      loadCommentary: emptyCommentary,
    });
    await speaker.tick({ settings: voiceOn });

    const suffix = Date.now();
    const mergedLane = createLane({
      label: 'Collision-safe voice packet',
      repoPath: '/tmp/broadcast-speaker-burst',
      branch: `issue/broadcast-speaker-merge-${suffix}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: `packet-broadcast-merge-${suffix}`,
    });
    const approvalLane = createLane({
      label: 'Release wiring packet',
      repoPath: '/tmp/broadcast-speaker-burst',
      branch: `issue/broadcast-speaker-approval-${suffix}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: `packet-broadcast-approval-${suffix}`,
    });
    setLaneStatus(mergedLane.id, 'running', 'system', 'running');
    setLaneStatus(approvalLane.id, 'running', 'system', 'running');
    appendEvent(mergedLane.id, 'merge', 'system', {
      laneHeadSha: 'a17c0de55f11',
      commitSubject: 'fix: coalesce spoken moment bursts',
      changedFileCount: 3,
      issue: 1822,
    });
    appendEvent(mergedLane.id, 'merge', 'system', {
      laneHeadSha: 'a17c0de55f11',
      commitSubject: 'fix: coalesce spoken moment bursts',
      changedFileCount: 3,
      issue: 1822,
    });
    createApproval({
      source: 'runtime',
      runtime: 'codex',
      agent: 'worker',
      sessionKey: `lane:${approvalLane.id}`,
      title: 'Approve release wiring',
      description: 'Confirm the release wiring before merge.',
      summary: 'Confirm the release wiring',
      risk: 'medium',
      metadata: {
        Lane: approvalLane.id,
        Packet: approvalLane.packetId!,
      },
      continuation: { kind: 'lane', laneId: approvalLane.id, verb: 'merge' },
    });
    recordOrchestratorReview(mergedLane.packetId!, {
      approved: false,
      reviewer: 'codex',
      findings: [{
        file: 'src/lib/broadcast/speaker.ts',
        line: 210,
        severity: 'bug',
        description: 'Burst facts can be spoken twice.',
        resolution: 'deferred',
      }],
    });

    const burstAt = Date.now();
    const bufferingTick = await speaker.tick({ now: new Date(burstAt + 500), settings: voiceOn });
    expect(bufferingTick.generated).toEqual([]);
    const momentTick = await speaker.tick({ now: new Date(burstAt + 1_500), settings: voiceOn });
    expect(momentTick.generated).toHaveLength(1);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain('Collision-safe voice packet');
    expect(spoken[0]).toContain('Release wiring packet');
    expect(spoken[0]).toContain('fix: coalesce spoken moment bursts');
    expect(spoken[0]).toContain('3 files');
    expect(spoken[0]).not.toContain('a17c0de');
    expect(spoken[0]).toContain('Approve release wiring');
    expect(spoken[0]).toContain('1 finding');
    expect(spoken[0]).toContain('src/lib/broadcast/speaker.ts');
    expect(spoken[0].match(/merged/g)).toHaveLength(1);

    appendEvent(mergedLane.id, 'merge', 'system', {
      laneHeadSha: 'a17c0de55f11',
      commitSubject: 'fix: coalesce spoken moment bursts',
      changedFileCount: 3,
      issue: 1822,
    });
    appendEvent(approvalLane.id, 'status_change', 'system', {
      status: 'failed',
      eventLabel: 'agent_failed',
      reason: 'The release check failed.',
    });
    await speaker.tick({ now: new Date(burstAt + 2_000), settings: voiceOn });
    await speaker.tick({ now: new Date(burstAt + 3_100), settings: voiceOn });
    expect(spoken).toHaveLength(1);
    expect(speaker.state()).toMatchObject({ queued: 1, speaking: true });
    releaseFirst();
    await speaker.flush();
    expect(spoken).toHaveLength(2);
    expect(spoken[1]).toContain('The release check failed');
    expect(spoken[1]).not.toContain('coalesce spoken moment bursts');
    expect(maxActive).toBe(1);

    const momentRows = getSqlite().prepare(`
      SELECT text FROM broadcast_events
      WHERE kind = 'commentary' AND json_extract(metadata_json, '$.voiceTrigger') = 'moment'
    `).all() as Array<{ text: string }>;
    expect(momentRows).toHaveLength(2);
  });

  it('adds the latest concrete fact and focus goal to a one-per-lull update', async () => {
    const base = new Date(Date.now() + 1_000);
    const spoken: string[] = [];
    const speaker = new BroadcastSpeaker({
      sqlite: getSqlite(),
      speak: async (text) => { spoken.push(text); },
      loadCommentary: emptyCommentary,
    });
    await speaker.tick({ now: base, settings: voiceOn });
    appendBroadcastEvent({
      kind: 'focus',
      actor: 'operator',
      title: 'Ship the Broadcast voice',
      goal: 'Keep every spoken update specific and uninterrupted',
      issue: 1822,
    }, { sqlite: getSqlite(), now: base });

    appendBroadcastEvent({
      kind: 'conversation',
      actor: 'operator',
      text: 'Reset the lull clock.',
    }, { sqlite: getSqlite(), now: new Date(base.getTime() + 2_000) });
    await speaker.tick({ now: new Date(base.getTime() + 2_000), settings: { ...voiceOn, lullMinutes: 6 } });
    await speaker.tick({ now: new Date(base.getTime() + 6 * 60_000 + 2_001), settings: { ...voiceOn, lullMinutes: 6 } });
    await speaker.flush();
    await speaker.tick({ now: new Date(base.getTime() + 7 * 60_000 + 2_001), settings: { ...voiceOn, lullMinutes: 6 } });
    await speaker.flush();

    const lullRows = getSqlite().prepare(`
      SELECT text FROM broadcast_events
      WHERE kind = 'commentary' AND json_extract(metadata_json, '$.voiceTrigger') = 'lull'
    `).all() as Array<{ text: string }>;
    expect(lullRows).toHaveLength(1);
    expect(lullRows[0].text).toContain('Still on issue #1822, Ship the Broadcast voice.');
    expect(lullRows[0].text).toContain('The goal is Keep every spoken update specific and uninterrupted.');
    expect(spoken).toEqual([lullRows[0].text]);

  });

  it('drops stale waiting states, keeps quiet-hour events from backlogging, and still honors an explicit say', async () => {
    const spoken: string[] = [];
    const speaker = new BroadcastSpeaker({
      sqlite: getSqlite(),
      speak: async (text) => { spoken.push(text); },
      loadCommentary,
    });
    await speaker.tick({ settings: voiceOn });
    await speaker.flush();
    expect(spoken).toEqual([]);

    const suffix = Date.now();
    const lane = createLane({
      label: 'Current-state voice packet',
      repoPath: '/tmp/broadcast-speaker-current-state',
      branch: `issue/broadcast-speaker-current-${suffix}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: `packet-broadcast-current-${suffix}`,
    });
    setLaneStatus(lane.id, 'awaiting_human', 'system', 'Choose whether to rerun.');
    setLaneStatus(lane.id, 'running', 'system', 'Rerun already started.');
    await speaker.tick({ settings: voiceOn });
    await speaker.tick({ now: new Date(Date.now() + 1_500), settings: voiceOn });
    expect(spoken).toEqual([]);

    const approvalLane = createLane({
      label: 'Quiet approval packet',
      repoPath: '/tmp/broadcast-speaker-current-state',
      branch: `issue/broadcast-speaker-quiet-${suffix}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: `packet-broadcast-quiet-${suffix}`,
    });
    createApproval({
      source: 'runtime',
      runtime: 'codex',
      agent: 'worker',
      sessionKey: `lane:${approvalLane.id}`,
      title: 'Approve quiet-hours proof',
      description: 'This pending approval lands during quiet hours.',
      summary: 'Quiet-hours proof',
      risk: 'low',
      metadata: { Lane: approvalLane.id, Packet: approvalLane.packetId! },
    });
    const allDayQuiet = { ...voiceOn, quietHours: 'on' as const, quietStart: '08:00', quietEnd: '08:00' };
    await speaker.tick({ settings: allDayQuiet });
    await speaker.tick({ now: new Date(Date.now() + 1_500), settings: allDayQuiet });
    await speaker.tick({ now: new Date(Date.now() + 3_000), settings: voiceOn });
    expect(spoken).toEqual([]);

    const sayResponse = await sayRoute.POST(operatorRequest(
      'http://localhost:3001/api/broadcast/say',
      { text: 'Read this now.' },
    ));
    expect(sayResponse.status).toBe(200);
    await speaker.tick({ settings: allDayQuiet });
    await speaker.flush();
    expect(spoken).toEqual(['Read this now.']);
  });

  it('deduplicates an imminent Calendar event and preserves its spoken why receipt', async () => {
    const spoken: string[] = [];
    const speaker = new BroadcastSpeaker({
      sqlite: getSqlite(),
      speak: async (text) => { spoken.push(text); },
      loadCommentary: emptyCommentary,
    });
    const base = Date.now() + 5_000;
    await speaker.tick({ now: new Date(base), settings: voiceOn });
    const calendarInput = {
      eventId: `calendar-real-path-${base}`,
      title: 'Design review',
      calendar: 'Work',
      startLocal: '2026-08-28T14:00:00',
      endLocal: '2026-08-28T14:30:00',
      startEpochMs: base + 10 * 60_000,
      endEpochMs: base + 40 * 60_000,
      allDay: false,
    };
    const policy = {
      broadcastVoice: 'on' as const,
      broadcastVoiceCalendar: true,
      broadcastVoiceCalendarLeadMinutes: 15,
    };
    expect(recordCalendarAttention(calendarInput, { role: 'operator' }, {
      sqlite: getSqlite(), nowMs: base, policy,
    }).status).toBe('recorded');
    expect(recordCalendarAttention(calendarInput, { role: 'operator' }, {
      sqlite: getSqlite(), nowMs: base + 100, policy,
    }).status).toBe('duplicate');

    await speaker.tick({ now: new Date(base + 500), settings: voiceOn });
    await speaker.tick({ now: new Date(base + 1_500), settings: voiceOn });
    await speaker.flush();
    expect(spoken).toEqual(['Calendar in 10 minutes: Design review.']);

    const whyResponse = whyRoute.GET(operatorRequest('http://localhost:3001/api/broadcast/why'));
    expect(whyResponse.status).toBe(200);
    await expect(whyResponse.json()).resolves.toMatchObject({
      receipt: {
        utterance: 'Calendar in 10 minutes: Design review.',
        trigger: 'moment',
        reason: expect.stringContaining('enabled attention subscription'),
        sources: [{ kind: 'calendar_imminent', detail: 'Design review' }],
      },
    });
  });

  it('speaks a durable automation check-in through the shared policy and why ledger', async () => {
    const spoken: string[] = [];
    const speaker = new BroadcastSpeaker({
      sqlite: getSqlite(),
      speak: async (text) => { spoken.push(text); },
      loadCommentary: emptyCommentary,
    });
    const base = Date.now() + 10_000;
    await speaker.tick({ now: new Date(base), settings: voiceOn });
    const packetId = `packet-scheduled-attention-${base}`;
    createLane({
      label: '[automation] Morning operator check-in',
      repoPath: '/tmp/broadcast-scheduled-attention',
      branch: `automation/attention-${base}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
    });
    expect(recordAutomationAttention(
      { text: 'Two approvals need you before work can continue.' },
      {
        role: 'worker',
        packetId,
        tokenId: 'scheduled-attention-token',
        leaseProcessMarker: null,
        leaseProcessPid: null,
        leaseProcessGroupId: null,
      },
      {
        sqlite: getSqlite(),
        now: new Date(base + 100),
        policy: { broadcastVoice: 'on', broadcastVoiceTimeCheckins: true },
      },
    ).status).toBe('recorded');

    await speaker.tick({ now: new Date(base + 500), settings: voiceOn });
    await speaker.tick({ now: new Date(base + 1_500), settings: voiceOn });
    await speaker.flush();
    expect(spoken).toEqual(['Two approvals need you before work can continue.']);
    const why = await whyRoute.GET(operatorRequest('http://localhost:3001/api/broadcast/why')).json() as {
      receipt: { reason: string; sources: Array<{ kind: string; detail: string }> };
    };
    expect(why.receipt.reason).toContain('durable o8 automation');
    expect(why.receipt.sources).toEqual([
      expect.objectContaining({
        kind: 'scheduled_attention',
        detail: 'Two approvals need you before work can continue.',
      }),
    ]);
  });
});
