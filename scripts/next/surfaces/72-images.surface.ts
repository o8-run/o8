import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAFAAAAAwCAIAAAAJh2qgAAAAVklEQVR4nO3PAQ3AIADAMEAOnlCOmbv4k71VsM197viT9XXA2wzXGa4zXGe4znCd4TrDdYbrDNcZrjNcZ7jOcJ3hOsN1husM1xmuM1xnuM5wneE6w3UPI0QBwum7oOkAAAAASUVORK5CYII=';
export default async function register({ dataDir, repo, seeds }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--images')) return {};
  const { persistComposerImages } = await import('../../../src/lib/mobile/orchestrator-image-media');
  const [saved] = persistComposerImages([{ name: 'Sent screenshot.png', dataUri: `data:image/png;base64,${png}` }]);
  const corrupt = join(dataDir, 'media', 'corrupt.png');
  const missing = join(dataDir, 'media', 'missing.png');
  const outside = join(repo, 'outside.png');
  mkdirSync(join(dataDir, 'media'), { recursive: true });
  writeFileSync(corrupt, 'unreadable image');
  writeFileSync(outside, Buffer.from(png, 'base64'));
  const messages = [
    { id: 'user-image', role: 'user', content: 'A sent screenshot', media: [saved] },
    { id: 'assistant-image', role: 'assistant', content: 'Image media', media: [saved] },
    ...[['missing-image', missing], ['corrupt-image', corrupt], ['outside-image', outside]].map(([id, path]) => ({
      id, role: 'assistant', content: '', media: [{ kind: 'image', path, name: 'Unavailable.png', mimeType: 'image/png' }],
    })),
  ].map((message, index) => ({ ...message, timestamp: 1790812800000 + index * 1000 }));
  const id = 'thoughts-image-fixture';
  seeds.push({ id, title: 'Image history fixture', messages });
  writeFileSync(join(dataDir, 'chat-history', `${id}.json`), JSON.stringify({
    id, title: 'Image history fixture', messages, repoPath: repo, backend: 'claude', model: 'claude-code',
    orchestratorVisible: true, savedAt: '2026-10-01T02:00:00.000Z',
  }));
  if (process.argv.includes('--composer-loaded')) {
    const file = join(dataDir, 'chat-history', 'thoughts-composer-loaded.json');
    const { readFileSync } = await import('node:fs');
    const history = JSON.parse(readFileSync(file, 'utf8'));
    for (const index of [0, 199]) history.messages[index].media = [saved];
    writeFileSync(file, JSON.stringify(history));
  }
  const media = await import('../../../src/app/api/mobile/media/route');
  const reads = new Map<string, number>();
  return {
    routes: {
      'GET /api/mobile/media': media.GET,
      'GET /api/image-fixture': async () => Response.json({ reads: Object.fromEntries(reads), saved: saved.path, outside }),
    },
    before: ({ route, url }) => {
      if (route === media.GET) {
        const path = url.searchParams.get('path') ?? '';
        reads.set(path, (reads.get(path) ?? 0) + 1);
      }
    },
  };
}
