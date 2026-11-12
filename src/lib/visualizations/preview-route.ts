import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { resolveVisualizationTarget } from '@/lib/visualizations/service';
import { prepareVisualizationHtml } from '@/lib/visualizations/prepare';
import { previewVisualization } from '@/lib/visualizations/preview';
import { visualizationInputSource } from '@/lib/visualizations/templates';
import { visualizationBody, visualizationFailure, visualizationResponse } from '@/lib/visualizations/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await visualizationBody(request);
    const target = await resolveVisualizationTarget(body, resolveRequestPrincipalContext(request));
    const prepared = await prepareVisualizationHtml(visualizationInputSource(body).html, target.assetRoot);
    const preview = await previewVisualization(prepared.html, { width: body.width, appearance: body.appearance });
    return visualizationResponse({ ...preview, warnings: prepared.warnings });
  } catch (error) { return visualizationFailure(error); }
}
