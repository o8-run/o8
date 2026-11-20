import Database from 'better-sqlite3';
import { ensureMobileDeviceSchema } from '../../src/lib/db/mobile-device-schema';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ENV_SECRET = 'orchidvioletmaterial';
export const DEVICE_SECRET = 'a3'.repeat(32);
export const WORKER_SECRET = 'legacyfixtureworkerbearer';
export const ROTATED_SECRET = 'b4'.repeat(32);
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
export interface DiffCase { path: string; native: boolean; label: string }
export function gitDiffCorpus(directory: string, operator: string): DiffCase[] {
  const db = new Database(join(directory, 'cortex-ide.db'));
  try { ensureMobileDeviceSchema(db); db.prepare('INSERT INTO mobile_devices (id, token_hash, identity_public_key) VALUES (?, ?, ?)').run('diff-device', tokenHash(DEVICE_SECRET), 'diff-identity'); } finally { db.close(); }
  writeFileSync(join(directory, 'mobile-device-tokens'), tokenHash(DEVICE_SECRET) + '\n');
  writeFileSync(join(directory, 'worker-token'), WORKER_SECRET);
  const corpus: DiffCase[] = [];
  for (const name of ['clean', 'modified', 'staged', 'untracked', 'binary', 'large', 'capped', 'redaction', 'unsupported', 'symlink']) {
    const repo = join(directory, name); mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' });
    git('init', '-q'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture');
    writeFileSync(join(repo, 'plain.txt'), name === 'redaction' ? 'before\n' + 'context\n'.repeat(30) : 'before\n');
    git('add', '.'); git('commit', '-qm', 'fixture');
    if (name === 'symlink') { writeFileSync(join(directory, 'outside.txt'), ENV_SECRET); unlinkSync(join(repo, 'plain.txt')); symlinkSync(join(directory, 'outside.txt'), join(repo, 'plain.txt')); }
    if (name === 'unsupported') writeFileSync(join(repo, 'plain.txt'), 'password = "fixture only"\n');
    if (name === 'modified') writeFileSync(join(repo, 'plain.txt'), 'after\n');
    if (name === 'staged') { writeFileSync(join(repo, 'plain.txt'), 'staged\n'); git('add', '.'); }
    if (name === 'untracked') writeFileSync(join(repo, 'new.txt'), 'new\n');
    if (name === 'binary') writeFileSync(join(repo, 'plain.txt'), Buffer.from([0, 1, 2]));
    if (name === 'large' || name === 'capped') writeFileSync(join(repo, 'plain.txt'), 'new line\n'.repeat(name === 'large' ? 70_000 : 9_000));
    if (name === 'redaction') writeFileSync(join(repo, 'plain.txt'), [ENV_SECRET, operator, DEVICE_SECRET,
      [...ENV_SECRET].map(c => '%' + c.charCodeAt(0).toString(16)).join(''), 'context\n'.repeat(30)].join('\n'));
    for (const route of ['diff-summary', 'diff']) corpus.push({
      path: '/api/worktrees/' + route + '?' + new URLSearchParams({ worktreePath: repo }), native: name !== 'unsupported' || route === 'diff-summary', label: name + ':' + route,
    });
    corpus.push({ path: '/api/panel/file-diff?' + new URLSearchParams({ workspace: repo, path: name === 'untracked' ? 'new.txt' : 'plain.txt' }), native: name !== 'unsupported', label: name + ':panel' });
  }
  const lanes = new Database(join(directory, 'cortex-ide.db'));
  try {
    for (const status of ['running', 'archived', 'completed', 'failed']) {
      lanes.prepare(`INSERT INTO lanes (id, label, repo_path, worktree_path, branch, base_branch, runtime, session_key, status, ownership, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'fixture', 'HEAD', 'claude', ?, ?, 'attached', '2026-01-01', '2026-01-01')`)
        .run('diff-' + status, 'Fixture diff', join(directory, 'clean'), join(directory, 'modified'), 'diff-' + status, status);
      for (const route of ['diff-summary', 'diff']) corpus.push({ path: '/api/worktrees/' + route + '?sessionKey=diff-' + status, native: true, label: 'session-' + status + ':' + route });
    }
  } finally { lanes.close(); }
  for (const route of ['diff-summary', 'diff']) {
    corpus.push({ path: '/api/worktrees/' + route + '?sessionKey=missing', native: true, label: 'missing:' + route });
    corpus.push({ path: '/api/worktrees/' + route + '?' + new URLSearchParams({ worktreePath: join(directory, 'absent') }), native: true, label: 'absent:' + route });
  }
  corpus.push({ path: '/api/worktrees/diff?' + new URLSearchParams({ worktreePath: join(directory, 'clean'), file: '../outside' }), native: true, label: 'file-path-refusal' });
  corpus.push({ path: '/api/worktrees/diff?' + new URLSearchParams({ worktreePath: join(directory, 'clean'), headSha: 'bad' }), native: true, label: 'head-refusal' });
  corpus.push({ path: '/api/panel/file-diff?' + new URLSearchParams({ workspace: join(directory, 'clean'), path: '../outside' }), native: true, label: 'panel-path-refusal' });
  corpus.push({ path: '/api/panel/file-diff?' + new URLSearchParams({ workspace: join(directory, 'clean'), path: 'plain.txt', base: '--output=outside' }), native: true, label: 'base-refusal' });
  // Bounded stream byte observation remains TS-owned, retaining its exact count.
  corpus.push({ path: '/api/worktrees/diff?' + new URLSearchParams({ worktreePath: join(directory, 'modified'), maxBytes: '10' }), native: false, label: 'stream-cap-fallback' });
  corpus.push({ path: '/api/worktrees/diff?' + new URLSearchParams({ worktreePath: '~/clean' }), native: true, label: 'home-expansion' });
  corpus.push({ path: '/api/panel/file-diff?' + new URLSearchParams({ workspace: '~/clean', path: '../outside.txt' }), native: true, label: 'home-workspace-boundary' });
  return corpus;
}
