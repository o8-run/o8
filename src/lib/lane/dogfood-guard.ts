import 'server-only';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DOGFOOD_PR_ONLY_NOTE, type LaneMergePolicy } from '@/lib/lane/merge-mode';
import { getSqlite } from '@/lib/db';
import { projectMergeModeKey } from '@/lib/lane/project-merge-mode-migration';
import { getDataDir } from '@/lib/data-dir-migration';

/**
 * PR-only safety wall for the autonomous dogfood loop (#1173). While the loop is
 * driving it touches `~/.o8/.dogfood-pr-only`; every merge chokepoint refuses
 * while that sentinel exists — so "PR-only" is a mechanical WALL, not a prompt
 * line the loop is merely told to obey. Fail-safe by construction: present =
 * no merge. The human's normal app never creates it, so manual merges are
 * unaffected; the kill switch (dogfood-stop.sh) removes it on stop.
 */
export function dogfoodPrOnlyActive(): boolean {
  const dir = getDataDir();
  return existsSync(join(dir, '.dogfood-pr-only'));
}

export { DOGFOOD_PR_ONLY_NOTE };

export function currentLaneMergePolicy(projectId?: string | null): LaneMergePolicy {
  const sqlite = getSqlite();
  if (dogfoodPrOnlyActive()) return { mode: 'pr_only', note: DOGFOOD_PR_ONLY_NOTE };
  const row = sqlite.prepare('SELECT value FROM app_state WHERE key = ?')
    .get(projectMergeModeKey(projectId ?? 'default')) as { value: string } | undefined;
  return row?.value === 'direct' ? { mode: 'direct', note: null }
    : { mode: 'pr_only', note: 'PR-first project policy: open a pull request. Direct integration requires an explicit operator opt-in in project settings.' };
}
