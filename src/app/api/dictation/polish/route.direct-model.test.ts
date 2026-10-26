import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route a caller resolves; each case picks a direct BYOK key or the
// managed proxy. The upstream endpoint is a stub.
const route = vi.hoisted(() => ({ via: 'direct' as 'direct' | 'proxy' | 'local' }));
vi.mock('@/lib/cortex/qa/llm/inference-route', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/cortex/qa/llm/inference-route')>(),
  resolveOpenRouterRoute: async () => ({
    url: route.via === 'direct' ? 'https://openrouter.test/api/v1/chat/completions' : 'https://relay.test/v1/inference',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture' },
    via: route.via,
  }),
}));

import { openRouterTextModels } from '@/lib/cortex/qa/llm/inference-route';
import { POST } from './route';

const fetchMock = vi.fn();
const completion = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const polish = (transcript: string) => POST(new Request('http://localhost/api/dictation/polish', {
  method: 'POST',
  body: JSON.stringify({ transcript, surface: 'terminal' }),
}));
const sent = (index: number) => JSON.parse(String((fetchMock.mock.calls[index] as [string, RequestInit])[1].body));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  route.via = 'direct';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('O8_OPENROUTER_TEXT_MODEL on the dictation polish route', () => {
  it('sends the override first on a direct key, without the Luna-only reasoning field', async () => {
    vi.stubEnv('O8_OPENROUTER_TEXT_MODEL', ' deepseek/deepseek-v4-flash ');
    fetchMock.mockResolvedValueOnce(completion('Ship it.'));
    expect(await (await polish('ship it')).json()).toEqual({ text: 'Ship it.', polished: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(0).model).toBe('deepseek/deepseek-v4-flash');
    expect(sent(0)).not.toHaveProperty('reasoning_effort');
  });

  it('keeps the $0 model as the fallback when the override fails', async () => {
    vi.stubEnv('O8_OPENROUTER_TEXT_MODEL', 'deepseek/deepseek-v4-flash');
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":"unavailable"}', { status: 503 }))
      .mockResolvedValueOnce(completion('Ship it.'));
    await polish('ship it');
    expect(fetchMock.mock.calls.map((_, index) => sent(index).model)).toEqual([
      'deepseek/deepseek-v4-flash',
      'nvidia/nemotron-3.5-lightning:free',
    ]);
  });

  it('never applies the override on the managed proxy', async () => {
    route.via = 'proxy';
    vi.stubEnv('O8_OPENROUTER_TEXT_MODEL', 'deepseek/deepseek-v4-flash');
    fetchMock.mockResolvedValueOnce(completion('Ship it.'));
    await polish('ship it');
    expect(sent(0)).toMatchObject({ model: 'openai/gpt-6-luna', reasoning_effort: 'none' });
  });

  it('ignores a malformed override and keeps the managed text model', async () => {
    vi.stubEnv('O8_OPENROUTER_TEXT_MODEL', 'not a model id');
    fetchMock.mockResolvedValueOnce(completion('Ship it.'));
    await polish('ship it');
    expect(sent(0)).toMatchObject({ model: 'openai/gpt-6-luna', reasoning_effort: 'none' });
  });
});

describe('openRouterTextModels', () => {
  it.each([
    ['direct', { O8_OPENROUTER_TEXT_MODEL: 'deepseek/deepseek-v4-flash' }, 'deepseek/deepseek-v4-flash'],
    ['direct', { O8_OPENROUTER_TEXT_MODEL: 'meta-llama/llama-4-scout:free' }, 'meta-llama/llama-4-scout:free'],
    ['direct', {}, 'openai/gpt-6-luna'],
    ['direct', { O8_OPENROUTER_TEXT_MODEL: '   ' }, 'openai/gpt-6-luna'],
    ['proxy', { O8_OPENROUTER_TEXT_MODEL: 'deepseek/deepseek-v4-flash' }, 'openai/gpt-6-luna'],
    ['local', { O8_OPENROUTER_TEXT_MODEL: 'deepseek/deepseek-v4-flash' }, 'openai/gpt-6-luna'],
  ] as const)('%s with %j leads with %s', (via, env, first) => {
    expect(openRouterTextModels(via, env)).toEqual([first, 'nvidia/nemotron-3.5-lightning:free']);
  });
});
