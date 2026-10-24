import { writeFileSync } from 'node:fs';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
export default async function register({ dataDir, repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--brain')) return {};
  await (await import('../brain-fixture')).seedBrainFixture(dataDir, repo);
  const { POST: brainAsk } = await import('../../../src/app/api/cortex/ask/route');
  const requests: unknown[] = [];
  return {
    routes: { 'POST /api/cortex/ask': brainAsk },
    admit: ({ body }) => !body || !JSON.parse(body).repoPath || JSON.parse(body).repoPath === repo ? 200 : 400,
    before: ({ body }) => {
      if (body && process.env.O8_NEXT_BRAIN_REQUEST_LOG) {
        requests.push(JSON.parse(body));
        writeFileSync(process.env.O8_NEXT_BRAIN_REQUEST_LOG, JSON.stringify(requests));
      }
    },
    stream: [brainAsk],
  };
}
