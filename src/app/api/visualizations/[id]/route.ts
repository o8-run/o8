import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { readVisualization, readVisualizationMetadata } from '@/lib/visualizations/service';
import { visualizationFailure, visualizationResponse } from '@/lib/visualizations/http';
import { visualizationVersions } from '@/lib/visualizations/store';
import { nativeVisualizationDocument } from '@/lib/visualizations/document';
import { VisualizationError } from '@/lib/visualizations/errors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const principal = resolveRequestPrincipalContext(request);
    const params = new URL(request.url).searchParams;
    if (params.has('versions') && !params.has('source')) {
      const visualization = readVisualizationMetadata(id, principal);
      return visualizationResponse({ visualization, versions: visualizationVersions(visualization.rootId ?? id) });
    }
    const doc = readVisualization(id, principal);
    const { source, ...visualization } = doc;
    if (params.has('source')) return visualizationResponse({ visualization: { ...visualization, html: undefined },
      source: source ?? (Buffer.byteLength(doc.html, 'utf8') <= 512 * 1024 ? { html: doc.html } : null), versions: visualizationVersions(doc.rootId ?? id) });
    if (params.has('nativeNonce')) {
      const nonce = params.get('nativeNonce')!;
      if (!/^[a-zA-Z0-9:-]{20,160}$/.test(nonce)) return visualizationFailure(new VisualizationError('invalid_nonce', 'Invalid visualization nonce.'));
      return visualizationResponse({ visualization: { ...visualization, html: undefined }, sealedHtml: await nativeVisualizationDocument(doc.html, nonce) });
    }
    return visualizationResponse({ visualization });
  } catch (error) { return visualizationFailure(error); }
}
