import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const source = vi.hoisted(() => ({ inspected: vi.fn(async () => ({ status: 'unavailable' as const, reason: 'fixture' })) }));
vi.mock('@/lib/providers/child-process', async () => {
  const actual = await import('node:child_process');
  return { ...actual, execFileReadOnly: actual.execFile, spawnReadOnly: actual.spawn, execFileSyncReadOnly: actual.execFileSync };
});
vi.mock('@/lib/worktree/apfs', () => ({ getApfsCowCapability: async () => ({ canCowClone: true }) }));
vi.mock('@/lib/workspace/dependency-manager-executable', () => ({ resolvePackageManagerExecution: async () => ({ executable: 'npm', version: '11.8.0' }) }));
vi.mock('@/lib/workspace/dependency-directory-clone', () => ({ inspectDependencyCloneSource: source.inspected }));
import { observeDependencyReuse } from './storage-dependency-reuse';

const roots: string[] = [];
const originalPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  source.inspected.mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it.each(['npm ci', 'npm ci --ignore-scripts'])('does not infer a postinstall write bound from its read closure for %s', async command => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const repo = mkdtempSync(path.join(os.tmpdir(), 'o8-clone-write-bound-'));
  roots.push(repo);
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'write-bound', packageManager: 'npm@11.8.0',
    scripts: { postinstall: 'node postinstall.cjs' }, o8DependencyClone: { lifecycleInputs: ['postinstall.cjs'] } }));
  writeFileSync(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
  writeFileSync(path.join(repo, 'postinstall.cjs'), "require('node:fs').writeFileSync('node_modules/large.js', Buffer.alloc(256 * 1024 * 1024));\n");
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  expect(await observeDependencyReuse(repo, git('rev-parse', 'HEAD'), command)).toBeNull();
  expect(source.inspected).toHaveBeenCalledTimes(command.includes('--ignore-scripts') ? 1 : 0);
});
