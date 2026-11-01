/** Disposable mailbox files served by the production read-only bot routes. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

export default async function register({ dataDir }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--bots')) return {};
  const profiles = join(dataDir, 'bot-profiles');
  const directory = join(dataDir, 'bots', 'grok', 'agent-1');
  mkdirSync(profiles, { recursive: true });
  mkdirSync(directory, { recursive: true });
  process.env.O8_GROK_AGENT_DATA = profiles;
  const bot = { id: 'grok:agent-1', house: 'grok', name: 'Fixture bot', icon: { key: 'grok' },
    mainThread: { kind: 'mailbox', id: 'agent-1' }, status: 'unknown' };
  writeFileSync(join(dataDir, 'bots.json'), JSON.stringify({ bots: [bot] }));
  const mailbox = join(directory, 'thread.jsonl');
  const writeMessages = (messages: unknown[]) => writeFileSync(mailbox, messages.map(m => JSON.stringify(m)).join('\n') + '\n');
  writeMessages(Array.from({ length: 500 }, (_, n) => ({ id: `message-${n}`, role: 'bot',
    text: `Message ${n}`, at: new Date(Date.UTC(2026, 9, 31, 12, 0, n)).toISOString() })));
  const { GET: bots } = await import('../../../src/app/api/bots/route');
  const { GET: thread } = await import('../../../src/app/api/bots/[id]/thread/route');
  let requests = 0;
  let failing = false;
  return {
    routes: {
      'GET /api/bots': bots,
      'GET /__fixture/bots/requests': async () => Response.json({ requests }),
      'POST /__fixture/bots': async request => {
        const body = await request.json() as { messages?: unknown[]; failing?: boolean };
        if (Array.isArray(body.messages)) writeMessages(body.messages);
        if (typeof body.failing === 'boolean') failing = body.failing;
        return Response.json({ ok: true });
      },
    },
    match: (method, pathname) => method === 'GET' && /^\/api\/bots\/[^/]+\/thread$/.test(pathname)
      ? async request => {
        requests += 1;
        if (failing) return Response.json({ error: 'Fixture mailbox unavailable' }, { status: 503 });
        return thread(request, { params: Promise.resolve({ id: decodeURIComponent(pathname.split('/')[3]) }) });
      } : undefined,
    admit: () => 200,
  };
}
