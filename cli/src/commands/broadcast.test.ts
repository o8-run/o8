import { afterEach, describe, expect, it, vi } from 'vitest';

import { runBroadcast } from './broadcast';

const originalPort = process.env.O8_API_PORT;
const originalToken = process.env.O8_API_TOKEN;
const originalWorkerToken = process.env.O8_WORKER_TOKEN;
const originalWorkerPacketId = process.env.O8_WORKER_PACKET_ID;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalPort === undefined) delete process.env.O8_API_PORT;
  else process.env.O8_API_PORT = originalPort;
  if (originalToken === undefined) delete process.env.O8_API_TOKEN;
  else process.env.O8_API_TOKEN = originalToken;
  if (originalWorkerToken === undefined) delete process.env.O8_WORKER_TOKEN;
  else process.env.O8_WORKER_TOKEN = originalWorkerToken;
  if (originalWorkerPacketId === undefined) delete process.env.O8_WORKER_PACKET_ID;
  else process.env.O8_WORKER_PACKET_ID = originalWorkerPacketId;
});

describe('Broadcast CLI commands', () => {
  it('posts a scheduled line through the packet-bound automation endpoint', async () => {
    process.env.O8_API_PORT = '40123';
    delete process.env.O8_API_TOKEN;
    process.env.O8_WORKER_TOKEN = 'packet-worker-token';
    process.env.O8_WORKER_PACKET_ID = 'packet-automation-one';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      schema: 'o8/broadcast.automation-say/v1',
      ok: true,
      result: { status: 'recorded', eventId: 'automation-attention-one', reason: null },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runBroadcast(
      { human: false, verbose: false },
      'automation-say',
      ['Three approvals need you.'],
    )).resolves.toBe(0);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:40123/api/broadcast/automation-say');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer packet-worker-token' });
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'Three approvals need you.' });
  });

  it('sets and clears focus through the aligned post endpoint', async () => {
    process.env.O8_API_PORT = '40123';
    process.env.O8_API_TOKEN = 'operator-token';
    delete process.env.O8_WORKER_TOKEN;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (
      new Response(JSON.stringify({
        schema: 'o8/broadcast.post/v1',
        ok: true,
        event: {
          id: 'focus-one',
          kind: 'focus',
          actor: 'operator',
          title: 'Ship focus',
          goal: 'Keep the room oriented.',
          issue: 1842,
          startedAt: '2026-08-21T00:00:00.000Z',
          cleared: false,
          timestamp: '2026-08-21T00:00:00.000Z',
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    ));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runBroadcast(
      { human: false, verbose: false },
      'focus',
      ['Ship focus', '--goal', 'Keep the room oriented.', '--issue', '1842'],
    )).resolves.toBe(0);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      kind: 'focus',
      title: 'Ship focus',
      goal: 'Keep the room oriented.',
      issue: 1842,
    });

    await expect(runBroadcast(
      { human: false, verbose: false },
      'focus',
      ['--clear'],
    )).resolves.toBe(0);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      kind: 'focus',
      clear: true,
    });
  });

  it('posts a conversation through the aligned post endpoint', async () => {
    process.env.O8_API_PORT = '40123';
    process.env.O8_API_TOKEN = 'operator-token';
    delete process.env.O8_WORKER_TOKEN;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      schema: 'o8/broadcast.post/v1',
      ok: true,
      event: {
        id: 'broadcast-one',
        kind: 'conversation',
        actor: 'operator',
        audience: 'mister',
        text: 'Give us the latest.',
        timestamp: '2026-08-21T00:00:00.000Z',
      },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runBroadcast(
      { human: false, verbose: false },
      'post',
      ['--kind', 'conversation', '--as', 'operator', '--to', 'mister', 'Give us the latest.'],
    )).resolves.toBe(0);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:40123/api/broadcast/post');
    expect(JSON.parse(String(init?.body))).toEqual({
      kind: 'conversation',
      actor: 'operator',
      audience: 'mister',
      text: 'Give us the latest.',
    });
  });

  it('mints through the real API client and emits a fragment-only spectator URL', async () => {
    process.env.O8_API_PORT = '40123';
    process.env.O8_API_TOKEN = 'operator-token';
    delete process.env.O8_WORKER_TOKEN;
    delete process.env.O8_WORKER_PACKET_ID;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      schema: 'o8/broadcast.token.mint/v1',
      ok: true,
      token: { id: 'spectator-one', label: 'OBS', createdAt: '2026-08-21T00:00:00.000Z', revokedAt: null },
      bearer: 'o8sp_secret',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runBroadcast({ human: false, verbose: false }, 'token', ['mint', '--label', 'OBS']))
      .resolves.toBe(0);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:40123/api/broadcast/tokens');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer operator-token' });
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'mint', label: 'OBS' });
    const output = write.mock.calls.map(([value]) => String(value)).join('');
    expect(output).toContain('http://127.0.0.1:40123/broadcast#token=o8sp_secret');
    expect(output).not.toContain('/broadcast?token=');
  });

  it('mints a truth spectator with repeated repository grants', async () => {
    process.env.O8_API_PORT = '40123';
    process.env.O8_API_TOKEN = 'operator-token';
    delete process.env.O8_WORKER_TOKEN;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      schema: 'o8/broadcast.token.mint/v1',
      ok: true,
      token: {
        id: 'spectator-truth',
        label: 'truth',
        repoGrants: ['repo-a', 'example.test/team/repo-b'],
        createdAt: '2026-08-29T20:00:00.000Z',
        revokedAt: null,
      },
      bearer: 'o8sp_truth_secret',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runBroadcast({ human: false, verbose: false }, 'token', [
      'mint', '--label', 'truth', '--repo', 'repo-a', '--repo', 'example.test/team/repo-b',
    ])).resolves.toBe(0);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      action: 'mint',
      label: 'truth',
      repoGrants: ['repo-a', 'example.test/team/repo-b'],
    });
  });

  it('revokes exactly one durable token id', async () => {
    process.env.O8_API_PORT = '40123';
    process.env.O8_API_TOKEN = 'operator-token';
    delete process.env.O8_WORKER_TOKEN;
    delete process.env.O8_WORKER_PACKET_ID;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      schema: 'o8/broadcast.token.revoke/v1',
      ok: true,
      token: { id: 'spectator-one', label: null, createdAt: '2026-08-21T00:00:00.000Z', revokedAt: '2026-08-21T00:01:00.000Z' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runBroadcast({ human: false, verbose: false }, 'token', ['revoke', 'spectator-one']))
      .resolves.toBe(0);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'revoke', id: 'spectator-one' });
  });
});
