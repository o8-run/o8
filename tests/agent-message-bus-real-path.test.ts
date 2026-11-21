import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { AgentMessageDeliverySeams } from '@/lib/agents/delivery';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-agent-message-bus-'));
const OPERATOR_TOKEN = 'agent-message-operator-token-0123456789';
const SPECTATOR_TOKEN = 'agent-message-spectator-token-0123456789';
writeFileSync(join(dataDir, 'ws-token'), `${OPERATOR_TOKEN}\n`, 'utf8');
writeFileSync(
  join(dataDir, 'broadcast-spectator-tokens'),
  `${createHash('sha256').update(SPECTATOR_TOKEN).digest('hex')}\n`,
  'utf8',
);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { createLane } = await import('@/lib/lane/registry');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { codename } = await import('@/lib/agents/codename');
const { closeDb, getSqlite } = await import('@/lib/db');
const { ensureAgentBusSchema, getAgentInboxCursor, listAgentInbox } = await import('@/lib/agents/store');
const heartbeatRoute = await import('@/app/api/lanes/[id]/heartbeat/route');
const presenceRoute = await import('@/app/api/agents/presence/route');
const inboxRoute = await import('@/app/api/agents/inbox/route');
const messageRoute = await import('@/app/api/agents/message/route');
const { createAgentMessagePostHandler } = await import('@/lib/agents/message-route-handler');
const broadcastEventsRoute = await import('@/app/api/broadcast/events/route');
const { panelGateMiddleware } = await import('@/middleware');

function request(
  url: string,
  input: { token: string; method?: string; body?: unknown },
): NextRequest {
  return new NextRequest(url, {
    method: input.method ?? 'GET',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${input.token}`,
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
}

describe('agent message bus real path', () => {
  const repoPath = `/tmp/o8-agent-message-repo-${Date.now()}`;
  const packetId = `packet-agent-message-${Date.now()}`;
  const lane = createLane({
    label: 'Agent message sender',
    repoPath,
    worktreePath: `${repoPath}/.worktrees/sender`,
    branch: 'issue/agent-message-sender',
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
  });
  const workerToken = mintPacketWorkerToken(packetId);
  const sendClaude = vi.fn<AgentMessageDeliverySeams['sendClaude']>().mockResolvedValue(undefined);
  const sendCodex = vi.fn<AgentMessageDeliverySeams['sendCodex']>().mockResolvedValue(undefined);
  const noLiveSessions = {
    discoverSessions: async () => [],
    resolveRepoPath: async () => null,
    now: () => new Date(),
  };
  const postMessage = createAgentMessagePostHandler({ sendClaude, sendCodex }, noLiveSessions);

  beforeEach(() => {
    sendClaude.mockClear();
    sendCodex.mockClear();
  });

  it('heartbeats presence, authorizes principals, delivers a user-role turn, cursors inbox, and mirrors Broadcast', async () => {
    const heartbeatRequest = request(`http://localhost:3001/api/lanes/${lane.id}/heartbeat`, {
      token: workerToken,
      method: 'POST',
      body: { heartbeatAt: Date.now() },
    });
    expect(panelGateMiddleware(heartbeatRequest).status).toBe(200);
    const heartbeat = await heartbeatRoute.POST(heartbeatRequest, { params: Promise.resolve({ id: lane.id }) });
    expect(heartbeat.status).toBe(200);

    const join = await presenceRoute.POST(request('http://localhost:3001/api/agents/presence', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: {
        agentId: 'receiver-session',
        name: 'Receiver',
        repo: repoPath,
        worktreePath: `${repoPath}/.worktrees/receiver`,
        runtime: 'claude-code',
        sessionKey: 'claude-session-receiver',
      },
    }));
    expect(join.status).toBe(201);

    const presenceRequest = request(`http://localhost:3001/api/agents/presence?repo=${encodeURIComponent(repoPath)}`, {
      token: workerToken,
    });
    expect(panelGateMiddleware(presenceRequest).status).toBe(200);
    const presence = await presenceRoute.GET(presenceRequest);
    await expect(presence.json()).resolves.toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({ agentId: lane.id, name: codename(lane.id), packetId }),
        expect.objectContaining({ agentId: 'receiver-session', name: 'Receiver', runtime: 'claude-code' }),
      ]),
    });

    const operatorPost = await postMessage(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { from: 'operator', to: 'Receiver', repo: repoPath, text: 'Operator check.' },
    }));
    expect(operatorPost.status).toBe(201);

    const workerPostRequest = request('http://localhost:3001/api/agents/message', {
      token: workerToken,
      method: 'POST',
      body: { to: 'Receiver', text: 'Please inspect the shared seam.' },
    });
    expect(panelGateMiddleware(workerPostRequest).status).toBe(200);
    const workerPost = await postMessage(workerPostRequest);
    expect(workerPost.status).toBe(201);
    const workerPayload = await workerPost.json() as { message: { id: string; delivery: string; conversation?: { id: string } } };
    expect(workerPayload.message.delivery).toBe('native');
    expect(sendClaude).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentId: 'receiver-session', sessionKey: 'claude-session-receiver' }),
      {
        type: 'user',
        message: {
          role: 'user',
          content: expect.stringContaining(`Conversation ID: ${workerPayload.message.conversation?.id}`),
        },
      },
    );
    expect(sendCodex).not.toHaveBeenCalled();

    const spectatorRequest = request('http://localhost:3001/api/agents/message', {
      token: SPECTATOR_TOKEN,
      method: 'POST',
      body: { from: 'spectator', to: 'Receiver', repo: repoPath, text: 'Denied.' },
    });
    expect(panelGateMiddleware(spectatorRequest).status).toBe(403);
    const spectatorPost = await postMessage(spectatorRequest);
    expect(spectatorPost.status).toBe(403);

    const inbox = await inboxRoute.GET(request('http://localhost:3001/api/agents/inbox?agent=Receiver&limit=1', {
      token: OPERATOR_TOKEN,
    }));
    const firstPage = await inbox.json() as { messages: Array<{ text: string }>; cursor: string; hasMore: boolean };
    expect(firstPage.messages).toEqual([expect.objectContaining({ text: 'Operator check.' })]);
    expect(firstPage.hasMore).toBe(true);
    const secondInbox = await inboxRoute.GET(request(
      `http://localhost:3001/api/agents/inbox?agent=Receiver&limit=10&cursor=${encodeURIComponent(firstPage.cursor)}`,
      { token: OPERATOR_TOKEN },
    ));
    await expect(secondInbox.json()).resolves.toMatchObject({
      messages: [expect.objectContaining({ text: 'Please inspect the shared seam.' })],
      hasMore: false,
    });

    const exchangesRequest = request(
      `http://localhost:3001/api/agents/message?repo=${encodeURIComponent(repoPath)}&limit=2`,
      { token: OPERATOR_TOKEN },
    );
    expect(panelGateMiddleware(exchangesRequest).status).toBe(200);
    const exchanges = await messageRoute.GET(exchangesRequest);
    expect(exchanges.status).toBe(200);
    await expect(exchanges.json()).resolves.toMatchObject({
      schema: 'o8/agents.exchanges/v1',
      repo: repoPath,
      messages: [
        expect.objectContaining({
          from: codename(lane.id),
          to: 'Receiver',
          text: 'Please inspect the shared seam.',
          delivery: 'native',
          deliveryNote: 'Submitted to the exact live Claude terminal session.',
        }),
        expect.objectContaining({ from: 'operator', to: 'Receiver', text: 'Operator check.' }),
      ],
    });

    const fleetExchanges = await messageRoute.GET(request(
      'http://localhost:3001/api/agents/message?scope=all&limit=2',
      { token: OPERATOR_TOKEN },
    ));
    expect(fleetExchanges.status).toBe(200);
    await expect(fleetExchanges.json()).resolves.toMatchObject({
      schema: 'o8/agents.exchanges/v1',
      messages: [
        expect.objectContaining({ text: 'Please inspect the shared seam.' }),
        expect.objectContaining({ text: 'Operator check.' }),
      ],
    });

    const fleetPresence = await presenceRoute.GET(request(
      'http://localhost:3001/api/agents/presence?scope=all',
      { token: OPERATOR_TOKEN },
    ));
    expect(fleetPresence.status).toBe(200);
    await expect(fleetPresence.json()).resolves.toMatchObject({
      schema: 'o8/agents.presence/v1',
      agents: expect.arrayContaining([
        expect.objectContaining({ agentId: 'receiver-session', repo: repoPath }),
      ]),
    });

    const storedPresence = await presenceRoute.GET(request(
      'http://localhost:3001/api/agents/presence?scope=stored',
      { token: OPERATOR_TOKEN },
    ));
    expect(storedPresence.status).toBe(200);
    await expect(storedPresence.json()).resolves.toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({ agentId: 'receiver-session', repo: repoPath }),
      ]),
    });

    const workerExchanges = await messageRoute.GET(request(
      `http://localhost:3001/api/agents/message?repo=${encodeURIComponent(repoPath)}`,
      { token: workerToken },
    ));
    expect(workerExchanges.status).toBe(403);
    await expect(workerExchanges.json()).resolves.toMatchObject({
      error: { code: 'agent_exchanges_forbidden' },
    });

    const workerFleetPresence = await presenceRoute.GET(request(
      'http://localhost:3001/api/agents/presence?scope=all',
      { token: workerToken },
    ));
    expect(workerFleetPresence.status).toBe(403);
    await expect(workerFleetPresence.json()).resolves.toMatchObject({
      error: { code: 'agent_presence_fleet_forbidden' },
    });

    const workerStoredPresence = await presenceRoute.GET(request(
      'http://localhost:3001/api/agents/presence?scope=stored',
      { token: workerToken },
    ));
    expect(workerStoredPresence.status).toBe(403);

    const broadcast = await broadcastEventsRoute.GET(request(
      `http://localhost:3001/api/broadcast/events?limit=100&repo=${encodeURIComponent(repoPath)}&kinds=conversation`,
      { token: OPERATOR_TOKEN },
    ));
    const broadcastPage = await broadcast.json() as {
      events: Array<{ kind: string; detail: string; payload: Record<string, unknown> }>;
    };
    expect(broadcastPage.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'conversation',
        detail: 'Please inspect the shared seam.',
        payload: expect.objectContaining({ agentMessageId: workerPayload.message.id }),
      }),
    ]));
  });

  it('accepts the full 4,000-character contract and routes Codex targets through the active-task seam', async () => {
    const join = await presenceRoute.POST(request('http://localhost:3001/api/agents/presence', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: {
        agentId: 'codex-receiver-session',
        name: 'CodexReceiver',
        repo: repoPath,
        worktreePath: `${repoPath}/.worktrees/codex-receiver`,
        runtime: 'codex',
        sessionKey: 'codex-thread-receiver',
      },
    }));
    expect(join.status).toBe(201);

    const text = 'm'.repeat(4_000);
    const accepted = await postMessage(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { from: 'operator', to: 'CodexReceiver', repo: repoPath, text },
    }));
    expect(accepted.status).toBe(201);
    await expect(accepted.json()).resolves.toMatchObject({
      message: {
        delivery: 'poll',
        deliveryNote: 'Codex inbox wake accepted; retained in the durable inbox until the target reads it.',
      },
    });
    expect(sendCodex).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'codex-receiver-session', sessionKey: 'codex-thread-receiver' }),
      expect.stringContaining('[o8 agent inbox]'),
      expect.any(Function),
    );
    expect(sendCodex.mock.calls[0]?.[1]).not.toContain(text);

    const rejected = await postMessage(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { from: 'operator', to: 'CodexReceiver', repo: repoPath, text: 'm'.repeat(4_001) },
    }));
    expect(rejected.status).toBe(400);
  });

  it('coalesces Codex wakes and remembers inbox progress when the cursor flag is omitted', async () => {
    const agentId = 'codex-coalesced-session';
    const name = 'CodexCoalescedReceiver';
    const joined = await presenceRoute.POST(request('http://localhost:3001/api/agents/presence', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: {
        agentId,
        name,
        repo: repoPath,
        worktreePath: repoPath,
        runtime: 'codex',
        sessionKey: 'codex:coalesced-receiver',
      },
    }));
    expect(joined.status).toBe(201);

    const legacyNative = await postMessage(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { from: 'operator', to: name, repo: repoPath, text: 'Already submitted as a native turn.' },
    }));
    const legacyPayload = await legacyNative.json() as { message: { id: string } };
    getSqlite().prepare(`
      UPDATE agent_messages
      SET delivery_status = 'native', delivery_note = 'Accepted by the legacy per-message queue.'
      WHERE id = ?
    `).run(legacyPayload.message.id);

    for (const text of ['First update.', 'Second update.', 'Final current state.']) {
      const accepted = await postMessage(request('http://localhost:3001/api/agents/message', {
        token: OPERATOR_TOKEN,
        method: 'POST',
        body: { from: 'operator', to: name, repo: repoPath, text },
      }));
      expect(accepted.status).toBe(201);
      await expect(accepted.json()).resolves.toMatchObject({
        message: {
          delivery: 'poll',
          deliveryNote: expect.stringContaining('durable inbox'),
        },
      });
    }

    expect(sendCodex).toHaveBeenCalledTimes(1);
    expect(sendCodex).toHaveBeenCalledWith(
      expect.objectContaining({ agentId, sessionKey: 'codex:coalesced-receiver' }),
      expect.stringContaining('[o8 agent inbox]'),
      expect.any(Function),
    );
    expect(sendCodex.mock.calls[0]?.[1]).not.toContain('First update.');

    closeDb();
    const firstInbox = await inboxRoute.GET(request(
      `http://localhost:3001/api/agents/inbox?agentId=${encodeURIComponent(agentId)}&limit=2`,
      { token: OPERATOR_TOKEN },
    ));
    const firstPage = await firstInbox.json() as { messages: Array<{ text: string }>; hasMore: boolean };
    expect(firstPage.messages.map((message) => message.text)).toEqual([
      'First update.',
      'Second update.',
    ]);
    expect(firstPage.hasMore).toBe(true);

    const secondInbox = await inboxRoute.GET(request(
      `http://localhost:3001/api/agents/inbox?agentId=${encodeURIComponent(agentId)}&limit=100`,
      { token: OPERATOR_TOKEN },
    ));
    const secondPage = await secondInbox.json() as { messages: Array<{ text: string }>; hasMore: boolean };
    expect(secondPage.messages.map((message) => message.text)).toEqual([
      'Final current state.',
    ]);
    expect(secondPage.hasMore).toBe(false);

    const resumedInbox = await inboxRoute.GET(request(
      `http://localhost:3001/api/agents/inbox?agentId=${encodeURIComponent(agentId)}&limit=100`,
      { token: OPERATOR_TOKEN },
    ));
    await expect(resumedInbox.json()).resolves.toMatchObject({ messages: [], hasMore: false });

    const nextMessage = await postMessage(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { from: 'operator', to: name, repo: repoPath, text: 'New after acknowledgement.' },
    }));
    expect(nextMessage.status).toBe(201);
    expect(sendCodex).toHaveBeenCalledTimes(2);

    getSqlite().prepare(`
      UPDATE agent_inbox_state
      SET native_wake_at = '2000-01-01T00:00:00.000Z'
      WHERE repo_path = ? AND agent_name = ? COLLATE NOCASE
    `).run(repoPath, name);
    const recoveredWake = await postMessage(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { from: 'operator', to: name, repo: repoPath, text: 'Recover an abandoned wake.' },
    }));
    expect(recoveredWake.status).toBe(201);
    expect(sendCodex).toHaveBeenCalledTimes(3);
  });

  it('keeps a deferred native attempt queued, then marks it delivered when the target reads its inbox', async () => {
    const joined = await presenceRoute.POST(request('http://localhost:3001/api/agents/presence', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: {
        agentId: 'codex-deferred-session',
        name: 'DeferredReceiver',
        repo: repoPath,
        worktreePath: repoPath,
        runtime: 'codex',
        sessionKey: 'codex:deferred-receiver',
      },
    }));
    expect(joined.status).toBe(201);

    const deferredPost = createAgentMessagePostHandler({
      sendClaude,
      sendCodex: async () => {
        throw new Error('The task already has an active writer.');
      },
    }, noLiveSessions);
    const accepted = await deferredPost(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: {
        from: 'operator',
        to: 'DeferredReceiver',
        repo: repoPath,
        text: 'Read me from the durable fallback.',
      },
    }));
    expect(accepted.status).toBe(201);
    const acceptedPayload = await accepted.json() as {
      message: { id: string; delivery: string; deliveryNote: string };
    };
    expect(acceptedPayload).toMatchObject({
      message: {
        delivery: 'poll',
        deliveryNote: expect.stringContaining('retained in the durable inbox'),
      },
    });

    getSqlite().prepare(`
      UPDATE agent_messages
      SET delivery_status = 'failed', delivery_note = 'Legacy native delivery attempt failed.'
      WHERE id = ?
    `).run(acceptedPayload.message.id);
    const reconciled = await messageRoute.GET(request(
      `http://localhost:3001/api/agents/message?repo=${encodeURIComponent(repoPath)}&limit=20`,
      { token: OPERATOR_TOKEN },
    ));
    await expect(reconciled.json()).resolves.toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          id: acceptedPayload.message.id,
          delivery: 'poll',
        }),
      ]),
    });

    const inbox = await inboxRoute.GET(request(
      'http://localhost:3001/api/agents/inbox?agentId=codex-deferred-session&limit=100',
      { token: OPERATOR_TOKEN },
    ));
    expect(inbox.status).toBe(200);
    await expect(inbox.json()).resolves.toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          text: 'Read me from the durable fallback.',
          delivery: 'native',
          deliveryNote: 'Read from the durable inbox by the target session.',
        }),
      ]),
    });

    const exchanges = await messageRoute.GET(request(
      `http://localhost:3001/api/agents/message?repo=${encodeURIComponent(repoPath)}&limit=20`,
      { token: OPERATOR_TOKEN },
    ));
    await expect(exchanges.json()).resolves.toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          text: 'Read me from the durable fallback.',
          delivery: 'native',
          deliveryNote: 'Read from the durable inbox by the target session.',
        }),
      ]),
    });
  });

  it('does not downgrade a read receipt when a slow Codex wake settles afterward', async () => {
    const agentId = `codex-race-${Date.now()}`;
    const name = 'RaceReceiver';
    expect((await presenceRoute.POST(request('http://localhost:3001/api/agents/presence', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { agentId, name, repo: repoPath, worktreePath: repoPath, runtime: 'codex', sessionKey: `codex:${agentId}` },
    }))).status).toBe(201);

    let wakeStarted!: () => void;
    let releaseWake!: () => void;
    const started = new Promise<void>((resolve) => { wakeStarted = resolve; });
    const wake = new Promise<void>((resolve) => { releaseWake = resolve; });
    const delayedPost = createAgentMessagePostHandler({
      sendClaude,
      sendCodex: async () => { wakeStarted(); await wake; },
    }, noLiveSessions);
    const pending = delayedPost(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { from: 'operator', to: name, repo: repoPath, text: 'Read before the wake settles.' },
    }));
    await started;
    try {
      const inbox = await inboxRoute.GET(request(
        `http://localhost:3001/api/agents/inbox?agentId=${encodeURIComponent(agentId)}`,
        { token: OPERATOR_TOKEN },
      ));
      expect(inbox.status).toBe(200);
      await expect(inbox.json()).resolves.toMatchObject({
        messages: [expect.objectContaining({ text: 'Read before the wake settles.', delivery: 'native' })],
      });
    } finally {
      releaseWake();
    }
    const accepted = await pending;
    expect(accepted.status).toBe(201);
    await expect(accepted.json()).resolves.toMatchObject({
      message: {
        delivery: 'native',
        deliveryNote: 'Read from the durable inbox by the target session.',
      },
    });
  });

  it('discovers one live runtime session, addresses it by runtime alias, and rejects an ambiguous alias', async () => {
    const discoveredRepo = `/tmp/o8-agent-message-discovered-${Date.now()}`;
    const liveSession = (sessionKey: string) => ({
      sessionKey,
      runtimeId: 'claude-code' as const,
      displayName: 'Live runtime session',
      cwd: discoveredRepo,
      status: 'running' as const,
      ownership: 'discovered' as const,
      sessionCapabilities: {
        canSendInput: true,
        canInterrupt: true,
        canReviewDiffs: true,
      },
      lastActivityAt: new Date(),
    });
    const presenceSeams = {
      discoverSessions: async () => [liveSession('claude-code:live-one')],
      resolveRepoPath: async () => discoveredRepo,
      now: () => new Date(),
    };
    const discoveredPost = createAgentMessagePostHandler({ sendClaude, sendCodex }, presenceSeams);

    const accepted = await discoveredPost(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { from: 'operator', to: 'claude', repo: discoveredRepo, text: 'Automatic ping.' },
    }));
    expect(accepted.status).toBe(201);
    await expect(accepted.json()).resolves.toMatchObject({
      message: { delivery: 'native', text: 'Automatic ping.' },
    });
    expect(sendClaude).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runtime: 'claude-code',
        sessionKey: 'claude-code:live-one',
        worktreePath: discoveredRepo,
      }),
      expect.objectContaining({
        message: expect.objectContaining({
          content: expect.stringContaining("To answer, run: o8 msg send --to 'operator' --reply-to"),
        }),
      }),
    );

    const ambiguousPost = createAgentMessagePostHandler({ sendClaude, sendCodex }, {
      ...presenceSeams,
      discoverSessions: async () => [
        liveSession('claude-code:live-one'),
        liveSession('claude-code:live-two'),
      ],
    });
    const ambiguous = await ambiguousPost(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { from: 'operator', to: 'claude', repo: discoveredRepo, text: 'Do not guess.' },
    }));
    expect(ambiguous.status).toBe(409);
    await expect(ambiguous.json()).resolves.toMatchObject({
      error: { code: 'agent_target_ambiguous' },
    });
  });

  it('automatically names an authenticated CLI session without a manual presence command', async () => {
    const automaticRepo = `/tmp/o8-agent-message-auto-sender-${Date.now()}`;
    const joined = await presenceRoute.POST(request('http://localhost:3001/api/agents/presence', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: {
        automatic: true,
        agentId: 'session:codex:auto-sender',
        repo: automaticRepo,
        worktreePath: automaticRepo,
        runtime: 'codex',
        sessionKey: 'codex:auto-sender',
      },
    }));
    expect(joined.status).toBe(201);
    await expect(joined.json()).resolves.toMatchObject({
      agent: {
        agentId: 'session:codex:auto-sender',
        name: codename('session:codex:auto-sender'),
        repo: automaticRepo,
      },
    });
  });

  it('shows stale repository identity only to the operator and marks it offline', async () => {
    const agentId = `history-agent-${Date.now()}`;
    expect((await presenceRoute.POST(request('http://localhost:3001/api/agents/presence', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: {
        agentId, name: 'HistoryAgent', repo: repoPath, worktreePath: repoPath,
        runtime: 'codex', sessionKey: `codex:${agentId}`,
      },
    }))).status).toBe(201);
    getSqlite().prepare('UPDATE agent_presence SET last_seen = ? WHERE agent_id = ?')
      .run('2000-01-01T00:00:00.000Z', agentId);

    const normal = await presenceRoute.GET(request(
      `http://localhost:3001/api/agents/presence?repo=${encodeURIComponent(repoPath)}`,
      { token: OPERATOR_TOKEN },
    ));
    await expect(normal.json()).resolves.toMatchObject({
      agents: expect.not.arrayContaining([expect.objectContaining({ agentId })]),
    });
    const history = await presenceRoute.GET(request(
      `http://localhost:3001/api/agents/presence?repo=${encodeURIComponent(repoPath)}&includeStale=true`,
      { token: OPERATOR_TOKEN },
    ));
    await expect(history.json()).resolves.toMatchObject({
      agents: expect.arrayContaining([expect.objectContaining({ agentId, runtime: 'codex', live: false })]),
    });
    const denied = await presenceRoute.GET(request(
      `http://localhost:3001/api/agents/presence?repo=${encodeURIComponent(repoPath)}&includeStale=true`,
      { token: workerToken },
    ));
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ error: { code: 'agent_presence_history_forbidden' } });
  });

  it('keeps message identities from send time after a stale codename takeover', async () => {
    const repo = `/tmp/o8-agent-identity-${Date.now()}`;
    const join = (sessionKey: string) => presenceRoute.POST(request('http://localhost:3001/api/agents/presence', {
      token: OPERATOR_TOKEN, method: 'POST',
      body: { agentId: 'identity-agent', name: 'Cedar', repo, worktreePath: repo, runtime: 'codex', sessionKey },
    }));
    expect((await join('codex:original-session')).status).toBe(201);
    const sent = await postMessage(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN, method: 'POST', body: { repo, to: 'Cedar', text: 'Check this record.' },
    }));
    expect(sent.status).toBe(201);
    await expect(sent.json()).resolves.toMatchObject({ message: {
      refs: { identities: { from: null, to: { runtime: 'codex', sessionKey: 'codex:original-session' } } },
    } });
    getSqlite().prepare('UPDATE agent_presence SET last_seen = ? WHERE agent_id = ?')
      .run('2000-01-01T00:00:00.000Z', 'identity-agent');
    expect((await join('codex:replacement-session')).status).toBe(200);
    const history = await messageRoute.GET(request(
      `http://localhost:3001/api/agents/message?repo=${encodeURIComponent(repo)}`,
      { token: OPERATOR_TOKEN },
    ));
    const historyBody = await history.json() as { messages: Array<{ refs: { identities?: unknown } }> };
    expect(historyBody.messages[0].refs.identities).toEqual({
      from: null, to: { runtime: 'codex', sessionKey: 'codex:original-session' },
    });
  });

  it('migrates an alias send into one canonical scope after restart and keeps retries idempotent', async () => {
    const physicalRepo = mkdtempSync(join(os.tmpdir(), 'o8-agent-message-repo-scope-'));
    const aliasRepo = `${physicalRepo}-alias`;
    symlinkSync(physicalRepo, aliasRepo);
    const canonicalRepo = realpathSync.native(aliasRepo);
    const senderId = `alias-sender-${Date.now()}`;
    const receiverId = `alias-receiver-${Date.now()}`;

    for (const [agentId, name] of [[senderId, 'AliasSender'], [receiverId, 'AliasReceiver']]) {
      const joined = await presenceRoute.POST(request('http://localhost:3001/api/agents/presence', {
        token: OPERATOR_TOKEN,
        method: 'POST',
        body: { agentId, name, repo: canonicalRepo, worktreePath: aliasRepo, runtime: 'poll', sessionKey: `poll:${agentId}` },
      }));
      expect(joined.status).toBe(201);
    }

    getSqlite().transaction(() => {
      getSqlite().prepare('UPDATE agent_presence SET repo_path = ? WHERE agent_id IN (?, ?)').run(aliasRepo, senderId, receiverId);
      getSqlite().prepare("DELETE FROM agent_bus_migrations WHERE name = 'canonical_repo_paths_v1'").run();
    })();
    closeDb();

    const sentViaAlias = await postMessage(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: {
        fromAgentId: senderId,
        to: 'AliasReceiver',
        repo: aliasRepo,
        text: 'Canonical message.',
        requestId: 'alias-scope-idempotency',
      },
    }));
    expect(sentViaAlias.status).toBe(201);
    const first = await sentViaAlias.json() as { message: { id: string; repo: string } };
    expect(first.message.repo).toBe(canonicalRepo);
    closeDb();

    const retriedCanonical = await postMessage(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: {
        fromAgentId: senderId,
        to: 'AliasReceiver',
        repo: canonicalRepo,
        text: 'Canonical message.',
        requestId: 'alias-scope-idempotency',
      },
    }));
    expect(retriedCanonical.status).toBe(201);
    await expect(retriedCanonical.json()).resolves.toMatchObject({ message: { id: first.message.id, repo: canonicalRepo } });
    const listed = await messageRoute.GET(request(
      `http://localhost:3001/api/agents/message?repo=${encodeURIComponent(canonicalRepo)}&limit=20`,
      { token: OPERATOR_TOKEN },
    ));
    await expect(listed.json()).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: first.message.id, repo: canonicalRepo })],
    });
  });

  it('fails closed when legacy and canonical scopes assign one name to different agents', async () => {
    const physicalRepo = mkdtempSync(join(os.tmpdir(), 'o8-agent-message-repo-collision-'));
    const aliasRepo = `${physicalRepo}-alias`;
    symlinkSync(physicalRepo, aliasRepo);
    const canonicalRepo = realpathSync.native(aliasRepo);
    const legacyId = `legacy-shared-${Date.now()}`;
    const canonicalId = `canonical-shared-${Date.now()}`;
    for (const [agentId, repo] of [[legacyId, canonicalRepo], [canonicalId, canonicalRepo]]) {
      const joined = await presenceRoute.POST(request('http://localhost:3001/api/agents/presence', {
        token: OPERATOR_TOKEN,
        method: 'POST',
        body: { agentId, name: 'SharedAlias', repo, worktreePath: repo, runtime: 'poll', sessionKey: `poll:${agentId}` },
      }));
      expect(joined.status).toBe(201);
      if (agentId === legacyId) getSqlite().prepare('UPDATE agent_presence SET repo_path = ? WHERE agent_id = ?').run(aliasRepo, legacyId);
    }
    getSqlite().transaction(() => {
      getSqlite().prepare(`
        INSERT INTO agent_messages
          (id, from_agent, to_agent, repo_path, text, refs_json, delivery_status, created_at)
        VALUES (?, 'SharedAlias', 'operator', ?, 'private legacy message', '{}', 'poll', ?)
      `).run(`legacy-message-${legacyId}`, aliasRepo, new Date().toISOString());
      getSqlite().prepare(`
        INSERT INTO agent_messages
          (id, from_agent, to_agent, repo_path, text, refs_json, delivery_status, created_at)
        VALUES (?, 'operator', 'SharedAlias', ?, 'canonical inbox message', '{}', 'poll', ?)
      `).run(`canonical-inbox-${canonicalId}`, canonicalRepo, new Date().toISOString());
      getSqlite().prepare(`
        INSERT INTO agent_messages
          (id, from_agent, to_agent, repo_path, text, refs_json, delivery_status, created_at)
        VALUES (?, 'operator', 'SharedAlias', ?, 'legacy inbox message', '{}', 'poll', ?)
      `).run(`legacy-inbox-${legacyId}`, aliasRepo, new Date().toISOString());
      getSqlite().prepare(`
        INSERT INTO agent_inbox_state (repo_path, agent_name, acknowledged_sequence)
        VALUES (?, 'SharedAlias', 0), (?, 'SharedAlias', 0)
      `).run(aliasRepo, canonicalRepo);
      getSqlite().prepare("DELETE FROM agent_bus_migrations WHERE name = 'canonical_repo_paths_v1'").run();
    })();
    closeDb();

    const listed = await messageRoute.GET(request(
      `http://localhost:3001/api/agents/message?repo=${encodeURIComponent(canonicalRepo)}&limit=20`,
      { token: OPERATOR_TOKEN },
    ));
    await expect(listed.json()).resolves.toMatchObject({
      messages: expect.not.arrayContaining([expect.objectContaining({ id: `legacy-message-${legacyId}` })]),
    });
    const legacyInbox = await inboxRoute.GET(request(
      `http://localhost:3001/api/agents/inbox?agentId=${encodeURIComponent(legacyId)}&limit=20`,
      { token: OPERATOR_TOKEN },
    ));
    await expect(legacyInbox.json()).resolves.toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ id: `legacy-inbox-${legacyId}` })]),
    });
    const inboxState = getSqlite().prepare(`
      SELECT repo_path, acknowledged_sequence FROM agent_inbox_state
      WHERE agent_name = 'SharedAlias' ORDER BY repo_path
    `).all() as Array<{ repo_path: string; acknowledged_sequence: number }>;
    expect(inboxState).toEqual(expect.arrayContaining([
      expect.objectContaining({ repo_path: canonicalRepo, acknowledged_sequence: 0 }),
      expect.objectContaining({ repo_path: aliasRepo, acknowledged_sequence: expect.any(Number) }),
    ]));
    const denied = await postMessage(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { fromAgentId: legacyId, to: 'SharedAlias', repo: aliasRepo, text: 'Do not cross scopes.' },
    }));
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ error: { code: 'agent_sender_repo_mismatch' } });
  });

  it('records the repository-alias reconciliation version across database restarts', () => {
    const physicalRepo = mkdtempSync(join(os.tmpdir(), 'o8-agent-message-repo-version-'));
    const aliasRepo = `${physicalRepo}-alias`;
    symlinkSync(physicalRepo, aliasRepo);
    const databasePath = join(mkdtempSync(join(os.tmpdir(), 'o8-agent-message-db-version-')), 'state.db');
    let sqlite = new Database(databasePath);
    ensureAgentBusSchema(sqlite);
    sqlite.prepare(`
      INSERT INTO agent_presence
        (agent_id, name, repo_path, worktree_path, runtime, session_key, lane_id, packet_id, last_seen)
      VALUES ('late-alias-row', 'LateAlias', ?, NULL, 'poll', NULL, NULL, NULL, ?)
    `).run(aliasRepo, new Date().toISOString());
    ensureAgentBusSchema(sqlite);
    expect(sqlite.prepare('SELECT repo_path FROM agent_presence WHERE agent_id = ?').get('late-alias-row'))
      .toMatchObject({ repo_path: aliasRepo });
    sqlite.close();

    sqlite = new Database(databasePath);
    ensureAgentBusSchema(sqlite);
    expect(sqlite.prepare('SELECT repo_path FROM agent_presence WHERE agent_id = ?').get('late-alias-row'))
      .toMatchObject({ repo_path: aliasRepo });
    sqlite.close();
  });

  it('correlates two agents through the real routes, rejects stale and foreign replies, and enforces the budget after restart', async () => {
    const repo = `/tmp/o8-agent-conversation-${Date.now()}`;
    for (const [agentId, name] of [['conversation-a', 'Aster'], ['conversation-b', 'Birch'], ['conversation-c', 'Cedar']]) {
      const joined = await presenceRoute.POST(request('http://localhost:3001/api/agents/presence', {
        token: OPERATOR_TOKEN,
        method: 'POST',
        body: { agentId, name, repo, worktreePath: repo, runtime: 'poll', sessionKey: `poll:${agentId}` },
      }));
      expect(joined.status).toBe(201);
    }
    const send = async (body: Record<string, unknown>) => {
      const response = await postMessage(request('http://localhost:3001/api/agents/message', {
        token: OPERATOR_TOKEN, method: 'POST', body: { repo, ...body },
      }));
      return { status: response.status, body: await response.json() as {
        message?: { id: string; conversation: { id: string; turnIndex: number; turnLimit: number; remainingTurns: number; status: string; replyToId: string | null } };
        error?: { code: string };
      } };
    };
    const first = await send({ fromAgentId: 'conversation-a', to: 'Birch', text: 'Review this proposal.', requestId: 'conversation-first' });
    expect(first.status).toBe(201);
    expect(first.body.message?.conversation).toMatchObject({ turnIndex: 1, turnLimit: 8, remainingTurns: 7, replyToId: null });
    const firstId = first.body.message!.id;
    const conversationId = first.body.message!.conversation.id;

    const duplicate = await send({ fromAgentId: 'conversation-a', to: 'Birch', text: 'Review this proposal.', requestId: 'conversation-first' });
    expect(duplicate.status).toBe(201);
    expect(duplicate.body.message?.id).toBe(firstId);
    const count = () => (getSqlite().prepare('SELECT COUNT(*) AS count FROM agent_messages WHERE conversation_id = ?').get(conversationId) as { count: number }).count;
    expect(count()).toBe(1);

    const foreign = await send({ fromAgentId: 'conversation-c', to: 'Aster', text: 'I should not join.', replyToId: firstId });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error?.code).toBe('agent_reply_participant_mismatch');
    const wrongRepo = await postMessage(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN,
      method: 'POST',
      body: { fromAgentId: 'conversation-b', to: 'Aster', repo: `${repo}/other`, text: 'Wrong scope.', replyToId: firstId },
    }));
    expect(wrongRepo.status).toBe(403);
    expect(count()).toBe(1);

    const raced = await Promise.all([
      send({ fromAgentId: 'conversation-b', to: 'Aster', text: 'First reply.', replyToId: firstId, requestId: 'conversation-race-1' }),
      send({ fromAgentId: 'conversation-b', to: 'Aster', text: 'Second reply.', replyToId: firstId, requestId: 'conversation-race-2' }),
    ]);
    expect(raced.map((result) => result.status).sort()).toEqual([201, 409]);
    let latest = raced.find((result) => result.status === 201)!.body.message!;
    expect(latest.conversation).toMatchObject({ id: conversationId, turnIndex: 2, replyToId: firstId });
    expect(count()).toBe(2);

    const inbox = await inboxRoute.GET(request('http://localhost:3001/api/agents/inbox?agent=Aster&limit=10', { token: OPERATOR_TOKEN }));
    await expect(inbox.json()).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: latest.id, conversation: expect.objectContaining({ id: conversationId, remainingTurns: 6 }) })],
    });

    closeDb();
    expect(getSqlite().prepare('SELECT COUNT(*) AS count FROM agent_messages WHERE conversation_id = ?').get(conversationId)).toMatchObject({ count: 2 });
    for (let turn = 3; turn <= 8; turn += 1) {
      const fromA = turn % 2 === 1;
      const next = await send({
        fromAgentId: fromA ? 'conversation-a' : 'conversation-b',
        to: fromA ? 'Birch' : 'Aster',
        text: `Turn ${turn}.`,
        replyToId: latest.id,
        requestId: `conversation-turn-${turn}`,
      });
      expect(next.status).toBe(201);
      latest = next.body.message!;
      expect(latest.conversation.turnIndex).toBe(turn);
    }
    expect(latest.conversation).toMatchObject({ remainingTurns: 0, status: 'closed' });
    const eighthParentId = (getSqlite().prepare('SELECT reply_to_id AS id FROM agent_messages WHERE id = ?').get(latest.id) as { id: string }).id;
    const eighthRetry = await send({ fromAgentId: 'conversation-b', to: 'Aster', text: 'Turn 8.', replyToId: eighthParentId, requestId: 'conversation-turn-8' });
    expect(eighthRetry.status).toBe(201);
    expect(eighthRetry.body.message?.id).toBe(latest.id);
    const overBudget = await send({ fromAgentId: 'conversation-a', to: 'Birch', text: 'Extra.', replyToId: latest.id });
    expect(overBudget.status).toBe(409);
    expect(count()).toBe(8);

    const exchanges = await messageRoute.GET(request(`http://localhost:3001/api/agents/message?repo=${encodeURIComponent(repo)}&limit=10`, { token: OPERATOR_TOKEN }));
    await expect(exchanges.json()).resolves.toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ id: firstId, conversation: expect.objectContaining({ id: conversationId }) })]) });
  });

  it('accepts an early final reply without a delivery side effect on rejected replies', async () => {
    const repo = `/tmp/o8-agent-final-${Date.now()}`;
    for (const [agentId, name] of [['final-a', 'Harbor'], ['final-b', 'Maple']]) {
      expect((await presenceRoute.POST(request('http://localhost:3001/api/agents/presence', {
        token: OPERATOR_TOKEN, method: 'POST',
        body: { agentId, name, repo, worktreePath: repo, runtime: 'poll', sessionKey: `poll:${agentId}` },
      }))).status).toBe(201);
    }
    const send = async (body: Record<string, unknown>) => {
      const response = await postMessage(request('http://localhost:3001/api/agents/message', {
        token: OPERATOR_TOKEN, method: 'POST', body: { repo, ...body },
      }));
      return { status: response.status, body: await response.json() as { message?: { id: string; conversation: { id: string; status: string; remainingTurns: number } }; error?: { code: string } } };
    };
    const first = await send({ fromAgentId: 'final-a', to: 'Maple', text: 'Can you check this?' });
    const final = await send({ fromAgentId: 'final-b', to: 'Harbor', text: 'Checked; all clear.', replyToId: first.body.message!.id, close: true });
    expect(final.body.message?.conversation).toMatchObject({ status: 'closed', remainingTurns: 6 });
    const rejected = await send({ fromAgentId: 'final-a', to: 'Maple', text: 'More?', replyToId: final.body.message!.id });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error?.code).toBe('agent_conversation_closed');

  });

  it('lets an agent answer an operator handoff in the same conversation', async () => {
    const repo = `/tmp/o8-agent-operator-reply-${Date.now()}`;
    expect((await presenceRoute.POST(request('http://localhost:3001/api/agents/presence', {
      token: OPERATOR_TOKEN, method: 'POST',
      body: { agentId: 'operator-reply-agent', name: 'Juniper', repo, worktreePath: repo, runtime: 'poll', sessionKey: 'poll:operator-reply-agent' },
    }))).status).toBe(201);
    const firstResponse = await postMessage(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN, method: 'POST', body: { repo, to: 'Juniper', text: 'What is the status?' },
    }));
    const first = await firstResponse.json() as { message: { id: string; conversation: { id: string } } };
    const replyResponse = await postMessage(request('http://localhost:3001/api/agents/message', {
      token: OPERATOR_TOKEN, method: 'POST',
      body: { repo, fromAgentId: 'operator-reply-agent', to: 'operator', text: 'The task is ready.', replyToId: first.message.id, close: true },
    }));
    expect(replyResponse.status).toBe(201);
    await expect(replyResponse.json()).resolves.toMatchObject({
      message: { from: 'Juniper', to: 'operator', deliveryNote: 'Available in the operator Handoffs view.', conversation: { id: first.message.conversation.id, status: 'closed' } },
    });
  });

  it('adds conversation columns without rewriting legacy messages or inbox cursors', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE agent_messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, repo_path TEXT NOT NULL,
          text TEXT NOT NULL, refs_json TEXT NOT NULL DEFAULT '{}',
          delivery_status TEXT NOT NULL, delivery_note TEXT, created_at TEXT NOT NULL
        );
        INSERT INTO agent_messages
          (sequence, id, from_agent, to_agent, repo_path, text, refs_json, delivery_status, created_at)
        VALUES (7, 'legacy-seven', 'operator', 'Legacy', '/tmp/legacy-bus', 'Earlier message.', '{}', 'poll', '2026-01-01T00:00:00.000Z');
        CREATE TABLE agent_inbox_state (
          repo_path TEXT NOT NULL, agent_name TEXT NOT NULL COLLATE NOCASE,
          acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
          native_wake_session_key TEXT, native_wake_through_sequence INTEGER NOT NULL DEFAULT 0,
          native_wake_at TEXT, PRIMARY KEY(repo_path, agent_name)
        );
        INSERT INTO agent_inbox_state
          (repo_path, agent_name, acknowledged_sequence)
        VALUES ('/tmp/legacy-bus', 'Legacy', 6);
      `);
      ensureAgentBusSchema(sqlite);
      const agent = {
        agentId: 'legacy-agent', name: 'Legacy', repo: '/tmp/legacy-bus', worktreePath: null,
        runtime: 'poll', sessionKey: null, laneId: null, packetId: null, lastSeen: new Date().toISOString(),
      };
      expect(getAgentInboxCursor(agent, sqlite)).toBe(6);
      expect(listAgentInbox({ agent, after: 6, limit: 10 }, sqlite).messages).toMatchObject([
        { id: 'legacy-seven', sequence: 7, conversation: null, text: 'Earlier message.' },
      ]);
    } finally {
      sqlite.close();
    }
  });
});
