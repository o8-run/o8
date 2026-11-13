import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  store: {
    getOrCreateTurn: vi.fn(),
    getConversation: vi.fn(),
    beginExecution: vi.fn(),
    appendConversation: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
  },
  readPlanner: vi.fn(),
  pollTurn: vi.fn(),
  loadSession: vi.fn(),
  createSession: vi.fn(),
  appendTranscript: vi.fn(),
  generateShared: vi.fn(),
}));

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/symon/managed-messages-store', () => ({
  getManagedSymonMessagesStore: () => h.store,
}));
vi.mock('@/lib/mobile/symon-text-bridge-client', () => ({
  readSymonTextPlannerInfo: h.readPlanner,
  pollSymonTextTurn: h.pollTurn,
}));
vi.mock('@/lib/mobile/symon-text-session-store', () => ({
  loadSymonTextSession: h.loadSession,
  createSymonTextSessionFromTranscript: h.createSession,
  appendSymonTextTranscript: h.appendTranscript,
  bindSymonTextEffectiveModel: vi.fn(),
  formatSymonTextPlannerPrompt: (_session: unknown, text: string) => `User: ${text}`,
}));
vi.mock('@/lib/chat/gateway-client', () => ({ generateSharedSymonText: h.generateShared }));

import { POST } from '@/lib/symon/http/managed-inbound';

const baseTurn = {
  eventId: 'event-1',
  conversationId: 'chat-1',
  providerMessageId: 'message-1',
  senderHandle: '+12675550111',
  recipientHandle: '+12545550111',
  requestText: 'What is running?',
  turnId: 'managed-turn-1',
  sessionId: null,
  promptText: null,
  executionEpoch: null,
  status: 'queued',
  responseText: null,
  detail: null,
  createdAt: 1,
  updatedAt: 1,
};

const session = {
  subject: 'operator',
  deviceId: null,
  sessionId: 'session-1',
  engine: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
  workspaceMode: 'o8',
  repoId: null,
  repoPath: null,
  allowedTools: [],
  createdAt: 1,
  lastActivityAt: 1,
  transcript: [],
  activeMachine: { id: 'imac', displayName: 'iMac' },
};

function request(overrides: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/symon/managed-messages/inbound', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventId: baseTurn.eventId,
      conversationId: baseTurn.conversationId,
      messageId: baseTurn.providerMessageId,
      sender: baseTurn.senderHandle,
      recipient: baseTurn.recipientHandle,
      text: baseTurn.requestText,
      ...overrides,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.store.getOrCreateTurn.mockReturnValue({ ...baseTurn });
  h.store.getConversation.mockReturnValue({ sessionId: null, transcript: [] });
  h.readPlanner.mockResolvedValue({
    available: true,
    engine: session.engine,
    model: session.model,
    effort: session.effort,
    tools: [],
  });
  h.createSession.mockReturnValue(session);
  h.loadSession.mockReturnValue(session);
  h.generateShared.mockResolvedValue('The date is still a working plan.');
  h.store.beginExecution.mockImplementation((input: Record<string, unknown>) => ({
    ...baseTurn,
    status: 'processing',
    sessionId: input.sessionId,
    promptText: input.promptText,
    executionEpoch: input.executionEpoch,
  }));
});

describe('managed Symon Messages real route', () => {
  it('returns a persisted terminal result without running the CLI twice', async () => {
    h.store.getOrCreateTurn.mockReturnValue({
      ...baseTurn,
      status: 'completed',
      responseText: 'All clear.',
    });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, state: 'done', text: 'All clear.' });
    expect(h.pollTurn).not.toHaveBeenCalled();
  });

  it('surfaces only approval state while the native card owns the decision', async () => {
    h.pollTurn.mockResolvedValue({
      state: 'needs_confirmation',
      confirmation: { tool: 'term_send', args: { text: 'private command' } },
    });
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, state: 'awaiting_approval' });
    expect(h.store.beginExecution).toHaveBeenCalledTimes(1);
    expect(h.store.appendConversation).toHaveBeenCalledWith(expect.objectContaining({
      entries: [{ role: 'user', text: baseTurn.requestText }],
    }));
  });

  it('fails closed across an app restart instead of replaying an uncertain action', async () => {
    h.store.getOrCreateTurn.mockReturnValue({
      ...baseTurn,
      status: 'processing',
      sessionId: session.sessionId,
      promptText: 'User: What is running?',
      executionEpoch: 'old-process',
    });
    const response = await POST(request());
    const payload = await response.json() as { text: string };
    expect(response.status).toBe(200);
    expect(payload.text).toContain('stopped instead of risking the same action twice');
    expect(h.store.fail).toHaveBeenCalledOnce();
    expect(h.pollTurn).not.toHaveBeenCalled();
  });

  it('keeps direct prompts below the native byte limit as history grows', async () => {
    h.store.getConversation.mockReturnValue({ sessionId: session.sessionId, transcript: [] });
    h.loadSession.mockReturnValue({
      ...session,
      transcript: [{ role: 'user', text: '🧵'.repeat(12_000) }],
    });
    h.pollTurn.mockResolvedValue({ state: 'pending' });
    await POST(request({ context: '🧵'.repeat(10_000) }));
    const prompt = h.store.beginExecution.mock.calls[0][0].promptText as string;
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(40_000);
    expect(prompt).toContain(baseTurn.requestText);
  });

  it('runs shared iMessage turns through provider text generation without opening a native CLI', async () => {
    const conversationId = 'shared-imessage:group-1';
    h.store.getOrCreateTurn.mockReturnValue({ ...baseTurn, conversationId });

    const response = await POST(request({
      conversationId,
      context: 'Current plan: date is tentative, no venue booked.',
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, state: 'done', text: 'The date is still a working plan.' });
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.readPlanner).not.toHaveBeenCalled();
    expect(h.pollTurn).not.toHaveBeenCalled();
    expect(h.store.beginExecution).toHaveBeenCalledWith(expect.objectContaining({
      promptText: expect.stringContaining('Current plan: date is tentative'),
    }));
    expect(h.generateShared).toHaveBeenCalledWith(expect.stringContaining('Current plan: date is tentative'));
    expect(h.store.appendConversation).toHaveBeenCalledWith(expect.objectContaining({
      entries: [expect.objectContaining({ text: expect.stringContaining(baseTurn.senderHandle) })],
    }));
  });

  it('attributes a full-access group request to its sender in the native session', async () => {
    const conversationId = 'full-imessage:group-1';
    h.store.getOrCreateTurn.mockReturnValue({ ...baseTurn, conversationId });
    h.pollTurn.mockResolvedValue({ state: 'pending' });

    const response = await POST(request({ conversationId, context: 'Current plan.' }));

    expect(response.status).toBe(202);
    expect(h.readPlanner).toHaveBeenCalledOnce();
    expect(h.generateShared).not.toHaveBeenCalled();
    expect(h.store.beginExecution).toHaveBeenCalledWith(expect.objectContaining({
      promptText: expect.stringContaining(`${baseTurn.senderHandle}: ${baseTurn.requestText}`),
    }));
    expect(h.store.appendConversation).toHaveBeenCalledWith(expect.objectContaining({
      entries: [{ role: 'user', text: `${baseTurn.senderHandle}: ${baseTurn.requestText}` }],
    }));
  });

  it('returns processing for a replay while the shared provider call is still active', async () => {
    const conversationId = 'shared-imessage:group-2';
    h.store.getOrCreateTurn
      .mockReturnValueOnce({ ...baseTurn, conversationId })
      .mockReturnValueOnce({ ...baseTurn, conversationId, status: 'processing', executionEpoch: null });
    let finish!: (text: string) => void;
    h.generateShared.mockReturnValue(new Promise<string>((resolve) => { finish = resolve; }));
    const first = POST(request({ conversationId, context: 'Current plan.' }));
    const replay = await POST(request({ conversationId, context: 'Current plan.' }));
    expect(replay.status).toBe(202);
    expect(h.generateShared).toHaveBeenCalledTimes(1);
    finish('One answer.');
    expect((await first).status).toBe(200);
  });
});

it('forwards the Next inbound route with the flag unset without running the brain', async () => {
  vi.stubEnv('O8_NEXT_O8D', undefined);
  vi.stubEnv('O8_WS_PORT', '43219');
  const fetchOwner = vi.fn().mockResolvedValue(Response.json({ ok: true, state: 'done', text: 'Owner reply.' }));
  vi.stubGlobal('fetch', fetchOwner);
  try {
    const next = await import('./route');
    const response = await next.POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, state: 'done', text: 'Owner reply.' });
    expect(fetchOwner).toHaveBeenCalledWith('http://127.0.0.1:43219/api/symon/managed-messages/inbound', expect.objectContaining({ method: 'POST' }));
    expect(h.store.getOrCreateTurn).not.toHaveBeenCalled();
    expect(h.generateShared).not.toHaveBeenCalled();
    expect(h.pollTurn).not.toHaveBeenCalled();
    expect((globalThis as { __o8SymonBrain?: unknown }).__o8SymonBrain).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
