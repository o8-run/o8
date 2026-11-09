import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, it, vi } from 'vitest';

// ripgrep counts regular files, but a hit can be replaced by a link before it is read. The grep
// arm reads each hit without following links, so a link to a file outside the repository is
// skipped. The ripgrep count is stubbed to report that link.
vi.mock('@/lib/providers/child-process', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/providers/child-process')>(),
  execFile: (_file: string, _args: string[], _options: unknown, callback: (error: null, stdout: string) => void) => {
    callback(null, './settings.txt:1\n./linked.txt:2\n');
  },
}));

const { buildGrepArmTopRows } = await import('@/lib/cortex/qa/grep-arm');
const root = mkdtempSync(join(os.tmpdir(), 'o8-grep-arm-links-'));

afterAll(() => rmSync(root, { recursive: true, force: true }));

it('skips a hit that is a link to a file outside the repository', async () => {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'settings.txt'), 'FIXTURE_LINK_KEY = fixture-repo-value\n');
  writeFileSync(join(root, 'outside.txt'), 'FIXTURE_LINK_KEY = fixture-outside-value\n');
  symlinkSync(join(root, 'outside.txt'), join(repo, 'linked.txt'));

  const rows = JSON.stringify(await buildGrepArmTopRows('What is the value of FIXTURE_LINK_KEY?', repo));
  expect(rows).toContain('fixture-repo-value');
  expect(rows).not.toContain('fixture-outside-value');
});
