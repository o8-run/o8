import { describe, expect, it } from 'vitest';
import { WORKFLOW_MIRROR_TESTS, parseNameStatus, selectResourceOwning } from '../scripts/ci/resource-owning-changed.mjs';

const classification = {
  resourceOwning: [
    { path: 'tests/packet-merge-real-path.test.ts' },
    { path: 'src/lib/lane/merge-lock.test.ts' },
  ],
};

function nameStatus(...records: string[][]): string {
  return records.map((record) => `${record.join('\0')}\0`).join('');
}

describe('resource-owning-changed', () => {
  it('selects nothing when the diff is empty', () => {
    expect(selectResourceOwning(parseNameStatus(''), classification)).toEqual([]);
  });

  it('selects a touched resource-owning test', () => {
    const output = nameStatus(
      ['M', 'src/lib/lane/merge.ts'],
      ['M', 'tests/packet-merge-real-path.test.ts'],
    );
    expect(selectResourceOwning(parseNameStatus(output), classification)).toEqual([
      'tests/packet-merge-real-path.test.ts',
    ]);
  });

  it('excludes a touched hermetic test', () => {
    const output = nameStatus(['A', 'tests/theme-registry.test.ts'], ['M', 'src/lib/theme/registry.ts']);
    expect(selectResourceOwning(parseNameStatus(output), classification)).toEqual([]);
  });

  it('follows a rename to the new path and drops deleted files', () => {
    const output = nameStatus(
      ['R087', 'src/lib/lane/old-merge-lock.test.ts', 'src/lib/lane/merge-lock.test.ts'],
      ['D', 'tests/packet-merge-real-path.test.ts'],
    );
    expect(parseNameStatus(output)).toEqual(['src/lib/lane/merge-lock.test.ts']);
    expect(selectResourceOwning(parseNameStatus(output), classification)).toEqual([
      'src/lib/lane/merge-lock.test.ts',
    ]);
  });

  it('runs the workflow mirror tests whenever ci.yml or a composite action changes', () => {
    // The mirror tests pin the workflow's shape; a workflow edit must run them
    // even when the tests themselves are untouched (#5443: two stale assertions
    // landed on main because nothing selected the file).
    expect(WORKFLOW_MIRROR_TESTS).toEqual(['tests/ci-gates-real-path.test.ts', 'tests/verify-ci-real-path.test.ts']);
    const manifest = { resourceOwning: [...classification.resourceOwning, ...WORKFLOW_MIRROR_TESTS.map((path) => ({ path }))] };
    for (const changed of ['.github/workflows/ci.yml', '.github/actions/next-linux-setup/action.yml']) {
      expect(selectResourceOwning(parseNameStatus(nameStatus(['M', changed])), manifest)).toEqual(WORKFLOW_MIRROR_TESTS);
    }
    // Only tests the manifest classifies as resource-owning are selected.
    expect(selectResourceOwning(parseNameStatus(nameStatus(['M', '.github/workflows/ci.yml'])), classification)).toEqual([]);
    // Other workflows and ordinary sources do not pull the mirror tests in.
    expect(selectResourceOwning(parseNameStatus(nameStatus(['M', '.github/workflows/next-parity.yml'], ['M', 'src/lib/lane/merge.ts'])), manifest)).toEqual([]);
  });
});
