import { existsSync, readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getSqlite } from '@/lib/db';
import {
  getCanonicalChatHistoryPath,
  readPersistedLlmChat,
  writePersistedLlmChat,
} from '@/lib/llm/chat-history-store';
import { THINKING_EFFORTS } from '@/lib/orchestrator/thinking-effort';

vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));

const proxy = vi.fn(async () => new Response(
  'data: {"type":"content","text":"Fixture answer"}\n\ndata: {"type":"done"}\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } },
));
vi.stubGlobal('fetch', proxy);

const { POST } = await import('@/app/api/mobile/chat/send/route');
let sequence = 0;
let tabId: string;
const model = 'cli:codex:gpt-6.1-sol';

function request(effort?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/mobile/chat/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionKey: `llm-chat:${tabId}`, message: 'New fixture question', model, effort,
    }),
  });
}

function searchRow() {
  return getSqlite().prepare('SELECT * FROM chat_history WHERE tab_id = ?').get(tabId);
}

beforeEach(() => {
  tabId = `mobile-effort-${++sequence}`;
  proxy.mockClear();
});

afterAll(() => {
  closeDb();
  vi.unstubAllGlobals();
});

describe('mobile send effort validation through the route and persisted chat history', () => {
  const invalid = ['', ' ', ' high ', 'turbo', 'HIGH', 1, false, null, {}, ['high']];

  describe.each([false, true])('with an existing chat: %s', (existing) => {
    it.each(invalid.map((effort) => [effort]))('rejects malformed effort %j before any side effect', async (effort) => {
      if (existing) {
        writePersistedLlmChat(tabId, {
          model: 'cli:codex:gpt-5.6-sol', title: 'Retained fixture',
          messages: [{ id: 'original', role: 'user', content: 'Keep this history', timestamp: 1 }],
        });
      }
      const file = getCanonicalChatHistoryPath(tabId);
      const originalBytes = existsSync(file) ? readFileSync(file, 'utf8') : null;
      const originalRow = searchRow();

      const response = await POST(request(effort));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: 'invalid_effort' });
      expect(proxy).not.toHaveBeenCalled();
      expect(existsSync(file) ? readFileSync(file, 'utf8') : null).toBe(originalBytes);
      closeDb();
      expect(searchRow()).toEqual(originalRow);
    });
  });

  it.each([undefined, ...THINKING_EFFORTS])('preserves accepted effort %s and persists the streamed result', async (effort) => {
    const response = await POST(request(effort));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Fixture answer');
    expect(proxy).toHaveBeenCalledOnce();
    const [url, options] = proxy.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe('/api/v2/proxy/cli');
    const body = JSON.parse(options.body as string);
    expect(body).toMatchObject({ runtime: 'codex', model });
    if (effort === undefined) expect(body).not.toHaveProperty('effort');
    else expect(body.effort).toBe(effort);
    closeDb();
    expect(readPersistedLlmChat(tabId)?.history.messages.map(({ content }) => content))
      .toEqual(['New fixture question', 'Fixture answer']);
    expect(searchRow()).toMatchObject({ model });
  });

  it('rejects an unknown Codex model before dispatch or persistence', async () => {
    const response = await POST(new NextRequest('http://localhost/api/mobile/chat/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey: `llm-chat:${tabId}`, message: 'Hello', model: 'cli:codex:unknown' }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_model' });
    expect(proxy).not.toHaveBeenCalled();
    expect(readPersistedLlmChat(tabId)).toBeNull();
  });

  it('accepts a corrected request without duplicating the rejected user message', async () => {
    expect((await POST(request(''))).status).toBe(400);
    closeDb();
    const accepted = await POST(request('high'));
    expect(accepted.status).toBe(200);
    await accepted.text();
    expect(proxy).toHaveBeenCalledOnce();
    expect(readPersistedLlmChat(tabId)?.history.messages.filter(({ role }) => role === 'user'))
      .toHaveLength(1);
  });
});
