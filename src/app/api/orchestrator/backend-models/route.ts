/**
 * GET /api/orchestrator/backend-models?backend=opencode[&repoPath=…][&refresh=1]
 *
 * The model catalogue for a model-agnostic ACP orchestrator backend, grouped by
 * provider with reasoning variants folded onto their base model. Served from a
 * day-old disk cache; `refresh=1` forces a fresh probe.
 *
 * Gated by the global middleware like every other /api/orchestrator/* route.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { resolveOpenRouterKey } from '@/lib/cortex/qa/llm/byok-keys';
import { resolveLocalAcpLaunch } from '@/lib/acp/local-connection';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveAcpLaunch } from '@/lib/lane/orchestrator-backends/acp';
import { isOrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { probeAcpModels } from '@/lib/orchestrator/acp-model-probe';
import { buildModelCatalogue, catalogueSize } from '@/lib/orchestrator/acp-model-catalogue';
import { getOpenRouterModelMetadata, type OpenRouterModelSort } from '@/lib/orchestrator/openrouter-model-metadata';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = requirePanelAuth(request);
  if (auth) return auth;

  const params = request.nextUrl.searchParams;
  const backend = params.get('backend');
  if (!backend || !isOrchestratorBackendId(backend)) {
    return NextResponse.json({ error: 'unknown backend' }, { status: 400 });
  }

  let launch: ReturnType<typeof resolveAcpLaunch>;
  try {
    launch = resolveAcpLaunch(backend);
  } catch {
    return NextResponse.json({
      backend, available: false, groups: [], total: 0,
      error: 'Could not read the agent launch configuration. Check its executable and arguments.',
    }, { status: 503 });
  }
  if (!launch) {
    // Not installed is a normal state, not an error — the picker renders an
    // install hint rather than a failure toast.
    return NextResponse.json({ backend, available: false, groups: [], total: 0 });
  }

  const repoPath = params.get('repoPath')?.trim() || process.cwd();
  const sortParam = params.get('sort');
  if (sortParam && sortParam !== 'most-popular' && sortParam !== 'newest') {
    return NextResponse.json({ error: 'unknown catalogue sort' }, { status: 400 });
  }
  const sort = (sortParam ?? 'most-popular') as OpenRouterModelSort;

  try {
    if (backend === 'opencode' || (backend === 'acp' && resolveLocalAcpLaunch()?.useOpenRouter)) await resolveOpenRouterKey();
    const probePromise = probeAcpModels(backend, launch, repoPath, {
      force: params.get('refresh') === '1',
    });
    const metadataPromise = backend === 'opencode'
      ? getOpenRouterModelMetadata(sort)
      : Promise.resolve(null);
    const [probe, metadata] = await Promise.all([probePromise, metadataPromise]);
    const groups = buildModelCatalogue(probe.models, metadata ?? undefined);
    return NextResponse.json({
      backend,
      available: true,
      groups,
      total: catalogueSize(groups),
      rankingAvailable: metadata !== null,
      sort: metadata ? sort : undefined,
      currentModel: probe.currentModel,
      probedAt: probe.probedAt,
      source: probe.source,
    });
  } catch (err) {
    // Never throw out of an API route — a dead agent must not 500 the picker.
    return NextResponse.json({
      backend,
      available: true,
      groups: [],
      total: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
