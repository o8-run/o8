export interface StackablePullRequest {
  number: number;
  headRefName: string;
  baseRefName: string;
  headRepoFullName?: string | null;
}
export interface PullRequestStackRow<T> { pull: T; depth: number; parent: number | null; ambiguous: boolean; unsupportedCrossFork: boolean }

/** Infer branch dependencies only within the same repository. Cycles remain flat. */
export function pullRequestStackRows<T extends StackablePullRequest>(pulls: T[], repo: string): PullRequestStackRow<T>[] {
  pulls = [...new Map(pulls.map((pull) => [pull.number, pull])).values()];
  const heads = new Map<string, T[]>();
  for (const pull of pulls) {
    if (!pull.headRefName || pull.headRepoFullName?.toLowerCase() !== repo.toLowerCase()) continue;
    const candidates = heads.get(pull.headRefName) ?? [];
    candidates.push(pull); heads.set(pull.headRefName, candidates);
  }
  const parents = new Map<number, number>();
  const ambiguous = new Set<number>();
  for (const pull of pulls) {
    if (pull.headRepoFullName?.toLowerCase() !== repo.toLowerCase()) continue;
    const candidates = heads.get(pull.baseRefName) ?? [];
    if (candidates.length > 1) ambiguous.add(pull.number);
    else if (candidates.length === 1 && candidates[0].number !== pull.number) parents.set(pull.number, candidates[0].number);
  }
  const checked = new Set<number>();
  for (const pull of pulls) {
    if (checked.has(pull.number)) continue;
    const seen = new Set<number>();
    let next: number | undefined = pull.number;
    while (next !== undefined && !seen.has(next) && !checked.has(next)) { seen.add(next); next = parents.get(next); }
    if (next !== undefined && seen.has(next)) for (const number of seen) { ambiguous.add(number); parents.delete(number); }
    for (const number of seen) checked.add(number);
  }
  const children = new Map<number, T[]>();
  for (const pull of pulls) {
    const parent = parents.get(pull.number);
    if (parent !== undefined) { const siblings = children.get(parent) ?? []; siblings.push(pull); children.set(parent, siblings); }
  }
  const rows: PullRequestStackRow<T>[] = [];
  const pending = pulls.filter((pull) => !parents.has(pull.number)).reverse().map((pull) => ({ pull, depth: 0 }));
  while (pending.length) {
    const { pull, depth } = pending.pop()!;
    rows.push({ pull, depth, parent: parents.get(pull.number) ?? null, ambiguous: ambiguous.has(pull.number), unsupportedCrossFork: Boolean(pull.headRepoFullName && pull.headRepoFullName.toLowerCase() !== repo.toLowerCase()) });
    const siblings = children.get(pull.number) ?? [];
    for (let index = siblings.length - 1; index >= 0; index--) pending.push({ pull: siblings[index], depth: depth + 1 });
  }
  return rows;
}
