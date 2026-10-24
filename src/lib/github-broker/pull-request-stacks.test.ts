import { describe, expect, it } from 'vitest';
import { pullRequestStackRows, type StackablePullRequest } from './pull-request-stacks';

const pr = (number: number, head: string, base = 'main', repo: string | null = 'example/repo'): StackablePullRequest => ({ number, headRefName: head, baseRefName: base, headRepoFullName: repo });
describe('pull request branch dependencies', () => {
  it('orders branches from base to tip even when the server returns the newest child first', () => {
    const rows = pullRequestStackRows([pr(3, 'ui', 'api'), pr(4, 'standalone'), pr(2, 'api', 'types'), pr(1, 'types')], 'example/repo');
    expect(rows.map(({ pull, depth, parent }) => [pull.number, depth, parent])).toEqual([[4, 0, null], [1, 0, null], [2, 1, 1], [3, 2, 2]]);
  });
  it('does not mistake an identical fork branch or unavailable origin for a parent', () => {
    const rows = pullRequestStackRows([pr(1, 'types', 'main', 'contributor/repo'), pr(2, 'types', 'main', null), pr(3, 'ui', 'types')], 'example/repo');
    expect(rows.every((row) => row.parent === null)).toBe(true);
  });
  it('refuses a fork child even when its base ref matches a local parent', () => {
    expect(pullRequestStackRows([pr(1, 'types'), pr(2, 'ui', 'types', 'fork/repo')], 'example/repo')[1]).toMatchObject({ parent: null, unsupportedCrossFork: true });
  });
  it('keeps ambiguous parents and cycles visible without inventing their order', () => {
    const rows = pullRequestStackRows([pr(1, 'same'), pr(2, 'same'), pr(3, 'child', 'same'), pr(4, 'a', 'b'), pr(5, 'b', 'a')], 'example/repo');
    expect(rows.map((row) => row.pull.number)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.filter((row) => row.ambiguous).map((row) => row.pull.number)).toEqual([3, 4, 5]);
    expect(rows.every((row) => row.parent === null)).toBe(true);
  });
  it('deduplicates overlapping pages and handles long stacks without recursive rendering', () => {
    const pulls = Array.from({ length: 1500 }, (_, index) => pr(index + 1, `b${index}`, index ? `b${index - 1}` : 'main'));
    const rows = pullRequestStackRows([...pulls.reverse(), pulls[0]], 'EXAMPLE/REPO');
    expect(rows).toHaveLength(1500);
    expect(rows[0].pull.number).toBe(1);
    expect(rows.at(-1)?.depth).toBe(1499);
  });
});
