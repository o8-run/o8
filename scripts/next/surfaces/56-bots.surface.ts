/** Disposable mailbox files served by the production read-only bot routes. */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

export default async function register({ dataDir, repo, seeds }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--bots') && !process.argv.includes('--bot-settings')) return { routes: { 'GET /api/bots': async () => Response.json({ bots: [] }) } };
  // Other bot fixture modes represent previously completed Settings setup.
  // The Settings regression deliberately starts with no selections.
  const enableFixtureBots = async (bots: unknown[]) => {
    if (process.argv.includes('--bot-settings')) return;
    const { updateOperatorDefaults } = await import('../../../src/lib/operator/defaults');
    await updateOperatorDefaults({ botRailEnabledIds: bots.map(bot => (bot as { id: string }).id) });
  };
  const profiles = join(dataDir, 'bot-profiles');
  const directory = join(dataDir, 'bots', 'grok', 'agent-1');
  mkdirSync(profiles, { recursive: true });
  mkdirSync(directory, { recursive: true });
  process.env.O8_GROK_AGENT_DATA = profiles;
  const bot = { id: 'grok:agent-1', house: 'grok', name: 'Fixture bot', icon: { key: 'grok' },
    mainThread: { kind: 'mailbox', id: 'agent-1' }, status: 'unknown' };
  writeFileSync(join(dataDir, 'bots.json'), JSON.stringify({ bots: [bot] }));
  await enableFixtureBots([bot]);
  const mailbox = join(directory, 'thread.jsonl');
  const writeMessages = (messages: unknown[]) => writeFileSync(mailbox, messages.map(m => JSON.stringify(m)).join('\n') + '\n');
  writeMessages(Array.from({ length: 500 }, (_, n) => ({ id: `message-${n}`, role: 'bot',
    text: `Message ${n}`, at: new Date(Date.UTC(2026, 9, 31, 12, 0, n)).toISOString() })));
  const { GET: bots } = await import('../../../src/app/api/bots/route');
  const { GET: thread } = await import('../../../src/app/api/bots/[id]/thread/route');
  let requests = 0;
  let rosterRequests = 0;
  let failing = false;
  let rosterFailing = false;
  let collisionCount = 0;
  return {
    routes: {
      'GET /api/bots': async request => {
        rosterRequests += 1;
        return rosterFailing ? Response.json({ error: 'Fixture roster unavailable' }, { status: 503 }) : bots(request);
      },
      'GET /__fixture/bots/requests': async () => Response.json({ requests, rosterRequests }),
      'POST /__fixture/bots': async request => {
        const body = await request.json() as {
          messages?: unknown[]; bots?: unknown[]; failing?: boolean; rosterFailing?: boolean; addNativeThread?: boolean; collisionCount?: number;
        };
        if (Array.isArray(body.messages)) { writeMessages(body.messages); collisionCount = 0; }
        if ([42, 501, 502].includes(body.collisionCount ?? 0)) {
          const identical = { role: 'bot', text: 'Identical sender text\n'.repeat(20), at: '2026-10-31T12:00:00.000Z' };
          const messages = [identical, { ...identical, id: 'byte-0' }, ...Array.from({ length: body.collisionCount! - 2 }, (_, n) => ({
            id: `collision-${n}`, role: 'bot', text: `Message ${n}`, at: '2026-10-31T12:00:00.000Z',
          }))];
          if (collisionCount > 0 && body.collisionCount! >= collisionCount) {
            appendFileSync(mailbox, messages.slice(collisionCount).map(m => JSON.stringify(m)).join('\n') + '\n');
          } else writeMessages(messages);
          collisionCount = body.collisionCount!;
        }
        if (Array.isArray(body.bots)) {
          writeFileSync(join(dataDir, 'bots.json'), JSON.stringify({ bots: body.bots }));
          await enableFixtureBots(body.bots);
        }
        if (typeof body.failing === 'boolean') failing = body.failing;
        if (typeof body.rosterFailing === 'boolean') rosterFailing = body.rosterFailing;
        if (body.addNativeThread) {
          const seed = { id: 'thoughts-bots-late', title: 'A bot thread arriving later',
            messages: [{ id: 'late-message', role: 'assistant', content: 'Native bot thread', timestamp: 1790812800000 }] };
          writeFileSync(join(dataDir, 'chat-history', `${seed.id}.json`), JSON.stringify({ ...seed,
            repoPath: repo, backend: 'claude', model: 'claude-code', orchestratorVisible: true,
            savedAt: '2026-10-01T00:00:00.000Z' }));
          if (!seeds.some(s => s.id === seed.id)) seeds.push(seed);
        }
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
