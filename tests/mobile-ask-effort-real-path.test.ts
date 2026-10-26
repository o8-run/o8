import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeMobileAskEffort, resolveMobileAskEffort } from '@/lib/mobile/ask-model-routing';

const boundary = vi.hoisted(() => ({ warm: vi.fn(), cli: vi.fn(), readiness: vi.fn(), hosted: vi.fn() }));
vi.mock('@/lib/claude-code/warm-repl-pool', () => ({ askClaudeWarm: boundary.warm }));
vi.mock('@/lib/cortex/qa/llm/codex-adapter', () => ({ callCodex: boundary.cli }));
vi.mock('@/lib/cortex/qa/llm/inference-route', () => ({ resolveOpenRouterRoute: boundary.hosted }));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  getRuntimeAuthSnapshotForClaudeCarrier: boundary.readiness,
}));
const { POST } = await import('@/app/api/mobile/genui/stream/route');

beforeEach(() => {
  vi.clearAllMocks();
  boundary.readiness.mockResolvedValue({ statuses: {
    claude: { installed: true, ready: true, binaryPath: 'fixture-warm-cli' },
    codex: { installed: true, ready: true, binaryPath: 'fixture-other-cli' },
  } });
  boundary.warm.mockImplementation(async (_prompt, options) => {
    options.onDelta?.('fixture answer');
    return 'fixture answer';
  });
  boundary.cli.mockResolvedValue('fixture answer');
});

function request(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/mobile/genui/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'show my tasks' }], stream: false, ...body }),
  }));
}

describe('mobile Ask explicit effort at the request entry point', () => {
  it.each(['bogus', '', 'ultra', null, 0, {}, ['low']])(
    'refuses malformed explicit effort %j before runtime detection', async (effort) => {
      const response = await request({ model: 'claude-sonnet', effort });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining('effort') } });
      expect(boundary.readiness).not.toHaveBeenCalled();
      expect(boundary.warm).not.toHaveBeenCalled();
      expect(boundary.cli).not.toHaveBeenCalled();
      expect(boundary.hosted).not.toHaveBeenCalled();
    },
  );

  it('refuses an unsupported low pin instead of dispatching medium after a model change', async () => {
    const first = await request({ model: 'claude-sonnet', effort: 'low' });
    expect(first.status).toBe(200);
    expect(boundary.warm.mock.calls[0][1].effort).toBe('low');
    boundary.warm.mockClear();
    const changed = await request({ model: 'claude-opus', effort: 'low' });
    expect(changed.status).toBe(400);
    expect(await changed.json()).toMatchObject({ error: { message: expect.stringContaining('low') } });
    expect(boundary.warm).not.toHaveBeenCalled();
    expect(boundary.cli).not.toHaveBeenCalled();
    // Saved-selection migration remains a separate, forgiving operation.
    expect(normalizeMobileAskEffort('old-value')).toBe('xhigh');
    expect(resolveMobileAskEffort('claude-opus', 'low')).toBe('medium');
  });

  it.each([
    { model: 'claude-sonnet', effort: 'low', kind: 'warm' },
    { model: 'claude-opus', effort: 'medium', kind: 'warm' },
    { model: 'claude-fable', effort: 'high', kind: 'warm' },
    { model: 'codex-sol-xhigh', effort: 'low', kind: 'cli' },
    { model: 'codex-astra-xhigh', effort: 'xhigh', kind: 'cli' },
  ])('forwards $effort unchanged for $model and returns its receipt', async ({ model, effort, kind }) => {
    const response = await request({ model, effort });
    expect(response.status).toBe(200);
    const captured = boundary[kind as 'warm' | 'cli'].mock.calls[0];
    expect(captured[0]).toContain('show my tasks');
    expect(captured[1][kind === 'warm' ? 'effort' : 'reasoningEffort']).toBe(effort);
    expect(response.headers.get('X-O8-Ask-Effort')).toBe(effort);
    expect((await response.json()).choices[0].message.content).toBe('fixture answer');
  });

  it.each(['claude-opus', 'codex-sol-xhigh'])('keeps the omitted xhigh default for %s', async (model) => {
    const response = await request({ model });
    expect(response.status).toBe(200);
    expect(response.headers.get('X-O8-Ask-Effort')).toBe('xhigh');
    const calls = model === 'claude-opus' ? boundary.warm.mock.calls : boundary.cli.mock.calls;
    expect(calls[0][1][model === 'claude-opus' ? 'effort' : 'reasoningEffort']).toBe('xhigh');
  });

  it.each(['claude-sonnet', 'codex-sol-xhigh'])('includes the applied effort receipt on the %s stream', async (model) => {
    const response = await request({ model, effort: 'low', stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('X-O8-Ask-Effort')).toBe('low');
    const stream = await response.text();
    expect(stream).toContain('fixture answer');
    expect(stream).toContain('[DONE]');
  });
});
