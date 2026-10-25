import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn() }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, statfs: vi.fn(async (file: string) => {
    const info = await actual.statfs(file);
    return file.includes('warm-safety-') ? { ...info, blocks: Math.floor(4 * 1024 ** 3 / info.bsize) } : info;
  }) };
});
vi.mock('@/lib/worktree/storage-telemetry', async original => ({
  ...await original<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({ accountingStatus: 'observed', probePath: '/',
    availableBytes: 90_000_000_000, freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null })),
}));

const npmCli = process.env.npm_execpath!;
const npmVersion = execFileSync(process.execPath, [npmCli, '--version'], { encoding: 'utf8' }).trim();
const root = realpathSync(mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'warm-safety-')));
let directory: string;
let repo: string;
let visitor: ChildProcess | undefined;
let close: (() => void) | undefined;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();

beforeEach(() => {
  vi.resetModules();
  directory = mkdtempSync(join(root, 'case-'));
  repo = join(directory, 'repo');
  const bin = join(directory, 'bin');
  mkdirSync(repo); mkdirSync(bin);
  vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
  vi.stubEnv('O8_DATA_DIR', directory);
  vi.stubEnv('O8_WORKTREE_ROOT', join(directory, 'worktrees'));
  vi.stubEnv('O8_SKIP_PRELAUNCH_TYPECHECK', '1');
  vi.stubEnv('O8_APFS_COW_WORKSPACES', '0');
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'README.md'), 'original\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'warm-safety', version: '1.0.0', packageManager: `npm@${npmVersion}`,
    o8DependencyClone: { lifecycleInputs: [] } }));
  writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3,
    packages: { 'node_modules/fixture': { version: '1.0.0' } } }));
  git('init', '-q', '-b', 'main'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
  writeFileSync(join(bin, 'npm'), '#!/usr/bin/env node\n' + [
    "const fs = require('node:fs');",
    `if (process.argv[2] !== 'ci') { const p = require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(npmCli)}, ...process.argv.slice(2)], { stdio: 'inherit' }); process.exit(p.status ?? 1); }`,
    "fs.mkdirSync('node_modules/fixture', { recursive: true });",
    "fs.writeFileSync('node_modules/fixture/package.json', '{\"name\":\"fixture\",\"version\":\"1.0.0\"}');",
    "fs.writeFileSync('node_modules/fixture/index.js', 'module.exports = 42;\\n');",
  ].join('\n'));
  chmodSync(join(bin, 'npm'), 0o755);
});

afterEach(async () => {
  if (visitor?.exitCode === null && visitor.signalCode === null) {
    const exited = once(visitor, 'exit'); visitor.kill(); await exited;
  }
  visitor = undefined;
  close?.(); close = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

it.each(['notes', 'dependencies', 'git-administration', 'live-process', 'unsealed'] as const)(
  'retains a prepared tree after %s makes retirement unsafe', async change => {
    const { WorktreeManager } = await import('@/lib/worktree/manager');
    const { closeDb } = await import('@/lib/db'); close = closeDb;
    const { readWorktreeMetaSnapshot, withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
    const { addRepo } = await import('@/lib/repos/registry');
    const registration = await addRepo(repo);
    const manager = new WorktreeManager(repo);
    const { reserveWarmPacketSlot } = await import('@/lib/worktree/warm-packet-budget');
    const token = reserveWarmPacketSlot(repo)!;
    const { worktree } = await manager.prepareWarmWorktree({ agentType: 'codex', taskName: `warm-${token}`, warmReservationToken: token,
      warmBaseCommit: git('rev-parse', 'HEAD'), baseBranch: 'main', isolationPreference: 'git-worktree',
      repoSetup: { ...registration.setup, installOnCreateWorkspace: true, installCommand: 'npm ci --offline' } }, () => {});
    const meta = (await readWorktreeMetaSnapshot(repo))[worktree.id]!;
    expect(meta.warmPool?.seal).toBeDefined();
    let retained = join(worktree.path, 'README.md');
    if (change === 'notes') {
      retained = join(worktree.path, 'operator-notes.txt'); writeFileSync(retained, 'retain these notes');
    } else if (change === 'dependencies') {
      retained = join(worktree.path, 'node_modules/fixture/index.js'); writeFileSync(retained, 'retain dependency bytes');
    } else if (change === 'git-administration') {
      retained = join(meta.warmPool!.seal!.adminIdentity.canonicalPath, 'unexpected'); writeFileSync(retained, 'retain git bytes');
    } else if (change === 'unsealed') {
      await withWorktreeMetaTransaction(repo, t => t.save(meta.id, { ...meta, warmPool: { ...meta.warmPool!, seal: undefined } }));
    } else {
      visitor = spawn(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"],
        { cwd: worktree.path, stdio: ['ignore', 'pipe', 'pipe'] });
      await once(visitor.stdout!, 'data');
    }
    const content = readFileSync(retained, 'utf8');
    await expect(manager.retireWarmWorktree(worktree.id)).rejects.toThrow();
    expect(existsSync(worktree.path)).toBe(true);
    expect(readFileSync(retained, 'utf8')).toBe(content);
    expect((await readWorktreeMetaSnapshot(repo))[worktree.id]).toBeDefined();
    const { getSqlite } = await import('@/lib/db');
    expect(getSqlite().prepare('SELECT count(*) FROM warm_packet_slots').pluck().get()).toBe(1);
  },
);
