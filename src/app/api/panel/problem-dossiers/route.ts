import { NextResponse, type NextRequest } from 'next/server';

import { resolveRequestPrincipal } from '@/lib/auth/principal';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import { requirePanelAuth } from '@/lib/panel/auth';
import { listProblemDossiers, listProblemRemedies } from '@/lib/problems/dossiers';
import { projectProblemDossierMetrics } from '@/lib/problems/metrics';
import {
  acceptProblemDossier,
  resumeProblemDossier,
  stopProblemDossier,
  suppressProblemDossier,
} from '@/lib/problems/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function projectDossiers(projectId: string | null, includeSuppressed: boolean) {
  const dossiers = listProblemDossiers({ projectId, includeSuppressed });
  return {
    schema: 'o8/problem-dossiers/v1',
    dossiers: dossiers.map((dossier) => ({
      ...dossier,
      remedies: listProblemRemedies(dossier.id),
    })),
    summary: {
      total: dossiers.length,
      actionable: dossiers.filter((dossier) => (
        dossier.status !== 'suppressed' && dossier.status !== 'verified_closed'
      )).length,
      provisional: dossiers.filter((dossier) => dossier.status === 'provisionally_resolved').length,
      verifiedClosed: dossiers.filter((dossier) => dossier.status === 'verified_closed').length,
    },
    metrics: projectProblemDossierMetrics(dossiers),
  };
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const projectId = optionalString(request.nextUrl.searchParams.get('projectId'));
  const includeSuppressed = request.nextUrl.searchParams.get('includeSuppressed') === 'true';

  try {
    // Reads only. Heal-bot maintenance and the operator tools reconcile.
    return NextResponse.json(projectDossiers(projectId, includeSuppressed), {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unable to read problem dossiers.' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  if (resolveRequestPrincipal(request) !== 'operator') {
    return NextResponse.json({ ok: false, error: 'Problem dossier decisions are operator-only.' }, { status: 403 });
  }
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = optionalString(body.action);
  const dossierId = optionalString(body.dossierId);
  const clientMutationId = optionalString(body.clientMutationId);
  if (!action || !dossierId || !clientMutationId) {
    return NextResponse.json({ ok: false, error: 'action, dossierId, and clientMutationId are required.' }, { status: 400 });
  }
  if (!['accept', 'suppress', 'stop', 'resume'].includes(action)) {
    return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
  }
  const reason = optionalString(body.reason);
  const cooldownDays = Math.max(1, Math.min(365, Math.trunc(
    typeof body.cooldownDays === 'number' ? body.cooldownDays : 7,
  )));
  const canonicalBody = JSON.stringify({
    action,
    dossierId,
    ...(action === 'suppress' ? { reason, cooldownDays } : {}),
    ...(action === 'stop' ? { reason } : {}),
  });

  try {
    const binding = bindIdempotencyClientMutation({
      namespace: 'problem_dossier_action',
      clientKey: clientMutationId,
      body: canonicalBody,
    });
    if (binding.status === 'conflict') {
      return NextResponse.json({
        ok: false,
        error: 'clientMutationId was already used for another problem dossier decision.',
      }, { status: 409 });
    }
    if (binding.status === 'unavailable') {
      return NextResponse.json({
        ok: false,
        error: 'The persisted decision receipt store is unavailable; no dossier state was changed.',
      }, { status: 503 });
    }
    const outcome = await withIdempotency({
      key: deriveIdempotencyKey({
        verb: 'problem_dossier_action',
        scopeId: dossierId,
        clientKey: clientMutationId,
        body: canonicalBody,
      }),
      verb: 'problem_dossier_action',
      scopeId: dossierId,
    }, async () => {
      try {
        if (action === 'accept') return await acceptProblemDossier(dossierId);
        if (action === 'suppress') return suppressProblemDossier(dossierId, { reason, cooldownDays });
        if (action === 'stop') return await stopProblemDossier(dossierId, { reason });
        return resumeProblemDossier(dossierId);
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : 'Problem dossier action failed.' };
      }
    });
    if (outcome.inProgress) {
      const outcomeUnknown = outcome.unresolved === true;
      return NextResponse.json({
        ok: !outcomeUnknown,
        clientMutationId,
        inProgress: !outcomeUnknown,
        outcomeUnknown: outcomeUnknown || undefined,
        replayed: true,
        ...(outcomeUnknown ? {
          error: 'The prior dossier decision cannot be reconstructed. Inspect the dossier before taking another action.',
        } : {}),
      }, { status: outcomeUnknown ? 409 : 202 });
    }
    const result = outcome.result;
    return NextResponse.json({
      ...result,
      clientMutationId,
      replayed: outcome.replayed || undefined,
      persistenceDegraded: outcome.persistenceDegraded || undefined,
      ...(!result.ok && !('error' in result) ? { error: 'note' in result ? result.note : 'The decision was not completed.' } : {}),
    }, { status: result.ok ? 200 : 409 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      clientMutationId,
      error: error instanceof Error ? error.message : 'Problem dossier action failed.',
    }, { status: 500 });
  }
}
