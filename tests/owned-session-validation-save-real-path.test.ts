import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { getSqlite } from '@/lib/db';
import { withOwnedArtifactAdmission } from '@/lib/runtimes/shared/owned-session/artifact-admission';
import { createOwnedSessionStore } from '@/lib/runtimes/shared/owned-session/store';
import { withOwnedActionFence } from '@/lib/runtimes/shared/owned-session/action-fence';
import { createOwnedSessionIo } from '@/lib/runtimes/shared/owned-session/session-io';
import type { OwnedRuntimeAdapter, OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

const control = vi.hoisted(() => {
  const { AsyncLocalStorage } = process.getBuiltinModule('node:async_hooks') as typeof import('node:async_hooks');
  return {
    operation: new AsyncLocalStorage<'admission' | 'save'>(),
    file: '', readsToSkip: 0, pause: null as (() => Promise<void>) | null,
    saved: null as (() => void) | null, waiting: null as (() => void) | null,
  };
});
// Preserve real filesystem IO and leases; only pause between validation's two
// inode observations, and observe whether the writer waits or actually renames.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      if (control.operation.getStore() === 'admission' && args[0] === control.file && control.pause) {
        if (control.readsToSkip > 0) control.readsToSkip -= 1;
        else {
          const pause = control.pause; control.pause = null;
          await pause();
        }
      }
      return actual.realpath(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      if (control.operation.getStore() === 'save' && args[1] === control.file) control.saved?.();
    },
  };
});
vi.mock('@/lib/orchestrator/workspace-lifecycle-lease', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/orchestrator/workspace-lifecycle-lease')>();
  return { ...actual, acquireWorkspaceLifecycleLease: (...args: Parameters<typeof actual.acquireWorkspaceLifecycleLease>) => {
    if (control.operation.getStore() === 'save' && args[0].startsWith('owned-artifacts:') && args[1]?.waitForLiveOwner !== false) control.waiting?.();
    return actual.acquireWorkspaceLifecycleLease(...args);
  } };
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { control.file = ''; control.readsToSkip = 0; control.pause = control.saved = control.waiting = null; });

it('serializes review persistence with resume admission metadata validation', async () => {
  getSqlite(); // Materialize the real lifecycle database before binding its root.
  const root = path.join(process.env.CORTEX_IDE_DATA_DIR!, 'validation-sessions');
  const sessionDir = path.join(root, 'fixture');
  await mkdir(sessionDir, { recursive: true });
  const io = createOwnedSessionIo({ root, surfacePrefix: 'fixture:', invalidateFleetCache: () => {} });
  const session: OwnedSessionRecord = { surfaceId: 'fixture:fixture', sessionDir, recentRuns: [],
    cwd: process.cwd(), repoPath: process.cwd(), createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(), title: 'before', latestPrompt: '', latestSummary: '' };
  await io.saveSession(session);
  const entered = deferred(); const resume = deferred(); const writerProgress = deferred();
  control.file = path.join(sessionDir, 'session.json');
  control.saved = control.waiting = writerProgress.resolve;
  const adapter: OwnedRuntimeAdapter = { runtimeId: 'validation-fixture', surfaceIdPrefix: 'fixture:',
    rootEnvVar: 'O8_TEST_VALIDATION_ROOT', rootDefault: root, binaryName: 'node', binaryEnvOverride: 'O8_TEST_VALIDATION_BIN',
    humanLabel: 'Owned Fixture', squadShortName: 'Fixture', launchArgs: () => [], resumeArgs: () => [],
    parseRunLog: () => ({ entries: [], outcome: 'finished', completedTurn: true }) };
  const reader = createOwnedSessionStore(adapter); const writer = createOwnedSessionStore(adapter);
  const validated = new Error('Validation reached the action fence.');
  // Ignore constructor orphan sweeps; pause only the real resume's validation.
  // Accounting observes the file once before resume's metadata validation.
  control.readsToSkip = 1;
  control.pause = async () => { entered.resolve(); await resume.promise; };
  const admission = control.operation.run('admission', () => withOwnedActionFence(session.surfaceId, async current => {
    expect(current?.surfaceId).toBe(session.surfaceId);
    throw validated; // End after the real admission read, before provider startup.
  }, () => reader.resume(session.surfaceId, 'continue')));
  // Attach rejection handling immediately; main refuses after the real rename.
  const admitted = admission.then(value => ({ value }), error => ({ error }));
  await entered.promise;
  const save = control.operation.run('save', () => writer.setReviewDisposition(session.surfaceId, 'resolved'));
  try {
    await writerProgress.promise;
  } finally { resume.resolve(); }
  await save;
  expect(await admitted).toEqual({ error: validated });
  expect(JSON.parse(await readFile(control.file, 'utf8'))).toMatchObject({ reviewDisposition: 'resolved' });
  // Launch/resume already own admission: nested persistence must remain reentrant.
  await withOwnedArtifactAdmission(root, () => io.saveSession({ ...session, title: 'nested' }));
  expect(await io.loadSession(sessionDir)).toMatchObject({ title: 'nested' });
});
