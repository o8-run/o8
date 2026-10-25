/**
 * POST /api/cortex/ask/answer  (epic #915 — MCP-callable Q&A endpoint)
 *
 * Non-streaming JSON sibling of the SSE route at /api/cortex/ask. Used by the
 * cortex_ask MCP tool — external Claude / Codex sessions can hit this to query
 * the Engineering Brain and get a single JSON answer back (no SSE parsing).
 * Also the backend for the worker-facing `o8 ask` CLI (2026-06-11): when a
 * `packetId` is supplied, the repo scope resolves from the packet's lane and
 * a `brain_consulted` lane event is recorded so the packet UI can surface
 * "this worker used the Brain" with the same titled sources.
 *
 * Accepts: { question: string, repoPath?: string, projectId?: string, terse?: boolean,
 *            bypassCache?: boolean, packetId?: string }
 * Returns: { ok: true, answer, citations, class, retrievalMs, classifyMs,
 *            sourcesConsidered } | { ok: false, error }
 * Citations carry a human-readable `title` per source (2026-06-11 parity pass).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { performance } from 'node:perf_hooks';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { isBrainReadWorkerBearer } from '@/lib/auth/brain-read-worker-token';
import { getProjectsLedger, type ProjectRecord } from '@/lib/repos/projects';
import { listReposFresh } from '@/lib/repos/registry';

import { askCortex, type AskCortexResult } from '@/lib/cortex/qa/ask';
import { ManagedBrainUnavailableError } from '@/lib/cortex/qa/compose-class-a';
import { estimateBrainTokenCount } from '@/lib/cortex/qa/llm/brain-spend';
import { recordLaneEvent } from '@/lib/lane/events';
import { findLatestLaneByPacket } from '@/lib/lane/registry';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';

interface AskAnswerBody {
  question?: unknown;
  repoPath?: unknown;
  projectId?: unknown;
  terse?: unknown;
  bypassCache?: unknown;
  packetId?: unknown;
}

function recordBrainConsulted(
  packetId: string,
  laneId: string,
  question: string,
  result: AskCortexResult,
  latencyMs: number,
) {
  try {
    recordLaneEvent(laneId, 'brain_consulted', 'system', {
      packetId,
      question: question.length > 200 ? `${question.slice(0, 199)}…` : question,
      class: result.class,
      cacheHit: result.cacheHit ?? null,
      sourcesConsidered: result.sourcesConsidered,
      citedCount: result.citations.length,
      topTitles: result.citations.slice(0, 3).map((c) => c.title ?? c.excerpt?.slice(0, 80) ?? c.kind),
      tokens: estimateBrainTokenCount(question, result.answer),
      latencyMs,
      ...(result.classifier ? { classifier: result.classifier, classificationReceiptId: result.classificationReceiptId ?? null } : {}),
    });
  } catch (err) {
    // The audit trail must never fail the ask itself.
    console.error('[cortex-ask] brain_consulted event failed:', err);
  }
}

export async function POST(request: NextRequest) {
  const startedAt = performance.now();
  const body = (await request.json().catch(() => null)) as AskAnswerBody | null;
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (!question) {
    return NextResponse.json(
      { ok: false, error: 'question is required' },
      { status: 400, headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } },
    );
  }

  let repoPath =
    typeof body?.repoPath === 'string' && body.repoPath.trim() ? body.repoPath.trim() : undefined;
  let projectId =
    typeof body?.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : null;
  const bypassCache = body?.bypassCache === true;
  const terse = body?.terse === true;
  const packetId =
    typeof body?.packetId === 'string' && body.packetId.trim() ? body.packetId.trim() : null;
  const principal = resolveRequestPrincipalContext(request);
  const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '').trim() ?? '';
  if (isBrainReadWorkerBearer(bearer) && (principal.role !== 'worker' || !principal.brainRepoPath)) {
    return NextResponse.json({ ok: false, error: 'Invalid or expired Brain read credential.' }, { status: 401 });
  }
  if (principal.role === 'worker' && principal.brainRepoPath) {
    // Retrieval can expand a repository into every linked project. Refuse
    // ambiguous membership rather than giving a read grant that wider scope.
    let memberships: ProjectRecord[] = [];
    try {
      await listReposFresh();
      memberships = (await getProjectsLedger()).projects.filter(project => project.repoPaths.some(candidate => {
        try { return realpathSync(candidate) === principal.brainRepoPath; } catch { return false; }
      }));
    } catch { /* Missing membership evidence keeps the grant refused. */ }
    let scoped = !repoPath;
    if (repoPath) {
      try {
        const child = relative(principal.brainRepoPath, realpathSync(repoPath));
        scoped = child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
      } catch { scoped = false; }
    }
    if (!scoped || packetId || projectId || !principal.brainProjectId
      || memberships.length !== 1 || memberships[0].id !== principal.brainProjectId) {
      return NextResponse.json({ ok: false, error: { code: 'worker_brain_scope_mismatch',
        message: 'Brain read credential cannot address another project or packet.' } }, { status: 403 });
    }
    repoPath = principal.brainRepoPath;
    projectId = principal.brainProjectId;
  }
  const ownershipRefusal = principal.role === 'worker' && principal.brainRepoPath
    ? null : workerPacketRefusal(principal, packetId);
  if (ownershipRefusal) {
    return NextResponse.json({ ok: false, error: ownershipRefusal }, { status: 403 });
  }

  // Worker path: the CLI runs inside a packet worktree whose directory name
  // (`packet-<id>`) doesn't match any registered repo slug, so directive
  // scoping would silently miss. The lane knows the real repo.
  let laneId: string | null = null;
  if (packetId) {
    try {
      const lane = findLatestLaneByPacket(packetId);
      if (lane) {
        laneId = lane.id;
        if (!repoPath && lane.repoPath) repoPath = lane.repoPath;
      }
    } catch (err) {
      console.error('[cortex-ask] lane lookup for packetId failed:', err);
    }
  }

  try {
    let missionId: string | null = null;
    if (packetId) {
      const { findMissionRegistryEntryByPacketId } = await import('@/lib/orchestrator/mission-registry');
      missionId = findMissionRegistryEntryByPacketId(packetId, { includeArchived: true })?.id ?? null;
    }
    const usageContext = laneId || packetId || missionId
      ? { laneId, packetId, missionId }
      : undefined;
    const result = await askCortex(question, repoPath, {
      bypassCache,
      projectId,
      terse,
      ...(usageContext ? { usageContext } : {}),
    });
    const latencyMs = Math.max(0, performance.now() - startedAt);
    if (packetId && laneId) recordBrainConsulted(packetId, laneId, question, result, latencyMs);
    return NextResponse.json({
      ok: true,
      answer: result.answer,
      citations: result.citations,
      class: result.class,
      retrievalMs: result.retrievalMs,
      classifyMs: result.classifyMs,
      sourcesConsidered: result.sourcesConsidered,
      consideredChars: result.consideredChars ?? null,
      cacheHit: result.cacheHit ?? null,
      ...(result.classifier ? { classifier: result.classifier, classificationReceiptId: result.classificationReceiptId ?? null } : {}),
    }, { headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } });
  } catch (err) {
    console.error('[cortex-ask] answer failed:', err);
    const managedUnavailable = err instanceof ManagedBrainUnavailableError;
    return NextResponse.json(
      {
        ok: false,
        error: 'Unable to answer cortex question.',
        ...(managedUnavailable ? { code: err.code } : {}),
      },
      { status: 500, headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } },
    );
  }
}
