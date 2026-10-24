/** Disposable local Git history; no network remotes or accounts. */
import { execFileSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function seedCommitFixture(repo: string) {
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  writeFileSync(join(repo, 'changed.ts'), 'export const value = 1;\n');
  writeFileSync(join(repo, 'removed.txt'), 'restore me\n');
  git('add', '.'); git('commit', '-qm', 'fixture base');
  writeFileSync(join(repo, 'changed.ts'), 'export const value = 2;\n');
  unlinkSync(join(repo, 'removed.txt')); git('add', '-A'); git('commit', '-qm', 'fixture selected');
}
