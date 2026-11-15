import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-codex-default-identity-'));
const defaultHome = path.join(fixtureRoot, 'default-home');
const dataDir = path.join(fixtureRoot, 'data');
const previousEnv = {
  CODEX_HOME: process.env.CODEX_HOME,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
};
const threadId = '01a1dc1b-0000-7000-8000-000000000001';
const rolloutPath = path.join(defaultHome, 'sessions', '2026', '11', '14', `rollout-${threadId}.jsonl`);

beforeAll(() => {
  mkdirSync(path.dirname(rolloutPath), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(rolloutPath, `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n`, 'utf8');
  execFileSync('sqlite3', [path.join(defaultHome, 'state_5.sqlite'), [
    'create table threads (',
    'id text primary key, title text, cwd text, updated_at integer, rollout_path text,',
    'git_branch text, git_sha text, git_origin_url text, first_user_message text, model text, archived integer',
    ');',
    `insert into threads values ('${threadId}', 'fixture', '${fixtureRoot}', 1, '${rolloutPath}', 'main', '', '', '', 'model', 0);`,
  ].join(' ')]);
  process.env.CODEX_HOME = defaultHome;
  process.env.O8_DATA_DIR = dataDir;
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
});

afterAll(() => {
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('a Codex session launched with no saved identity selected', () => {
  it('finds its rollout in the default home, so its transcript keeps times and edits', async () => {
    const { getCodexRolloutPath } = await import('./sessions');
    const { realpathSync } = await import('node:fs');
    await expect(getCodexRolloutPath(`codex:${threadId}`, 'codex-local-default')).resolves.toBe(realpathSync(rolloutPath));
  });

  it('still does not match a saved identity that does not own the home', async () => {
    const { getCodexRolloutPath } = await import('./sessions');
    await expect(getCodexRolloutPath(`codex:${threadId}`, 'codex-some-other-identity')).resolves.toBeNull();
  });

  it('matches the default identity only to the default home', async () => {
    const { codexHomeMatchesIdentity, CODEX_LOCAL_DEFAULT_IDENTITY_ID } = await import('./discovery-store');
    expect(codexHomeMatchesIdentity({ configHomeRef: '/a', isDefault: true }, CODEX_LOCAL_DEFAULT_IDENTITY_ID)).toBe(true);
    expect(codexHomeMatchesIdentity({ configHomeRef: '/b', identityId: 'x' }, CODEX_LOCAL_DEFAULT_IDENTITY_ID)).toBe(false);
    expect(codexHomeMatchesIdentity({ configHomeRef: '/b', identityId: 'x' }, 'x')).toBe(true);
  });
});
