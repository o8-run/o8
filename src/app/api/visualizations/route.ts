import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { publishVisualization } from '@/lib/visualizations/service';
import { visualizationBody, visualizationFailure, visualizationResponse } from '@/lib/visualizations/http';
import { visualizationReference } from '@/lib/visualizations/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const { document, warnings, check } = await publishVisualization(await visualizationBody(request), resolveRequestPrincipalContext(request));
    return visualizationResponse({ visualization: visualizationReference(document), warnings, check }, 201);
  } catch (error) { return visualizationFailure(error); }
}

// The native transport imports the same GET without loading publication tooling.
export { GET } from '@/lib/visualizations/read';
