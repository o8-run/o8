import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The problem dossier and Cortex diagnostics GETs are registered on the native
// transport, so they must leave the state they own unchanged (#5243, #5422).
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
const { recordTiming, __resetTimingBuffer } = await import('@/lib/cortex/diagnostics');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const dossierRoute = await import('@/app/api/panel/problem-dossiers/route');
const diagnosticsRoute = await import('@/app/api/cortex/diagnostics/route');

beforeAll(async () => {
  await addRepo(repoPath);
});
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

function dossierRow(id: string) {
  return getSqlite().prepare('SELECT status, cooldown_until, updated_at FROM problem_dossiers WHERE id = ?').get(id);
}

describe('native read-only GETs leave handler-owned state unchanged', () => {
  it('problem-dossiers GET does not reconcile an expired suppression', async () => {
    for (const suffix of ['a', 'b', 'c']) {
      enqueueInboxItem({ repoPath, packetId: `read-only-${suffix}`, kind: 'verification_failed',
        payload: { verificationKind: 'typecheck', error: 'read only dossier failure' } });
    }
    const dossier = listProblemDossiers({ includeSuppressed: true })
      .find((candidate) => candidate.painStatement.includes('read only dossier failure'));
    expect(dossier).toBeDefined();
    suppressProblemDossier(dossier!.id, { cooldownDays: 1 });
    getSqlite().prepare('UPDATE problem_dossiers SET cooldown_until = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), dossier!.id);
    const before = dossierRow(dossier!.id);

    const response = await dossierRoute.GET(new NextRequest(
      'http://localhost/api/panel/problem-dossiers?includeSuppressed=true',
      { headers: { authorization: `Bearer ${getOrCreateWsToken()}` } },
    ));
    expect(response.status).toBe(200);
    const body = await response.json() as { dossiers: Array<{ id: string; status: string }> };
    expect(body.dossiers.find((item) => item.id === dossier!.id)?.status).toBe('suppressed');
    expect(dossierRow(dossier!.id)).toEqual(before);

    // The explicit write path still reopens it.
    await reconcileProblemDossiers();
    expect(dossierRow(dossier!.id)).toMatchObject({ status: 'candidate', cooldown_until: null });
  });

  it('diagnostics GET reports unflushed samples without writing the timing file', async () => {
    __resetTimingBuffer();
    const file = join(dataDir, 'recall-metrics.json');
    rmSync(file, { force: true });
    for (let index = 0; index < 3; index += 1) {
      recordTiming({ label: 'recall.read-only', durationMs: 5 + index, timestamp: Date.now() });
    }

    const response = await diagnosticsRoute.GET();
    expect(response.status).toBe(200);
    const body = await response.json() as { timing: { windowedSamples: number } };
    expect(body.timing.windowedSamples).toBe(3);
    expect(existsSync(file)).toBe(false);
  });
});
