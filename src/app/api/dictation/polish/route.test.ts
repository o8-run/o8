import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Anthropic key as the key store resolves it; null means none is saved.
const key = vi.hoisted(() => ({ value: 'sk-ant-fixture' as string | null, names: [] as string[] }));
vi.mock('@/lib/providers/key-store', () => ({
  resolveProviderKey: (name: string) => {
    key.names.push(name);
    return key.value;
  },
}));
// Polish never takes the OpenRouter or plan-proxy route.
const openRouter = vi.hoisted(() => ({ resolveOpenRouterRoute: vi.fn() }));
vi.mock('@/lib/cortex/qa/llm/inference-route', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/cortex/qa/llm/inference-route')>(),
  resolveOpenRouterRoute: openRouter.resolveOpenRouterRoute,
}));

import { POST } from './route';

const fetchMock = vi.fn();
const reply = (text: string) => new Response(JSON.stringify({
  content: [{ type: 'text', text }],
}), { status: 200 });
const polish = (transcript: string, context?: Record<string, unknown>) => POST(new Request('http://localhost/api/dictation/polish', {
  method: 'POST',
  body: JSON.stringify({ transcript, surface: 'terminal', ...(context ? { context } : {}) }),
}));
const call = (index: number) => fetchMock.mock.calls[index] as [string, RequestInit];
const sent = (index: number) => JSON.parse(String(call(index)[1].body));
const system = (index: number) => String(sent(index).system);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  key.value = 'sk-ant-fixture';
  key.names = [];
  openRouter.resolveOpenRouterRoute.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('POST /api/dictation/polish', () => {
  it('polishes with one Claude Haiku call and returns straight quotes', async () => {
    fetchMock.mockResolvedValueOnce(reply('It’s “done” ‘now’.'));
    const response = await polish('its done now');
    expect(await response.json()).toEqual({ text: 'It\'s "done" \'now\'.', polished: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = call(0);
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'x-api-key': 'sk-ant-fixture',
      'anthropic-version': '2023-06-01',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(key.names).toEqual(['ANTHROPIC_API_KEY']);
    const body = sent(0);
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'system']);
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.messages).toEqual([{ role: 'user', content: 'RAW TRANSCRIPT:\nits done now' }]);
    expect(system(0)).toContain('terminal');
  });

  it('returns the pre-cleaned transcript unpolished without a key, and calls nothing', async () => {
    key.value = null;
    const response = await polish('first line new line second line');
    expect(await response.json()).toEqual({ text: 'first line\nsecond line', polished: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the pre-cleaned transcript when Claude answers with an error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"type":"error","error":{"type":"overloaded_error"}}', { status: 529 }));
    const body = await (await polish('ship it')).json();
    expect(body).toMatchObject({ text: 'ship it', polished: false });
    expect(body.error).toContain('Claude HTTP 529');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back when the call times out or the network fails', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const body = await (await polish('ship it')).json();
    expect(body).toMatchObject({ text: 'ship it', polished: false });
    expect(body.error).toContain('timeout');
  });

  it('never resolves or calls the OpenRouter route, with or without a key', async () => {
    fetchMock.mockResolvedValueOnce(reply('Ship it.'));
    await polish('ship it');
    key.value = null;
    await polish('ship it');
    expect(openRouter.resolveOpenRouterRoute).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://api.anthropic.com/v1/messages']);
  });

  it('cancels a spoken cancel before any call', async () => {
    const body = await (await polish('Scratch that.')).json();
    expect(body).toMatchObject({ text: '', cancelled: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(key.names).toEqual([]);
  });

  it('adds the saved dictionary and instructions to the prompt when the caller sends them', async () => {
    fetchMock.mockResolvedValueOnce(reply('Ask Kubectl about o8.'));
    await polish('ask cube control about oh eight', {
      dictionary: [' Kubectl ', 'o8', '', 7],
      instructions: '  Always write o8 in lowercase.  ',
    });
    expect(system(0)).toContain('CUSTOM DICTIONARY (spell exactly as shown): Kubectl, o8\n');
    expect(system(0)).toContain('USER INSTRUCTIONS: Always write o8 in lowercase.\n');
  });

  it('keeps the prompt unchanged for callers that send neither', async () => {
    fetchMock.mockResolvedValueOnce(reply('Ship it.')).mockResolvedValueOnce(reply('Ship it.'));
    await polish('ship it');
    await polish('ship it', { dictionary: 'not a list', instructions: 42 });
    expect(system(0)).not.toContain('CUSTOM DICTIONARY');
    expect(system(0)).not.toContain('USER INSTRUCTIONS');
    expect(system(1)).toBe(system(0));
  });
});
