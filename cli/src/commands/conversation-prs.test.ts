import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXIT } from '../api.js';
import { runConversationPrs } from './conversation-prs.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.each(['add', 'remove'] as const)('o8 conversation-prs %s', (action) => {
  const args = [action, '--thread', 'thread-1', '--repo', 'owner/repo', '--number', '42'];
  const mode = { human: false, verbose: false };

  it.each([
    { label: 'empty 204', status: 204, body: null },
    { label: 'empty 200', status: 200, body: null },
    { label: 'JSON null', status: 200, body: 'null' },
    { label: 'missing identity', status: 200, body: '{"result":{}}' },
  ])('rejects an absent identity ($label) before mutating', async ({ status, body }) => {
    vi.stubEnv('O8_API_PORT', '47120');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status }));

    await expect(runConversationPrs(mode, args)).rejects.toMatchObject({
      name: 'CliError',
      code: 'invalid_response',
      message: 'Conversation PR identity resolution returned no identity.',
      exit: EXIT.INVALID_ARGS,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(String(url)).searchParams.get('resolve')).toBe('1');
    expect(init?.method).toBe('GET');
  });

  it('mutates with the resolved identity', async () => {
    vi.stubEnv('O8_API_PORT', '47120');
    const identity = { host: 'github.com', repositoryId: 123, pullRequestId: 456, number: 42 };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { identity } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runConversationPrs(mode, args)).resolves.toBe(EXIT.OK);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url] = fetchMock.mock.calls[0];
    expect(new URL(String(url)).searchParams.get('refresh')).toBe(action === 'add' ? '1' : null);
    const [, init] = fetchMock.mock.calls[1];
    expect(init?.method).toBe(action === 'add' ? 'POST' : 'DELETE');
    expect(JSON.parse(String(init?.body))).toEqual({ ...identity, threadId: 'thread-1', kind: 'context' });
  });
});
