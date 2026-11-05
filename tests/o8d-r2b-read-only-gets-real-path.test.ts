import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The problem-dossiers GET is registered on the native transport, so it must
// leave the state it owns unchanged; reconciliation runs on its own interval
// (#5243, #5422).
const dataDir = mkdtempSync(join(tmpdir(), 'o8-read-only-gets-'));
const repoPath = join(dataDir, 'repo');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
mkdirSync(repoPath, { recursive: true });
execFileSync('git', ['init', '-q', repoPath]);

const { getSqlite } = await import('@/lib/db');
const { addRepo } = await import('@/lib/repos/registry');
const { enqueueInboxItem } = await import('@/lib/supervisor/inbox');
const { listProblemDossiers } = await import('@/lib/problems/dossiers');
const { reconcileProblemDossiers, suppressProblemDossier } = await import('@/lib/problems/service');
const { startProblemDossierReconcile } = await import('@/lib/problems/reconcile-schedule');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const dossierRoute = await import('@/app/api/panel/problem-dossiers/route');

beforeAll(async () => {
  await addRepo(repoPath);
});
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

function dossierRow(id: string) {
  return getSqlite().prepare('SELECT status, cooldown_until, updated_at FROM problem_dossiers WHERE id = ?').get(id);
}

function expiredSuppression(error: string): string {
  for (const suffix of ['a', 'b', 'c']) {
    enqueueInboxItem({ repoPath, packetId: `${error}-${suffix}`, kind: 'verification_failed',
      payload: { verificationKind: 'typecheck', error } });
  }
  const dossier = listProblemDossiers({ includeSuppressed: true })
    .find((candidate) => candidate.painStatement.includes(error));
  expect(dossier).toBeDefined();
  suppressProblemDossier(dossier!.id, { cooldownDays: 1 });
  getSqlite().prepare('UPDATE problem_dossiers SET cooldown_until = ? WHERE id = ?')
    .run(new Date(Date.now() - 60_000).toISOString(), dossier!.id);
  return dossier!.id;
}

describe('problem dossiers: GET reads only, the interval reconciles', () => {
  it('problem-dossiers GET does not reconcile an expired suppression', async () => {
    const id = expiredSuppression('read only dossier failure');
    const before = dossierRow(id);

    const response = await dossierRoute.GET(new NextRequest(
      'http://localhost/api/panel/problem-dossiers?includeSuppressed=true',
      { headers: { authorization: `Bearer ${getOrCreateWsToken()}` } },
    ));
    expect(response.status).toBe(200);
    const body = await response.json() as { dossiers: Array<{ id: string; status: string }> };
    expect(body.dossiers.find((item) => item.id === id)?.status).toBe('suppressed');
    expect(dossierRow(id)).toEqual(before);

    // The explicit write path still reopens it.
    await reconcileProblemDossiers();
    expect(dossierRow(id)).toMatchObject({ status: 'candidate', cooldown_until: null });
  });

  it('the reconcile interval reopens an expired suppression with the heal-bot off, and skips while it runs', async () => {
    const id = expiredSuppression('interval dossier failure');
    let healBot = true;
    const stop = startProblemDossierReconcile({ healBotRunning: () => healBot, periodMs: 20 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(dossierRow(id)).toMatchObject({ status: 'suppressed' });
      healBot = false;
      await vi.waitFor(() => expect(dossierRow(id)).toMatchObject({ status: 'candidate', cooldown_until: null }));
    } finally {
      stop();
    }
  });
});
