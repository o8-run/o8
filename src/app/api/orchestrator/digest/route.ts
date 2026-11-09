import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRepoPathFromRegistry } from '@/lib/repos/repo-path-registry';
import { digest } from '@/lib/orchestrator/auto-compact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Fable Slice 5 — pre-digest inbound bulk (lever 4 of the metered-orchestrator
 * window). POST { text, repoPath } → { ok, digest, approxInputTokens,
 * approxDigestTokens, truncatedInput }. Runs Codex-medium in a fresh read-only
 * exec (never the proposer's session — adversarial digestion). Consumed by the
 * operator MCP `digest` tool; gated like every /api/orchestrator/* route.
 */
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => null) as {
    text?: unknown;
    repoPath?: unknown;
  } | null;
  const text = typeof body?.text === 'string' ? body.text : '';
  const repoPath = typeof body?.repoPath === 'string' ? body.repoPath.trim() : '';
  if (!text.trim()) {
    return NextResponse.json({ ok: false, error: 'text is required' }, { status: 400 });
  }
  if (!repoPath) {
    return NextResponse.json({ ok: false, error: 'repoPath is required' }, { status: 400 });
  }

  const resolved = await resolveRepoPathFromRegistry(repoPath);
  if (!resolved.ok) {
    return NextResponse.json({ ok: false, error: resolved.message }, { status: resolved.status });
  }

  try {
    // A client that disconnects (an MCP timeout before its retry) ends the Codex run with it.
    const result = await digest(text, resolved.repoRoot, { signal: request.signal });
    return NextResponse.json({ ok: true, ...result }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    console.error('[api] orchestrator/digest failed:', error);
    return NextResponse.json({
      ok: false,
      error: 'Digest failed',
    }, {
      status: 500,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }
}
