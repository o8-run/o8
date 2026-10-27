import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

// The o8 backend runs the built-in Pi agent, and where Pi cannot start it streams
// a text-only reply from `/api/v2/proxy/llm`. Mock the impure seams the fallback
// touches — the loopback API base and the thread transcript reader — and stub
// global fetch to feed it fake proxy responses. Everything else (delegation, SSE
// parsing, event mapping, ordering) is the backend's own logic. The Pi path
// itself is driven end to end in tests/o8-model-pi-real-path.test.ts.
const mockReadMessages = vi.fn();
const mockFetch = vi.fn();
const mockEntitlement = vi.fn();

vi.mock('@/lib/panel/api-port', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/panel/api-port')>(),
  getApiBase: () => 'http://127.0.0.1:3001',
}));
vi.mock('@/lib/ws-auth', () => ({
  getOrCreateWsToken: () => 'test-ws-token-abc',
}));
vi.mock('@/lib/mobile/orchestrator-thread-history', () => ({
  readOrchestratorThreadMessages: (...args: unknown[]) => mockReadMessages(...args),
}));
vi.mock('@/lib/entitlement/store', () => ({
  getEntitlementSync: () => mockEntitlement(),
}));

// Imported after the mocks so the backend binds them.
import { createO8Backend, o8BuiltInAgentBlocker, o8SystemPrompt } from './o8';
import type { OrchestratorBackend } from './types';

const BLOCKER = 'o8\'s built-in agent runs on macOS and Linux, and Windows support is not available yet';
const NOTICE = { type: 'text', text: `${BLOCKER}, so this reply is text only, without o8 commands, file edits or tools.\n\n` };
const piSendTurn = vi.fn<OrchestratorBackend['sendTurn']>(async () => {});
const fakePi: OrchestratorBackend = {
  id: 'pi',
  label: 'Pi',
  peekSession: () => ({ sessionName: 'pi-session', status: 'busy' }),
  ensureSession: () => ({ sessionName: 'pi-session', status: 'ready' }),
  sendTurn: piSendTurn,
};
/** The text-only fallback, as on a machine where Pi cannot start. */
const o8Backend = createO8Backend({ pi: fakePi, blocker: () => BLOCKER });

/** A fake SSE proxy response streaming the given `data: …\n\n` frames. */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return { ok: true, body } as unknown as Response;
}

function contentFrame(text: string): string {
  return `data: ${JSON.stringify({ type: 'content', text })}\n\n`;
}

function collect(): { events: OrchestratorEvent[]; onEvent: (e: OrchestratorEvent) => void } {
  const events: OrchestratorEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

beforeEach(() => {
  mockReadMessages.mockReset().mockReturnValue([{ role: 'user', content: 'hi' }]);
  mockFetch.mockReset();
  piSendTurn.mockClear();
  // Default the whole suite to the FREE plan so the tools-off assertions are
  // deterministic on any machine (getEntitlementSync would otherwise read the
  // real founder entitlement on Q's box). Paid-tier tests override per-case.
  mockEntitlement.mockReset().mockReturnValue({ plan: 'free' });
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('o8 backend event mapping', () => {
  it('maps proxy content frames to text events, then a terminal done', async () => {
    mockFetch.mockResolvedValue(sseResponse([
      contentFrame('Hel'),
      contentFrame('lo'),
      'data: [DONE]\n\n',
    ]));
    const { events, onEvent } = collect();

    await o8Backend.sendTurn('/repo', 'hi', onEvent, { threadId: 'thoughts-1' });

    expect(events).toEqual([
      { type: 'turn_receipt', leadModel: 'o8-free', effort: 'adaptive', effortSource: 'runtime-default', serviceTier: 'low' },
      NOTICE,
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'done', sessionId: expect.any(String), cost: 0 },
    ]);
  });

  it('attaches the ws-token bearer so the gated proxy authorizes by token, not the flaky loopback heuristic', async () => {
    mockFetch.mockResolvedValue(sseResponse([contentFrame('ok'), 'data: [DONE]\n\n']));
    const { onEvent } = collect();

    await o8Backend.sendTurn('/repo', 'hi', onEvent, { threadId: 'thoughts-1' });

    const init = mockFetch.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer test-ws-token-abc');
  });

  it('does not label a text fallback with a stale model from another provider', async () => {
    mockFetch.mockResolvedValue(sseResponse([contentFrame('ok'), 'data: [DONE]\n\n']));
    const { events, onEvent } = collect();
    await o8Backend.sendTurn('/repo', 'hi', onEvent, { model: 'claude-opus-5' });
    expect(events[0]).toMatchObject({ type: 'turn_receipt', leadModel: 'o8-free' });
  });

  it('surfaces an in-stream proxy error frame as an error event, then done', async () => {
    mockFetch.mockResolvedValue(sseResponse([
      contentFrame('partial'),
      `data: ${JSON.stringify({ type: 'error', message: 'model exploded' })}\n\n`,
    ]));
    const { events, onEvent } = collect();

    await o8Backend.sendTurn('/repo', 'hi', onEvent, { threadId: 'thoughts-1' });

    expect(events[0]).toEqual({ type: 'turn_receipt', leadModel: 'o8-free', effort: 'adaptive', effortSource: 'runtime-default', serviceTier: 'low' });
    expect(events[1]).toEqual(NOTICE);
    expect(events[2]).toEqual({ type: 'text', text: 'partial' });
    expect(events[3]).toEqual({ type: 'error', error: 'model exploded' });
    expect(events[events.length - 1].type).toBe('done');
  });

  it('emits the receipt and done on a user abort (a stop is not an error)', async () => {
    const controller = new AbortController();
    controller.abort();
    mockFetch.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const { events, onEvent } = collect();

    await o8Backend.sendTurn('/repo', 'hi', onEvent, { threadId: 'thoughts-1', signal: controller.signal });

    expect(events).toEqual([
      { type: 'turn_receipt', leadModel: 'o8-free', effort: 'adaptive', effortSource: 'runtime-default', serviceTier: 'low' },
      NOTICE,
      { type: 'done', sessionId: expect.any(String), cost: 0 },
    ]);
  });

  it('surfaces a non-200 proxy response (JSON error body) as an error line, then done', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      body: null,
      json: async () => ({ error: 'Gemini quota exhausted and no fallback configured.' }),
    } as unknown as Response);
    const { events, onEvent } = collect();

    await o8Backend.sendTurn('/repo', 'hi', onEvent, { threadId: 'thoughts-1' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(events[2].type).toBe('error');
    expect((events[2] as { error: string }).error).toContain('Gemini quota exhausted');
    expect(events[events.length - 1].type).toBe('done');
  });

  it('replays the persisted transcript as-is when it ends on the user turn (no doubling)', async () => {
    const transcript = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ];
    mockReadMessages.mockReturnValue(transcript);
    mockFetch.mockResolvedValue(sseResponse([contentFrame('ok'), 'data: [DONE]\n\n']));
    const { onEvent } = collect();

    await o8Backend.sendTurn('/repo', 'second-with-session-rules', onEvent, { threadId: 'thoughts-1' });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body) as {
      model: string; provider: string; disableTools: boolean; messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('o8-operator');
    expect(body.provider).toBe('operator');
    expect(body.disableTools).toBe(true);
    // System prompt first, then the transcript verbatim (no appended duplicate turn).
    expect(body.messages[0].role).toBe('system');
    expect(body.messages.slice(1)).toEqual(transcript);
  });

  it('falls back to the raw message param when there is no persisted transcript', async () => {
    mockReadMessages.mockReturnValue([]);
    mockFetch.mockResolvedValue(sseResponse([contentFrame('ok'), 'data: [DONE]\n\n']));
    const { onEvent } = collect();

    await o8Backend.sendTurn('/repo', 'lone message', onEvent, { threadId: null });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0].role).toBe('system');
    expect(body.messages.slice(1)).toEqual([{ role: 'user', content: 'lone message' }]);
  });
});

describe('o8 backend runs the built-in Pi agent', () => {
  it('hands the turn, session lookups and options to Pi untouched, and never calls the proxy', async () => {
    const backend = createO8Backend({ pi: fakePi, blocker: () => null });
    const { onEvent } = collect();
    const options = { threadId: 'thoughts-1', permissionMode: 'plan' as const, thinkingEffort: 'adaptive' as const };

    await backend.sendTurn('/repo', 'list the repos', onEvent, options);

    expect(piSendTurn).toHaveBeenCalledWith('/repo', 'list the repos', expect.any(Function), options);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(backend.id).toBe('o8');
    expect(backend.peekSession('/repo', undefined, 'thoughts-1')).toEqual({ sessionName: 'pi-session', status: 'busy' });
    expect(backend.ensureSession('/repo', undefined, 'thoughts-1')).toEqual({ sessionName: 'pi-session', status: 'ready' });
  });

  it('puts the o8 model the turn was sent with on Pi\'s receipt, so the thread and its receipt agree', async () => {
    piSendTurn.mockImplementation(async (_repoPath, _message, onEvent) => {
      onEvent({ type: 'turn_receipt', leadModel: 'pi', effort: 'adaptive', effortSource: 'runtime-default' });
      onEvent({ type: 'text', text: 'ok' });
    });
    const backend = createO8Backend({ pi: fakePi, blocker: () => null });
    for (const [model, leadModel] of [['o8-next', 'o8-next'], [undefined, 'o8-free'], ['claude-opus-5', 'o8-free'], ['gpt-6.1-sol', 'o8-free'], ['', 'o8-free']] as const) {
      const { events, onEvent } = collect();
      await backend.sendTurn('/repo', 'hi', onEvent, { threadId: 'thoughts-1', model });
      expect(events).toEqual([{ type: 'turn_receipt', leadModel, effort: 'adaptive', effortSource: 'runtime-default' }, { type: 'text', text: 'ok' }]);
    }
    piSendTurn.mockReset();
  });

  it('names the reason Pi cannot start on Windows', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(o8BuiltInAgentBlocker()).toBe(BLOCKER);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('o8 text-only fallback where Pi cannot start', () => {
  function bodyOf(): { disableTools: boolean; repoPath?: string; messages: Array<{ role: string; content: string }> } {
    return JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
  }

  it.each(['free', 'founder'])('%s plan + scoped repo → no tools, no repoPath, a text-only prompt', async (plan) => {
    mockEntitlement.mockReturnValue({ plan });
    mockFetch.mockResolvedValue(sseResponse([contentFrame('ok'), 'data: [DONE]\n\n']));
    const { events, onEvent } = collect();

    await o8Backend.sendTurn('/Users/me/proj', 'build a game', onEvent, { threadId: 'thoughts-1' });

    const body = bodyOf();
    expect(body.disableTools).toBe(true);
    expect(body.repoPath).toBeUndefined();
    expect(body.messages[0].content).toMatch(/text only/i);
    expect(events[1]).toEqual(NOTICE);
    expect(piSendTurn).not.toHaveBeenCalled();
  });

  it.each(
    (['free', 'pro', 'team', 'founder'] as const).flatMap((plan) => (
      [undefined, 'low', 'high'].map((thinkingEffort) => ({ plan, thinkingEffort }))
    )),
  )('$plan plan, effort $thinkingEffort → labels a default service tier or refuses an independent pin', async ({ plan, thinkingEffort }) => {
    mockEntitlement.mockReturnValue({ plan });
    mockFetch.mockResolvedValue(sseResponse([contentFrame('ok'), 'data: [DONE]\n\n']));
    const { events, onEvent } = collect();

    await o8Backend.sendTurn('/repo', 'hi', onEvent, {
      threadId: 'thoughts-1',
      ...(thinkingEffort ? { thinkingEffort: thinkingEffort as 'low' | 'high' } : {}),
    });

    if (thinkingEffort) {
      expect(mockFetch).not.toHaveBeenCalled();
      expect(events[0]).toMatchObject({ type: 'error', code: 'effort_unsupported_runtime' });
    } else {
      expect((bodyOf() as { thinkingEffort?: string }).thinkingEffort).toBe('low');
      expect(events[0]).toMatchObject({ type: 'turn_receipt', effort: 'adaptive', effortSource: 'runtime-default', serviceTier: 'low' });
    }
  });

  it('ignores tool frames: the fallback renders text only', async () => {
    mockFetch.mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ type: 'tool_use', toolName: 'create_file', toolCallId: 't1', arguments: { file_path: 'x.html' } })}\n\n`,
      contentFrame('Done.'),
      'data: [DONE]\n\n',
    ]));
    const { events, onEvent } = collect();

    await o8Backend.sendTurn('/Users/me/proj', 'make x.html', onEvent, { threadId: 'thoughts-1' });

    expect(events.map((event) => event.type)).toEqual(['turn_receipt', 'text', 'text', 'done']);
  });
});

// 2026-07-15 six-hour-timer incident: the turn's fetch and stream reads were
// unbounded awaits, so a proxy that accepted the request and then went silent
// wedged the turn forever — no error, no done, a busy latch that survived the
// night. These drive the REAL sendTurn against a hung mock and assert the
// inactivity watchdog terminalizes the turn visibly.
describe('o8 backend inactivity watchdog (wedged-turn class)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Mock fetch honoring init.signal the way real fetch does for its body. */
  function hungStreamFetch(framesBeforeHang: string[] = []) {
    const encoder = new TextEncoder();
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of framesBeforeHang) controller.enqueue(encoder.encode(frame));
          // …then never enqueue again and never close: the hang.
          init.signal?.addEventListener('abort', () => {
            controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        },
      });
      return Promise.resolve({ ok: true, body } as unknown as Response);
    });
  }

  it('a stream that goes silent forever is terminalized: watchdog error, then done', async () => {
    hungStreamFetch();
    const { events, onEvent } = collect();

    const turn = o8Backend.sendTurn('/repo', 'hi', onEvent, { threadId: 'thoughts-1' });
    await vi.advanceTimersByTimeAsync(300_000);
    await turn;

    expect(events[2].type).toBe('error');
    expect((events[2] as { error: string }).error).toMatch(/went silent/);
    expect(events[events.length - 1].type).toBe('done');
  });

  it('a fetch that never returns headers is terminalized the same way', async () => {
    mockFetch.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }));
    const { events, onEvent } = collect();

    const turn = o8Backend.sendTurn('/repo', 'hi', onEvent, { threadId: 'thoughts-1' });
    await vi.advanceTimersByTimeAsync(300_000);
    await turn;

    expect(events[2].type).toBe('error');
    expect((events[2] as { error: string }).error).toMatch(/went silent/);
    expect(events[events.length - 1].type).toBe('done');
  });

  it('received bytes re-arm the watchdog, and streamed text survives the eventual timeout', async () => {
    hungStreamFetch([contentFrame('partial answer')]);
    const { events, onEvent } = collect();

    const turn = o8Backend.sendTurn('/repo', 'hi', onEvent, { threadId: 'thoughts-1' });
    await vi.advanceTimersByTimeAsync(300_000);
    await turn;

    expect(events).toContainEqual({ type: 'text', text: 'partial answer' });
    expect(events.some((e) => e.type === 'error' && (e as { error: string }).error.match(/went silent/))).toBe(true);
    expect(events[events.length - 1].type).toBe('done');
  });
});


describe('o8SystemPrompt', () => {
  it('says the reply is text only on both tiers', () => {
    for (const tier of ['low', 'high'] as const) {
      const prompt = o8SystemPrompt(tier);
      expect(prompt).toMatch(/text only/i);
      expect(prompt).not.toMatch(/file tools attached/i);
    }
  });
});
