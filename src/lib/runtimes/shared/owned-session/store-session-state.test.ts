import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OwnedRuntimeAdapter, OwnedSessionRecord, ParsedRunLog } from './types';

// Partial mock: other modules in this import graph bind registry exports at
// load time, so a replacement factory rots the moment the registry grows one.
vi.mock('@/lib/lane/registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/lane/registry')>(),
  listActiveLanes: () => [],
}));

function testAdapter(root: string): OwnedRuntimeAdapter {
  return {
    runtimeId: 'state-test',
    surfaceIdPrefix: 'state-owned:',
    rootEnvVar: 'O8_TEST_SESSION_STATE_ROOT',
    rootDefault: root,
    binaryName: 'node',
    binaryEnvOverride: 'O8_TEST_SESSION_STATE_BIN',
    humanLabel: 'Owned State Test',
    squadShortName: 'State Test',
    launchArgs: () => [],
    resumeArgs: () => [],
    parseRunLog: (): ParsedRunLog => ({ entries: [], outcome: 'finished', completedTurn: true }),
  };
}

function writeMetadata(sessionDir: string, surfaceId: string) {
  mkdirSync(sessionDir, { recursive: true });
  const record: OwnedSessionRecord = {
    surfaceId,
    sessionDir,
    cwd: '/tmp',
    repoPath: '/tmp',
    title: surfaceId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    latestPrompt: '',
    latestSummary: '',
    recentRuns: [],
  };
  writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(record));
}

describe('owned-session store sessionState', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    delete process.env.O8_TEST_SESSION_STATE_ROOT;
    for (const tempRoot of tempRoots.splice(0)) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('distinguishes active, archived, and missing session metadata without mutation', async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-owned-session-state-'));
    tempRoots.push(tempRoot);
    const root = path.join(tempRoot, 'sessions');
    process.env.O8_TEST_SESSION_STATE_ROOT = root;
    const activeId = 'state-owned:active-id';
    const archivedId = 'state-owned:archived-id';
    writeMetadata(path.join(root, 'active-id'), activeId);
    writeMetadata(path.join(`${root}-archive`, 'archived-id'), archivedId);

    const { createOwnedSessionStore } = await import('./store');
    const store = createOwnedSessionStore(testAdapter(root));

    await expect(store.sessionState(activeId)).resolves.toBe('active');
    await expect(store.sessionState(archivedId)).resolves.toBe('archived');
    await expect(store.sessionState('state-owned:missing-id')).resolves.toBe('missing');

    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}-archive`, { recursive: true, force: true });
    await expect(store.sessionState('state-owned:still-missing')).resolves.toBe('missing');
    expect(existsSync(root)).toBe(false);
    expect(existsSync(`${root}-archive`)).toBe(false);
  });

  // #5452: the 15s refresh timer and the construction sweep both read the fleet
  // through listSessionDirs. A read must never materialize the root — otherwise a
  // tick landing between a caller's cleanup and its next check resurrects the dir,
  // which is the order/timing-sensitive Hermetic shard 1 failure on push runs.
  it('a fleet refresh does not create the roots when they are absent (#5452)', async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-owned-session-refresh-'));
    tempRoots.push(tempRoot);
    const root = path.join(tempRoot, 'sessions');
    process.env.O8_TEST_SESSION_STATE_ROOT = root;

    const { createOwnedSessionStore } = await import('./store');
    const store = createOwnedSessionStore(testAdapter(root));

    // getFleetAdditions({ fresh: true }) is exactly what the refresh timer calls.
    await store.getFleetAdditions({ fresh: true });

    expect(existsSync(root)).toBe(false);
    expect(existsSync(`${root}-archive`)).toBe(false);
  });
});
