import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'o8-protected-home-'));
vi.mock('node:os', async (importOriginal) => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => home }));

const { existsWhenReachable, isPathReachable, missingWhenReachable, protectedFolderOf, whenPathReachable } = await import('./protected-folders');

afterEach(() => { vi.restoreAllMocks(); });

describe('protected folders', () => {
  it('names the folder a privacy prompt guards, and nothing else', () => {
    expect(protectedFolderOf(join(home, 'Documents', 'repo', 'src'))).toBe(join(home, 'Documents'));
    expect(protectedFolderOf(join(home, 'Desktop'))).toBe(join(home, 'Desktop'));
    expect(protectedFolderOf(join(home, 'Library', 'Mobile Documents', 'x'))).toBe(join(home, 'Library', 'Mobile Documents'));
    expect(protectedFolderOf('/Volumes/T7/work/repo')).toBe('/Volumes/T7');
    expect(protectedFolderOf(join(home, 'DocumentsArchive'))).toBeNull();
    expect(protectedFolderOf(join(home, 'o8'))).toBeNull();
  });

  it('treats a protected path as unknown until its probe settles, then reads it normally', async () => {
    const repo = join(home, 'Downloads', 'repo');
    mkdirSync(repo, { recursive: true });
    expect(isPathReachable(join(home, 'o8'))).toBe(true);
    expect(isPathReachable(repo)).toBe(false);
    expect(existsWhenReachable(repo)).toBe(false);
    expect(missingWhenReachable(join(home, 'Downloads', 'gone'))).toBe(false);
    await whenPathReachable(repo);
    expect(isPathReachable(repo)).toBe(true);
    expect(existsWhenReachable(repo)).toBe(true);
    expect(missingWhenReachable(join(home, 'Downloads', 'gone'))).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });
});
