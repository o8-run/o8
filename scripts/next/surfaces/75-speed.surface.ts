import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

export default async function register({ dataDir }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--paired-speed')) return {};
  const sessionIds = ['thoughts-composer-first', 'thoughts-composer-second'];
  for (const [session, id] of sessionIds.entries()) {
    const file = join(dataDir, 'chat-history', `${id}.json`);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    saved.messages = Array.from({ length: 80 }, (_, index) => ({
      id: `speed-${session}-${index}`, role: index % 2 ? 'assistant' : 'user',
      content: `Session ${session} message ${index}\n\n${'Retain the draft and reading position. '.repeat(12)}`,
      timestamp: 1790812800000 + index * 1000,
    }));
    writeFileSync(file, JSON.stringify(saved));
  }
  return { receipt: { speedSessionIds: sessionIds } };
}
