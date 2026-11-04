import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-codex-multi-identity-'));
const dataDir = path.join(fixtureRoot, 'data');
const primaryHome = path.join(fixtureRoot, 'primary-home');
const secondaryHome = path.join(fixtureRoot, 'secondary-home');
const workspace = path.join(fixtureRoot, 'workspace');
const fakeCodex = path.join(fixtureRoot, 'codex-fixture.mjs');
const auditPath = path.join(fixtureRoot, 'app-server-home-audit.log');
const previousEnv = {
  CODEX_HOME: process.env.CODEX_HOME,
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_CODEX_BIN: process.env.O8_CODEX_BIN,
  O8_CODEX_IDENTITY_AUDIT: process.env.O8_CODEX_IDENTITY_AUDIT,
  O8_CODEX_FIXTURE_WORKSPACE: process.env.O8_CODEX_FIXTURE_WORKSPACE,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  O8_WORKER_ENV_ALLOW: process.env.O8_WORKER_ENV_ALLOW,
};

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function makeCodexHome(home: string, threadId: string, secret: string): void {
  const rolloutDir = path.join(home, 'sessions', '2026', '08', '12');
  mkdirSync(rolloutDir, { recursive: true });
  writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ token: secret }), 'utf8');
  execFileSync('sqlite3', [path.join(home, 'state_5.sqlite'), [
    'create table threads (',
    'id text primary key, title text, cwd text, updated_at integer, rollout_path text,',
    'git_branch text, git_sha text, git_origin_url text, first_user_message text, model text, archived integer',
    ');',
    'create table logs (thread_id text, process_uuid text, ts integer);',
  ].join(' ')]);
  insertCodexThread(home, threadId);
}

function insertCodexThread(home: string, threadId: string): void {
  const rolloutPath = path.join(home, 'sessions', '2026', '08', '12', `${threadId}.jsonl`);
  writeFileSync(rolloutPath, `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n`, 'utf8');
  const updatedAt = Math.floor(Date.now() / 1_000);
  execFileSync('sqlite3', [path.join(home, 'state_5.sqlite'), [
    `insert into threads values (${sqlString(threadId)}, 'fixture', ${sqlString(workspace)}, ${updatedAt}, ${sqlString(rolloutPath)}, 'main', 'abc123', '', 'fixture task', 'fixture-model', 0);`,
  ].join(' ')]);
}

function restoreEnv(name: keyof typeof previousEnv): void {
  const value = previousEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterAll(() => {
  for (const name of Object.keys(previousEnv) as Array<keyof typeof previousEnv>) restoreEnv(name);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('Codex multi-identity provider sessions', () => {
  it('discovers, imports, and transforms a secondary-home session without projecting private identity state', async () => {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    makeCodexHome(primaryHome, 'primary-thread', 'primary-secret-must-stay-private');
    makeCodexHome(secondaryHome, 'secondary-thread', 'secondary-secret-must-stay-private');
    writeFileSync(fakeCodex, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.145.0\\n');
  process.exit(0);
}
appendFileSync(process.env.O8_CODEX_IDENTITY_AUDIT, process.env.CODEX_HOME + '\\n');
const expectedThread = process.env.CODEX_HOME.endsWith('secondary-home') ? 'secondary-thread' : 'primary-thread';
const thread = (id) => ({
  id, preview: 'fixture task', createdAt: 1, updatedAt: 2,
  status: { type: 'idle' }, cwd: process.env.O8_CODEX_FIXTURE_WORKSPACE,
  gitInfo: { sha: 'abc123', branch: 'main', originUrl: null }, name: null, turns: [],
});
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: request.id, result: { userAgent: 'fixture' } }) + '\\n');
  } else if (request.method === 'thread/read') {
    process.stdout.write(JSON.stringify({
      id: request.id,
      result: { thread: request.params.threadId === expectedThread ? thread(expectedThread) : null },
    }) + '\\n');
  }
});
`, { mode: 0o755 });
    chmodSync(fakeCodex, 0o755);
    process.env.CODEX_HOME = primaryHome;
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    process.env.O8_DATA_DIR = dataDir;
    process.env.O8_CODEX_BIN = fakeCodex;
    process.env.O8_CODEX_IDENTITY_AUDIT = auditPath;
    process.env.O8_CODEX_FIXTURE_WORKSPACE = workspace;
    // Worker children inherit only allowlisted names; the fixture reads these test knobs.
    process.env.O8_WORKER_ENV_ALLOW = 'O8_CODEX_IDENTITY_AUDIT,O8_CODEX_FIXTURE_WORKSPACE';

    const {
      registerRuntimeIdentity,
      resetRuntimeIdentityCatalogForTests,
    } = await import('@/lib/runtime/identity-catalog');
    resetRuntimeIdentityCatalogForTests();
    const primary = await registerRuntimeIdentity({
      runtime: 'codex',
      label: 'Primary private label',
      configHomeRef: primaryHome,
    });
    const secondary = await registerRuntimeIdentity({
      runtime: 'codex',
      label: 'Secondary private label',
      configHomeRef: secondaryHome,
    });
    const { invalidateCodexDiscoveredFleetCache } = await import('@/lib/codex/sessions');
    const { codexRuntime } = await import('@/lib/runtimes/codex');
    const { resumeDiscoveredCodexSession } = await import('@/lib/codex/discovered-resume');
    const { getSessionTransformState, performSessionTransform } = await import('@/lib/runtime/session-transforms');
    invalidateCodexDiscoveredFleetCache();

    const beforeImport = await codexRuntime.discoverSessions({ fresh: true });
    expect(beforeImport).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionKey: 'codex:primary-thread', identityId: primary.id }),
      expect.objectContaining({ sessionKey: 'codex:secondary-thread', identityId: secondary.id }),
    ]));

    const imported = await performSessionTransform({
      action: 'import',
      runtimeId: 'codex',
      sessionKey: 'codex:secondary-thread',
      expectedCatalogVersion: 0,
      clientMutationId: 'secondary-identity-import',
    });
    expect(imported).toMatchObject({ ok: true, resultingSessionKey: 'codex:secondary-thread' });
    expect(readFileSync(auditPath, 'utf8').trim().split('\n').at(-1)).toBe(secondaryHome);

    invalidateCodexDiscoveredFleetCache();
    const afterImport = await codexRuntime.discoverSessions({ fresh: true });
    expect(afterImport).toContainEqual(expect.objectContaining({
      sessionKey: 'codex:secondary-thread',
      identityId: secondary.id,
    }));
    const state = await getSessionTransformState('codex', 'codex:secondary-thread');
    expect(state.catalogSession).toMatchObject({
      sessionKey: 'codex:secondary-thread',
      identityId: secondary.id,
    });

    const catalogBytes = readFileSync(path.join(dataDir, 'session-transform-catalog.json'), 'utf8');
    const projected = JSON.stringify({ beforeImport, afterImport, imported, state });
    for (const privateValue of [
      primaryHome,
      secondaryHome,
      'Primary private label',
      'Secondary private label',
      'primary-secret-must-stay-private',
      'secondary-secret-must-stay-private',
    ]) {
      expect(projected).not.toContain(privateValue);
      expect(catalogBytes).not.toContain(privateValue);
    }

    insertCodexThread(primaryHome, 'duplicated-thread');
    insertCodexThread(secondaryHome, 'duplicated-thread');
    invalidateCodexDiscoveredFleetCache();
    const duplicateDiscovery = await codexRuntime.discoverSessions({ fresh: true });
    expect(duplicateDiscovery).not.toContainEqual(expect.objectContaining({
      sessionKey: 'codex:duplicated-thread',
    }));
    await expect(codexRuntime.readTranscript('codex:duplicated-thread')).rejects.toThrow(
      'Codex runtime surface was not found.',
    );
    const auditBeforeResume = readFileSync(auditPath, 'utf8');
    await expect(codexRuntime.resume('codex:duplicated-thread', 'must not cross identities')).resolves.toMatchObject({
      ok: false,
      note: expect.stringContaining('ambiguous across registered identities'),
    });
    await expect(resumeDiscoveredCodexSession(
      'codex:duplicated-thread',
      'mobile must not cross identities',
    )).resolves.toMatchObject({ ok: false, status: 409 });
    expect(readFileSync(auditPath, 'utf8')).toBe(auditBeforeResume);
    await expect(performSessionTransform({
      action: 'import',
      runtimeId: 'codex',
      sessionKey: 'codex:duplicated-thread',
      expectedCatalogVersion: 1,
      clientMutationId: 'ambiguous-identity-import',
    })).rejects.toMatchObject({ reason: 'session_not_found' });
    expect(readFileSync(auditPath, 'utf8')).toBe(auditBeforeResume);

    await expect(performSessionTransform({
      action: 'checkpoint',
      runtimeId: 'codex',
      sessionKey: 'codex:secondary-thread',
      expectedCatalogVersion: 1,
      clientMutationId: 'secondary-checkpoint-after-ambiguity',
    })).rejects.toMatchObject({ reason: 'stale_checkpoint' });
    expect(readFileSync(auditPath, 'utf8').trim().split('\n').at(-1)).toBe(secondaryHome);
  }, 30_000);
});
