import { syntaxAssetUrl } from '@/lib/highlighting/asset-manifest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public, immutable third-party syntax assets; no application state or credentials.
 * Keeping their directory structure also keeps embedded grammar imports on-origin.
 */
export async function GET(_request: Request, { params }: {
  params: Promise<{ kind: string; version: string; name: string }>;
}) {
  const { kind, version, name } = await params;
  const url = syntaxAssetUrl(kind, version, name);
  if (!url) return new Response('Syntax asset not found.', { status: 404 });
  try {
    const upstream = await fetch(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!upstream.ok) throw new Error('Syntax asset unavailable.');
    return new Response(await upstream.text(), { headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
    } });
  } catch {
    return new Response('Syntax asset unavailable. Retry shortly.', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
