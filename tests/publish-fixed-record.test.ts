/**
 * publishFixed() records shipped Fixes-Report ids for the in-app receipt.
 *
 * The public #fixed Discord channel was retired (2026-10-28). The fix receipt
 * now reaches reporters only through fixed.json, which release.mjs builds from
 * published.json. A ship must still record every fixed report there, with no
 * webhook configured and nothing posted anywhere.
 * Real-path test: a real temp git repo with a real trailer, the real ledger and
 * published.json under a temp operator data directory.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// @ts-expect-error — plain .mjs build script, no type declarations by design
import { publishFixed } from '../scripts/publish-fixed.mjs';

const ENV_KEYS = ['O8_OPERATOR_DATA_DIR', 'O8_INTAKE_RECONCILIATION', 'O8_FIXED_WEBHOOK_URL', 'OPENROUTER_API_KEY'] as const;

let repo: string;
let dataDir: string;
let previousCwd: string;
let previousEnv: Record<string, string | undefined>;

function git(args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function commit(message: string) {
  writeFileSync(path.join(repo, 'f.txt'), `${message}\n${Math.random()}`);
  git(['add', 'f.txt']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message]);
}

beforeEach(() => {
  previousCwd = process.cwd();
  previousEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  repo = mkdtempSync(path.join(os.tmpdir(), 'publish-fixed-repo-'));
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'publish-fixed-data-'));
  git(['init', '-q']);
  process.chdir(repo);
  writeFileSync(path.join(repo, 'o8.release.json'), '{}\n');
  process.env.O8_OPERATOR_DATA_DIR = dataDir;
  process.env.O8_INTAKE_RECONCILIATION = 'disabled';
  delete process.env.O8_FIXED_WEBHOOK_URL;
  delete process.env.OPENROUTER_API_KEY;
  mkdirSync(path.join(dataDir, 'feedback'), { recursive: true });
  writeFileSync(
    path.join(dataDir, 'feedback', 'reports.jsonl'),
    `${JSON.stringify({ id: 'ABC123', title: 'Diff panel went blank', reporter: 'someone' })}\n`,
  );
});

afterEach(() => {
  process.chdir(previousCwd);
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  vi.restoreAllMocks();
  rmSync(repo, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

it('records a shipped fix in published.json without a webhook and posts nothing', async () => {
  commit('chore: base');
  git(['tag', 'v0.1.900']);
  commit('fix: keep the diff panel visible\n\nFixes-Report: ABC123');
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  const { entries, missing } = await publishFixed({ range: 'v0.1.900..HEAD', version: '0.1.901' });

  expect(entries.map((entry: { id: string }) => entry.id)).toEqual(['ABC123']);
  expect(missing).toEqual([]);
  expect(fetchSpy).not.toHaveBeenCalled();
  const published = JSON.parse(readFileSync(path.join(dataDir, 'feedback', 'published.json'), 'utf8'));
  expect(published.fixed).toHaveLength(1);
  expect(published.fixed[0]).toMatchObject({ id: 'ABC123', version: '0.1.901' });

  // A rerun over the same range records nothing twice.
  const again = await publishFixed({ range: 'v0.1.900..HEAD', version: '0.1.901' });
  expect(again.entries).toEqual([]);
  expect(JSON.parse(readFileSync(path.join(dataDir, 'feedback', 'published.json'), 'utf8')).fixed).toHaveLength(1);
});
