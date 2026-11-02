/** Fixture usage readings in the shapes /api/runtime/capacity and /api/runtime/usage return. */
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

export default async function register(_: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--usage')) return {};
  const totals = { uncachedInputTokens: 1000, cachedInputTokens: 5000, cacheCreationTokens: 200, outputTokens: 800, reasoningTokens: 0 };
  const bucket = (day: string, provider: string, model: string) => ({ day, provider, model, totals, costUsd: 4.5,
    cacheSavingsUsd: 1.25, categoryCostUsd: { input: 1, cacheRead: 0.5, cacheWrite: 1, output: 2 }, sessions: 2, records: 10,
    unpricedRecords: 0, reportedRecords: 0, fastCostUsd: 0, speedPremiumUsd: 0 });
  return { priority: 10, routes: {
    'GET /api/runtime/capacity': async () => Response.json({ schema: 'o8/runtime-capacity-control/v1', identities: [],
      capacities: [{ runtime: 'codex', status: 'ok', confidence: 'exact', observedAt: '2026-11-01T00:00:00.000Z',
        buckets: [{ id: 'week', label: 'Weekly', usedRatio: 0.42, resetsAt: '2026-11-04T12:00:00.000Z' }] }] }),
    'GET /api/runtime/usage': async () => Response.json({ schema: 'o8/usage-history/v1', since: 0, until: 1, timeZone: 'UTC',
      buckets: [bucket('2026-10-31', 'codex', 'gpt-6.1'), bucket('2026-11-01', 'claude', 'claude-opus-5-5')],
      sources: [], providerSessions: { codex: 2, claude: 2 } }),
  } };
}
