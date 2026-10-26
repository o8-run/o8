import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs'); const p = process.getBuiltinModule('node:path');
  const root = fs.realpathSync.native(fs.mkdtempSync(p.join(process.getBuiltinModule('node:os').tmpdir(), 'o8-metadata-inodes-')));
  process.env.O8_DATA_DIR = p.join(root, 'data'); process.env.CORTEX_IDE_DATA_DIR = process.env.O8_DATA_DIR;
  return { root, singleLinkCount: false };
});
vi.mock('@/lib/skeleton/autoscan', () => ({ triggerScan: vi.fn() }));
vi.mock('@/lib/cortex/knowledge/reconcile', () => ({ reconcileKnowledgeSources: async () => {} }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, statSync: (...args: Parameters<typeof actual.statSync>) => {
    const stat = actual.statSync(...args);
    // Exercise the independent dev/inode comparison through the real route,
    // even when a filesystem reports a single link for an aliased file.
    if (stat && f.singleLinkCount && stat.isFile()) {
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { nlink: typeof stat.nlink === 'bigint' ? BigInt(1) : 1 });
    }
    return stat;
  } };
});

// Positive controls need the fixture's Git settings, not reviewer-shell overrides.
for (const name of Object.keys(process.env).filter(name => /^GIT_/i.test(name))) vi.stubEnv(name, undefined);

const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { closeDb } = await import('@/lib/db');
const branches = await import('@/app/api/panel/branches/route');
const token = getOrCreateWsToken();
let sequence = 0;
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}
function fixture() {
  const root = path.join(f.root, String(++sequence));
  const repo = path.join(root, 'repo'), vault = path.join(root, 'notes');
  mkdirSync(repo, { recursive: true }); mkdirSync(vault);
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(path.join(repo, 'file.md'), '# Workspace\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'fixture');
  return { repo, vault, note: path.join(vault, 'note.md') };
}
async function protect(vault: string) {
  await updateOperatorDefaults({ knowledgeSources: [{ id: crypto.randomUUID(), name: 'Notes', path: vault, include: ['**/*.md'], exclude: [] }] });
}
async function branch(repo: string, name = 'note.md') {
  return branches.POST(new NextRequest('http://localhost/api/panel/branches', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path: repo, branch: name }),
  }));
}
beforeEach(async () => { f.singleLinkCount = false; await updateOperatorDefaults({ knowledgeSources: [] }); });
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(f.root, { recursive: true, force: true }); });

const metadata = [
  'HEAD', 'config', 'refs/heads/alias', 'refs/remotes/origin/alias',
  'logs/HEAD', 'logs/refs/heads/note.md', 'logs/refs/remotes/origin/alias',
  'packed-refs', 'index', 'objects/pack/pack-canary.pack', 'objects/info/commit-graph',
  'worktrees/alias/HEAD', 'worktrees/alias/index', 'worktrees/alias/logs/HEAD',
  'worktrees/alias/gitdir', 'worktrees/alias/commondir', 'worktrees/alias/config.worktree',
  'loose object',
] as const;
const aliases = ['hardlink', 'symlink', 'rename-over', 'symlink to external hardlink'] as const;

it.each(metadata.flatMap(storage => aliases.map(alias => [storage, alias] as const)))(
  'refuses Git metadata %s via %s and preserves protected bytes', async (storage, alias) => {
    const { repo, vault, note } = fixture();
    const object = git(repo, 'rev-parse', 'HEAD');
    const relative = storage === 'loose object' ? `objects/${object.slice(0, 2)}/${object.slice(2)}` : storage;
    const target = path.join(repo, '.git', relative);
    mkdirSync(path.dirname(target), { recursive: true });
    const content = existsSync(target) ? readFileSync(target)
      : Buffer.from(storage === 'packed-refs' ? '# pack-refs with: peeled fully-peeled sorted \n'
        : storage.startsWith('refs/') || storage.endsWith('/HEAD') ? `${object}\n` : '# Protected metadata canary\n');
    writeFileSync(note, content); await protect(vault);
    if (alias === 'rename-over') {
      const control = await branch(repo, 'before-replacement');
      expect(control.status, await control.text()).toBe(200);
      const staged = `${target}.replacement`; linkSync(note, staged); renameSync(staged, target);
    } else {
      rmSync(target, { force: true });
      if (alias === 'hardlink') linkSync(note, target);
      else if (alias === 'symlink') symlinkSync(note, target, 'file');
      else {
        const outside = path.join(path.dirname(repo), 'outside-metadata');
        linkSync(note, outside); symlinkSync(outside, target, 'file');
      }
    }
    const retained = readFileSync(note);
    expect(statSync(target).ino).toBe(statSync(note).ino);
    expect(statSync(target).dev).toBe(statSync(note).dev);
    const response = await branch(repo);
    expect.soft(readFileSync(note), 'protected note bytes changed').toEqual(retained);
    expect.soft(response.status, await response.clone().text()).toBe(403);
    expect(await response.text()).toContain('knowledge_source_read_only');
  },
);

it.each(['direct', 'nested'] as const)('compares protected %s file dev/inode even with a single reported link', async location => {
  const { repo, vault, note } = fixture();
  const protectedFile = location === 'nested' ? path.join(vault, 'nested', 'note.md') : note;
  mkdirSync(path.dirname(protectedFile), { recursive: true }); writeFileSync(protectedFile, '# Protected inode canary\n');
  await protect(vault);
  const log = path.join(repo, '.git/logs/refs/heads/note.md'); linkSync(protectedFile, log);
  f.singleLinkCount = true;
  const retained = readFileSync(protectedFile);
  const response = await branch(repo);
  expect.soft(readFileSync(protectedFile)).toEqual(retained);
  expect(response.status, await response.text()).toBe(403);
});

it('refuses multiply linked metadata even when its other name is outside protected sources', async () => {
  const { repo, vault, note } = fixture(); writeFileSync(note, '# Unrelated notes\n'); await protect(vault);
  const external = path.join(path.dirname(repo), 'external-log'); writeFileSync(external, '# External log\n');
  linkSync(external, path.join(repo, '.git/logs/refs/heads/note.md'));
  const retained = readFileSync(note), externalBytes = readFileSync(external);
  const response = await branch(repo);
  expect.soft(readFileSync(note)).toEqual(retained); expect.soft(readFileSync(external)).toEqual(externalBytes);
  expect(response.status, await response.text()).toBe(403);
});

it('allows single-link metadata again after replacing a hardlink with an independent file', async () => {
  const { repo, vault, note } = fixture(); writeFileSync(note, '# Retained replacement control\n'); await protect(vault);
  const target = path.join(repo, '.git/logs/refs/heads/note.md'); linkSync(note, target);
  const refused = await branch(repo); expect(refused.status, await refused.text()).toBe(403);
  const staged = `${target}.replacement`; writeFileSync(staged, '# Independent log\n'); renameSync(staged, target);
  const retained = readFileSync(note);
  const allowed = await branch(repo); expect(allowed.status, await allowed.text()).toBe(200);
  expect(readFileSync(note)).toEqual(retained);
});
