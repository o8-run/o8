import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import { closeDb, getSqlite } from '@/lib/db';
import { withOwnedArtifactRootLock } from '@/lib/runtimes/shared/owned-session/artifact-admission';
import { acquireWorkspaceLifecycleLease, releaseWorkspaceLifecycleLease } from '@/lib/orchestrator/workspace-lifecycle-lease';

let root: string;
let sessions: string;
beforeEach(() => {
  getSqlite();
  root = realpathSync(mkdtempSync(path.join(getDataDir(), 'artifact-retry-')));
  sessions = path.join(root, 'sessions');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
afterAll(() => closeDb());

it('marks real pre-operation contention retryable without entering a competing process', async () => {
  const moduleUrl = pathToFileURL(path.resolve('src/lib/runtimes/shared/owned-session/artifact-admission.ts')).href;
  const marker = path.join(root, 'entered');
  const script = `const imported = await import(${JSON.stringify(moduleUrl)});
    const api = imported.default ?? imported;
    try { await api.withOwnedArtifactRootLock(process.env.O8_TEST_ARTIFACT_ROOT, async () => {
      const fs = await import('node:fs'); fs.writeFileSync(process.env.O8_TEST_ARTIFACT_MARKER, 'entered');
    }); }
    catch (error) { if (error.code !== 'owned_artifact_admission_held') throw error;
      console.log('[cap-archive] HELD=' + JSON.stringify({code: error.code, retryable: error.retryable})); }`;
  await withOwnedArtifactRootLock(sessions, async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: '--conditions=react-server',
        O8_TEST_ARTIFACT_ROOT: sessions, O8_TEST_ARTIFACT_MARKER: marker }, timeout: 20_000,
    });
    expect(stdout.trim()).toBe('[cap-archive] HELD={"code":"owned_artifact_admission_held","retryable":true}');
  });
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(sessions)).toBe(false);
  expect(existsSync(`${sessions}-archive`)).toBe(false);
}, 30_000);

it('never advertises retry after an artifact operation has started', async () => {
  const lease = await acquireWorkspaceLifecycleLease('fixture-other-lifecycle-owner');
  const marker = path.join(root, 'operation-started');
  try {
    await expect(withOwnedArtifactRootLock(sessions, async () => {
      writeFileSync(marker, 'operation ran once');
      await acquireWorkspaceLifecycleLease('fixture-other-lifecycle-owner', { waitForLiveOwner: false });
    })).rejects.toMatchObject({ code: 'owned_artifact_admission_held', retryable: false });
    expect(readFileSync(marker, 'utf8')).toBe('operation ran once');
  } finally { releaseWorkspaceLifecycleLease(lease); }
});
