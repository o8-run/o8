import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-dossier-schedule-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const passes = vi.hoisted(() => ({ count: 0 }));
vi.mock('./service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./service')>();
  return {
    ...actual,
    reconcileProblemDossiers: async (...args: Parameters<typeof actual.reconcileProblemDossiers>) => {
      passes.count += 1;
      return actual.reconcileProblemDossiers(...args);
    },
  };
});

const { getSqlite } = await import('@/lib/db');
const { listProblemDossiers } = await import('./dossiers');
const { listInboxItems } = await import('@/lib/supervisor/inbox');
const { startProblemDossierReconcile } = await import('./reconcile-schedule');

let stop: (() => void) | null = null;

beforeAll(() => {
  listProblemDossiers({ includeSuppressed: true });
  listInboxItems({ includeAllProjects: true, includeDismissed: true });
});
afterEach(() => {
  stop?.();
  stop = null;
});

async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1_000);
}

function insertSuppressed(id: string, cooldownUntil: string): void {
  const at = new Date().toISOString();
  getSqlite().prepare(`
    INSERT INTO problem_dossiers (
      id, fingerprint, project_id, repo_path, pain_statement, first_observed_at, last_observed_at,
      impact_band, evidence_confidence, status, closure_contract_json, suppressed_at, cooldown_until,
      created_at, updated_at
    ) VALUES (?, ?, 'project', '/repo', 'pain', ?, ?, 'moderate', 'high', 'suppressed', '{}', ?, ?, ?, ?)
  `).run(id, `fp-${id}`, at, at, at, cooldownUntil, at, at);
}

it('skips passes while nothing it reads has changed, and runs again on new evidence or a due cooldown', async () => {
  vi.useFakeTimers();
  try {
    stop = startProblemDossierReconcile({ healBotRunning: () => false, periodMs: 1_000 });
    await tick();
    expect(passes.count).toBe(1);
    // Its own writes are not a change: the next ticks skip.
    await tick();
    await tick();
    expect(passes.count).toBe(1);

    // New supervisor evidence is an input: one more pass, then quiet again.
    getSqlite().prepare(`
      INSERT INTO supervisor_inbox (id, repo_path, packet_id, kind, payload)
      VALUES ('inbox-1', '/repo', 'pkt-1', 'verification_failed', '{}')
    `).run();
    await tick();
    expect(passes.count).toBe(2);
    await tick();
    expect(passes.count).toBe(2);

    // A suppression whose cooldown ends in five seconds is reopened once it is due.
    insertSuppressed('dossier-cooldown', new Date(Date.now() + 5_000).toISOString());
    await tick();
    expect(passes.count).toBe(3);
    await tick();
    await tick();
    expect(passes.count).toBe(3);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(passes.count).toBe(4);
    expect(listProblemDossiers({ includeSuppressed: true }).find((dossier) => dossier.id === 'dossier-cooldown')?.status)
      .toBe('candidate');
    await tick();
    expect(passes.count).toBe(4);

    // An operator edit to a dossier is an input too.
    getSqlite().prepare(`UPDATE problem_dossiers SET updated_at = ? WHERE id = 'dossier-cooldown'`).run('2099-01-01T00:00:00.000Z');
    await tick();
    expect(passes.count).toBe(5);
  } finally {
    vi.useRealTimers();
  }
});
