/**
 * Adapted from T3 Code (https://github.com/pingdotgg/t3code),
 * apps/server/src/project/ProjectFaviconResolver.test.ts, commit
 * f58fad04162165653bf06f0c987bbfb0074a8a4b. Copyright (c) 2026 T3 Tools Inc.
 * MIT; see licenses/t3code-MIT.txt. Adaptation: Node filesystem and cache clock.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectIconResolver } from './project-icon-resolver';

let root: string;
let resolver: ProjectIconResolver;
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-project-icon-cache-')));
  resolver = new ProjectIconResolver();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(0);
});
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

it('expires negative results after one minute and positive results after ten minutes', async () => {
  expect(await resolver.resolvePath(root)).toBeNull();
  writeFileSync(join(root, 'favicon.svg'), svg);
  vi.setSystemTime(59_999); expect(await resolver.resolvePath(root)).toBeNull();
  vi.setSystemTime(60_000); expect(await resolver.resolvePath(root)).toBe(join(root, 'favicon.svg'));
  writeFileSync(join(root, 'configured.svg'), svg);
  writeFileSync(join(root, 't3.json'), JSON.stringify({ iconPath: 'configured.svg' }));
  vi.setSystemTime(659_999); expect(await resolver.resolvePath(root)).toBe(join(root, 'favicon.svg'));
  vi.setSystemTime(660_000); expect(await resolver.resolvePath(root)).toBe(join(root, 'configured.svg'));
});

it('evicts the least-recently-used entry at the 512-entry capacity', async () => {
  for (let index = 0; index < 512; index++) expect(await resolver.resolvePath(root, `missing-${index}.svg`)).toBeNull();
  expect(await resolver.resolvePath(root, 'missing-0.svg')).toBeNull();
  expect(await resolver.resolvePath(root, 'missing-512.svg')).toBeNull();
  writeFileSync(join(root, 'favicon.svg'), svg);
  expect(await resolver.resolvePath(root, 'missing-0.svg')).toBeNull();
  expect(await resolver.resolvePath(root, 'missing-1.svg')).toBe(join(root, 'favicon.svg'));
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('does not cache a source read failure and recovers immediately', async () => {
  const source = join(root, 'index.html');
  writeFileSync(source, '<link rel="icon" href="/brand.svg">');
  mkdirSync(join(root, 'public')); writeFileSync(join(root, 'public/brand.svg'), svg);
  chmodSync(source, 0);
  try { await expect(resolver.resolvePath(root)).rejects.toBeDefined(); }
  finally { chmodSync(source, 0o600); }
  expect(await resolver.resolvePath(root)).toBe(join(root, 'public/brand.svg'));
});
