import { NextRequest } from 'next/server';
import path from 'node:path';

import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { requirePanelAuth } from '@/lib/panel/auth';
import { WORKTREE_MAINTENANCE_POLICY } from '@/lib/worktree/maintenance-budget';
import { readWorktreeMaintenanceStatus } from '@/lib/worktree/maintenance-discovery';
import { CleanupPlanError, executeCleanupPlan, previewCleanupPlan, readCleanupPlan } from '@/lib/worktree/cleanup-plan';
import { operatorError, operatorSuccess } from '../../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  if (resolveRequestPrincipal(request) !== 'operator') {
    return operatorError('forbidden', 'Worktree maintenance inventory is operator-only.', 403);
  }
  try {
    const planId = request.nextUrl.searchParams.get('planId');
    if (planId) return operatorSuccess({ plan: readCleanupPlan(planId) });
    const after = request.nextUrl.searchParams.get('after') ?? '';
    if (after.length > 4_096) return operatorError('invalid_request', 'Invalid maintenance cursor.', 400);
    const scopes = request.nextUrl.searchParams.getAll('repoPath');
    const repoPath = scopes[0];
    if (scopes.length > 1 || (repoPath !== undefined
      && (!path.isAbsolute(repoPath) || repoPath.includes('\0') || repoPath.length > 4_096))) {
      return operatorError('invalid_request', 'Expected one absolute repository path.', 400);
    }
    return operatorSuccess({ ...readWorktreeMaintenanceStatus(after, 50, repoPath), policy: WORKTREE_MAINTENANCE_POLICY });
  } catch {
    return operatorError('maintenance_unavailable', 'Worktree maintenance inventory is unavailable.', 503);
  }
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  if (resolveRequestPrincipal(request) !== 'operator') return operatorError('forbidden', 'Reviewed cleanup is operator-only.', 403);
  try {
    const body = await request.json();
    if (body?.action === 'preview' && typeof body.repoPath === 'string') {
      return operatorSuccess({ plan: await previewCleanupPlan(body.repoPath) });
    }
    if (body?.action === 'execute' && typeof body.planId === 'string' && typeof body.fingerprint === 'string'
      && Array.isArray(body.selection)) return operatorSuccess({ plan: await executeCleanupPlan(body) });
    return operatorError('invalid_request', 'Choose preview or an exact reviewed selection.', 400);
  } catch (error) {
    return operatorError('cleanup_plan_refused', error instanceof Error ? error.message : 'Cleanup plan is unavailable.',
      error instanceof CleanupPlanError ? error.status : 503);
  }
}
