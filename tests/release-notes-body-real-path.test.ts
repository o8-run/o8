import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLatestShip } from '../scripts/lib/public-release.mjs';
import { stableReleaseEffects } from '../scripts/lib/stable-release-effects.mjs';

// The 0.1.816 notes, whose release body lost half its bullets and stopped two mid-sentence.
const notes = readFileSync(join(process.cwd(), 'tests/fixtures/release-notes/0.1.816-next.md'), 'utf8');
const bullets = notes.split('\n').filter(Boolean).map(line => line.replace(/^- /, ''));
const roots: string[] = [];
const saved = { cli: process.env.O8_RELEASE_SUMMARY_CLI, cache: process.env.O8_RELEASE_SUMMARY_CACHE_DIR };
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  for (const [key, value] of [['O8_RELEASE_SUMMARY_CLI', saved.cli], ['O8_RELEASE_SUMMARY_CACHE_DIR', saved.cache]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
/** A release checkout tagged with these notes, and a summary publisher that fails as every one since 0.1.813 has. */
function release(markdown: string) {
  const root = mkdtempSync(join(tmpdir(), 'o8-release-notes-body-')); roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'release@example.test'); git(root, 'config', 'user.name', 'Release Test');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'chore: previous release');
  git(root, 'tag', 'v0.1.815');
  mkdirSync(join(root, 'release-notes'));
  writeFileSync(join(root, 'release-notes/next.md'), markdown);
  git(root, 'add', 'release-notes/next.md');
  git(root, 'commit', '-q', '-m', 'feat: workers beside your chat');
  git(root, 'tag', 'v0.1.816');
  const cli = join(root, 'codex');
  writeFileSync(cli, '#!/bin/sh\nexit 1\n'); chmodSync(cli, 0o755);
  process.env.O8_RELEASE_SUMMARY_CLI = cli;
  process.env.O8_RELEASE_SUMMARY_CACHE_DIR = join(root, 'summaries');
  return stableReleaseEffects({ root, version: '0.1.816', tag: 'v0.1.816', range: 'v0.1.815..v0.1.816', notesRef: 'v0.1.816' });
}

describe('release notes reach the release body and feed whole', () => {
  it('sets the GitHub release body to next.md as written', () => {
    const body = release(notes).prepareNotes();
    expect(body).toBe(notes);
    for (const bullet of bullets) expect(body).toContain(`- ${bullet}\n`);
  });

  it('falls back to the summary only when a ship has no notes', () => {
    const body = release('').prepareNotes();
    expect(body).toMatch(/^## What’s changed\n\n/);
    expect(body).toContain('- Workers beside your chat');
  });

  it('never stops a feed bullet mid-sentence', () => {
    const ship = buildLatestShip({ version: '0.1.816', tag: 'v0.1.816', publishedAt: '2026-11-06T10:20:00.000Z',
      releaseUrl: 'https://github.com/o8-run/o8/releases/tag/v0.1.816', commits: [{ sha: 'abcdef1', subject: 'chore: release' }],
      notesMarkdown: notes });
    const items = ship.sections[0].items;
    expect(items).toHaveLength(8);
    for (const item of items) {
      expect(item.length).toBeLessThanOrEqual(220);
      const source = bullets.find(bullet => bullet.startsWith(item));
      expect(source, item).toBeDefined();
      // Whole, or ending at one of its own sentence ends.
      expect(item === source || (/[.!?]$/.test(item) && /^\s/.test(source!.slice(item.length))), item).toBe(true);
    }
    expect(items[0]).toBe('Workers show up beside your chat. Each working agent gets its own pane in an automatic grid with its live transcript and a steer box, and the grid drops columns to keep cards readable.');
    expect(items[3]).toBe('Review opens on your working changes, stacks every changed file with a files drawer, and scopes to all changes, the last turn, staged or unstaged.');
  });

  it('leaves a bullet with no sentence end under the limit out of the feed', () => {
    const long = `- ${'Long running work '.repeat(15)}stays readable\n- Short note.\n`;
    const ship = buildLatestShip({ version: '0.1.816', tag: 'v0.1.816', publishedAt: '2026-11-06T10:20:00.000Z',
      releaseUrl: 'https://github.com/o8-run/o8/releases/tag/v0.1.816', commits: [{ sha: 'abcdef1', subject: 'chore: release' }],
      notesMarkdown: long });
    expect(ship.sections[0].items).toEqual(['Short note.']);
  });
});
