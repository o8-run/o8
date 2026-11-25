/**
 * Dispatch-time file checks read a real Git repository at dispatch, with no
 * index behind them: the overlap hold, read budget, edge-case sites,
 * preservation envelope and base line counts.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { computeReadBudget } from '@/lib/dispatch/read-budget';
import { surfaceEdgeCases } from '@/lib/dispatch/edge-case-surfacer';
import { buildPreservationEnvelope, computePredictedFiles, filterOverlappingPackets } from '@/lib/orchestrator/preservation-envelope';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { clearTrackedFiles, findImporters, lineCountsAt, trackedFiles } from '@/lib/repo-files/lookup';

let repoPath: string;

function git(args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(file: string, text: string): void {
  mkdirSync(join(repoPath, file, '..'), { recursive: true });
  writeFileSync(join(repoPath, file), text);
}

function packet(id: string, summary: string): OrchestratorPacket {
  return { id, title: id, summary, workspaceTargetPath: repoPath, status: 'queued' } as OrchestratorPacket;
}

async function predicted(id: string, summary: string): Promise<OrchestratorPacket> {
  const draft = packet(id, summary);
  return { ...draft, predictedFiles: await computePredictedFiles(draft) };
}

beforeAll(() => {
  repoPath = realpathSync(mkdtempSync(join(tmpdir(), 'o8-dispatch-files-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'o8-test']);
  git(['config', 'user.email', 'o8@example.test']);
  write('src/lib/store.ts', "export function readStore(): string {\n  return 'value';\n}\n");
  write('src/lib/view.ts', "import { readStore } from '@/lib/store';\n\nexport const view = () => readStore();\n");
  write('src/app/page.ts', "import { view } from '../lib/view';\nif (!view()) throw new Error('missing view');\n");
  write('src/other/view.ts', "export const unrelated = 1;\n");
  write('docs/notes.md', '# Notes\n');
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
});

afterAll(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

it('holds two tasks naming the same file apart and runs two naming different files together', async () => {
  const first = await predicted('first', 'Change src/lib/store.ts to cache reads');
  const same = await predicted('same', 'Rename readStore in src/lib/store.ts today');
  const other = await predicted('other', 'Update docs/notes.md wording');
  expect(first.predictedFiles).toEqual(['src/lib/store.ts']);
  expect(other.predictedFiles).toEqual(['docs/notes.md']);

  expect(filterOverlappingPackets([first, same], []).map((entry) => entry.id)).toEqual(['first']);
  expect(filterOverlappingPackets([same], [first]).map((entry) => entry.id)).toEqual([]);
  expect(filterOverlappingPackets([first, other], []).map((entry) => entry.id)).toEqual(['first', 'other']);
});

it('sees a newly staged file once the Git index changes', async () => {
  expect((await predicted('before', 'Edit src/lib/added.ts now')).predictedFiles).toEqual([]);
  write('src/lib/added.ts', 'export const added = true;\n');
  git(['add', 'src/lib/added.ts']);
  expect((await predicted('after', 'Edit src/lib/added.ts now')).predictedFiles).toEqual(['src/lib/added.ts']);
});

it('reads imports, importers and line counts from the files at dispatch', async () => {
  const tracked = await trackedFiles(repoPath);
  expect(tracked?.set.has('src/lib/view.ts')).toBe(true);

  const importers = await findImporters(repoPath, ['src/lib/view.ts', 'src/lib/store.ts'], tracked!.set);
  // `src/other/view.ts` shares the basename but nothing imports it.
  expect(importers.get('src/lib/view.ts')).toEqual(['src/app/page.ts']);
  expect(importers.get('src/lib/store.ts')).toEqual(['src/lib/view.ts']);

  const budget = await computeReadBudget({ repoPath, targetFiles: ['src/lib/view.ts'], tier: 'weak' });
  expect(budget?.requiredReads).toEqual(['src/lib/store.ts']);

  const { sites } = await surfaceEdgeCases({ repoPath, targetFiles: ['src/lib/view.ts'] });
  expect(sites).toContainEqual(expect.objectContaining({ location: 'src/app/page.ts:2', kind: 'error-handler' }));

  const envelope = await buildPreservationEnvelope(await predicted('envelope', 'Edit src/lib/store.ts now'));
  expect(envelope).toContain('src/lib/store.ts (3 lines):');
  expect(envelope).toContain('  - export function readStore(): string');
});

it('counts base-branch lines for the merge gate and leaves new files out', async () => {
  git(['switch', '-q', '-c', 'feature']);
  write('src/lib/store.ts', 'export const replaced = 1;\n');
  write('src/lib/new.ts', 'export const fresh = 1;\n');
  const counts = await lineCountsAt(repoPath, 'main', ['src/lib/store.ts', 'src/lib/new.ts', 'docs/notes.md']);
  expect(Object.fromEntries(counts)).toEqual({ 'src/lib/store.ts': 3, 'docs/notes.md': 1 });
  git(['checkout', '-q', '--', '.']);
  git(['switch', '-q', 'main']);
});

it('gives the merge gate no count, so no budget, when the base lookup misses or runs out of time', async () => {
  // The outline database had no row for an unscanned file, and the gate skipped its budget.
  expect((await lineCountsAt(repoPath, 'no-such-branch', ['src/lib/store.ts'])).size).toBe(0);
  // A spent deadline returns before Git starts, so no runner can finish the read in time.
  expect((await lineCountsAt(repoPath, 'main', ['src/lib/store.ts'], Date.now() - 1_000)).size).toBe(0);
  clearTrackedFiles(repoPath);
  expect(await trackedFiles(repoPath, Date.now() - 1_000)).toBeNull();
  // The same read with time left does count the file, so the cases above are misses, not a broken reader.
  expect(Object.fromEntries(await lineCountsAt(repoPath, 'main', ['src/lib/store.ts']))).toEqual({ 'src/lib/store.ts': 3 });
  expect((await lineCountsAt(join(repoPath, 'missing'), 'main', ['src/lib/store.ts'])).size).toBe(0);
});

it('returns no facts instead of throwing outside a repository', async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'o8-dispatch-no-repo-')));
  try {
    expect(await trackedFiles(outside)).toBeNull();
    expect(await computePredictedFiles({ ...packet('none', 'Edit src/lib/store.ts now'), workspaceTargetPath: outside })).toEqual([]);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
