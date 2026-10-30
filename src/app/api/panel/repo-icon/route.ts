import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { findRepoByIdSync } from '@/lib/repos/registry';
import { getProjectIconSettings } from '@/lib/repos/project-icon-settings';
import { projectIconResolver, readProjectIcon } from '@/lib/repos/project-icon-resolver';
import { isVerifiableRasterType, viewerImageBytes } from '@/lib/viewers/image-bytes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // Same operator/registered-repository worker guard as neighboring file readers.
  // Middleware remains the authority; no new route allowlist is introduced.
  const principal = resolveRequestPrincipal(request);
  if (principal !== 'operator' && principal !== 'worker') return Response.json({ error: 'Repository icon access requires an operator or dispatched-worker credential.' }, { status: 403 });
  const id = new URL(request.url).searchParams.get('id');
  const repo = id ? findRepoByIdSync(id) : null;
  if (!repo) return Response.json({ error: 'Registered repository not found.' }, { status: 404 });
  try {
    const settings = getProjectIconSettings(repo.id);
    const image = await readProjectIcon(repo.localPath, settings.faviconPath);
    if (!image) return Response.json({ error: 'Project icon not found.' }, { status: 404 });
    if (isVerifiableRasterType(image.mime)) return viewerImageBytes(image.bytes, image.mime);
    return new Response(new Uint8Array(image.bytes), { headers: {
      'Content-Type': image.mime, 'Content-Length': String(image.bytes.length),
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    } });
  } catch {
    projectIconResolver.invalidate(repo.localPath);
    return Response.json({ error: 'Project icon is temporarily unavailable.' }, { status: 503 });
  }
}
