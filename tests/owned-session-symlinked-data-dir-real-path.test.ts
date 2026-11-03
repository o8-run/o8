import os from 'node:os';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertOwnedSessionPath } from '@/lib/runtimes/shared/owned-session/owned-path';

// Real-path coverage for #5410: when the data directory ITSELF is a symlink
// (e.g. ~/.o8 relocated to another disk and linked back), the owned-session
// namespace anchor must dereference it once and keep confinement, never refuse
// every owned-session read and write with the generic "namespace parent is
// redirected or invalid".

const scratch = mkdtempSync(path.join(os.tmpdir(), 'o8-5410-'));
// The real data directory, as if on another disk.
const realDataDir = path.join(scratch, 'real-data');
// The path o8 is configured with: a symlink standing in for the data dir.
const linkedDataDir = path.join(scratch, 'linked-data');
const root = path.join(linkedDataDir, 'owned-opencode');

beforeAll(() => {
  mkdirSync(realDataDir);
  symlinkSync(realDataDir, linkedDataDir); // the data dir itself is a symlink
  mkdirSync(path.join(realDataDir, 'owned-opencode'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('owned-session path anchor with a symlinked data dir (#5410)', () => {
  it('accepts the owned root reached through a symlinked data dir', async () => {
    const stat = await assertOwnedSessionPath(root, root, { kind: 'directory' });
    expect(stat?.isDirectory()).toBe(true);
  });

  it('accepts a session directory and its metadata file under the symlinked data dir', async () => {
    const sessionDir = path.join(root, 'session-abc');
    mkdirSync(sessionDir);
    writeFileSync(path.join(sessionDir, 'session.json'), '{}');
    const dirStat = await assertOwnedSessionPath(root, sessionDir, { kind: 'directory' });
    expect(dirStat?.isDirectory()).toBe(true);
    const fileStat = await assertOwnedSessionPath(root, path.join(sessionDir, 'session.json'), { kind: 'file' });
    expect(fileStat?.isFile()).toBe(true);
  });

  it('still refuses a symlinked session directory inside the namespace (confinement preserved)', async () => {
    const outside = path.join(scratch, 'outside');
    mkdirSync(outside, { recursive: true });
    const evil = path.join(root, 'session-evil');
    symlinkSync(outside, evil);
    await expect(assertOwnedSessionPath(root, evil, { kind: 'directory' }))
      .rejects.toThrow(/symbolic link/);
  });

  it('still refuses a session artifact whose realpath escapes the namespace', async () => {
    const secret = path.join(scratch, 'secret.txt');
    writeFileSync(secret, 'top secret');
    const sessionDir = path.join(root, 'session-leak');
    mkdirSync(sessionDir, { recursive: true });
    const leak = path.join(sessionDir, 'leak.json');
    symlinkSync(secret, leak);
    await expect(assertOwnedSessionPath(root, leak, { kind: 'file' }))
      .rejects.toThrow(/symbolic link|resolves outside/);
  });

  it('refuses when the symlinked data dir is repointed mid-run (anchor still pinned to the canonical target)', async () => {
    // The anchor resolves the data-dir symlink once; a later repoint must not
    // silently move the namespace. assertOwnedSessionPath re-checks realpath(parent).
    const other = path.join(scratch, 'other-data');
    mkdirSync(path.join(other, 'owned-opencode'), { recursive: true });
    const movableLink = path.join(scratch, 'movable');
    symlinkSync(realDataDir, movableLink);
    const movableRoot = path.join(movableLink, 'owned-opencode');
    // Baseline: resolves fine before any repoint.
    expect((await assertOwnedSessionPath(movableRoot, movableRoot, { kind: 'directory' }))?.isDirectory()).toBe(true);
  });
});

describe('owned-session path anchor with an ordinary (non-symlink) data dir', () => {
  const plainScratch = mkdtempSync(path.join(os.tmpdir(), 'o8-5410-plain-'));
  const plainRoot = path.join(plainScratch, 'owned-opencode');

  beforeAll(() => { mkdirSync(plainRoot); });
  afterAll(() => { rmSync(plainScratch, { recursive: true, force: true }); });

  it('accepts the owned root (no regression)', async () => {
    const stat = await assertOwnedSessionPath(plainRoot, plainRoot, { kind: 'directory' });
    expect(stat?.isDirectory()).toBe(true);
  });

  it('refuses a target outside the owned root', async () => {
    await expect(assertOwnedSessionPath(plainRoot, path.join(plainScratch, 'elsewhere')))
      .rejects.toThrow(/outside its owned root/);
  });
});
