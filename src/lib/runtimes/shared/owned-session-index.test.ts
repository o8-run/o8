/**
 * Shared owned-session index — semantics + memoization (perf, 2026-07-03).
 * Pins the three-way return contract the liveness probes depend on, and that
 * the 2s TTL shares one readdir instead of re-scanning per lookup.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  listOwnedActiveRuns,
  lookupOwnedActiveRun,
  lookupOwnedActiveRunFresh,
  resetOwnedSessionIndex,
} from './owned-session-index';

let root = '';
function writeSession(dir: string, surfaceId: string, activeRun: unknown, packetId?: string) {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'session.json'), JSON.stringify({ surfaceId, packetId, ...(activeRun !== undefined ? { activeRun } : {}) }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'o8-owned-idx-'));
  process.env.CORTEX_IDE_OWNED_CODEX_ROOT = root;
  process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = root;
  process.env.O8_OWNED_GEMINI_ROOT = root;
  process.env.O8_OWNED_OPENCODE_ROOT = root;
  process.env.O8_OWNED_CURSOR_ROOT = root;
  process.env.O8_OWNED_GROK_ROOT = root;
  process.env.O8_OWNED_PRIME_AGENT_ROOT = root;
  process.env.O8_OWNED_PI_ROOT = root;
  resetOwnedSessionIndex();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.CORTEX_IDE_OWNED_CODEX_ROOT;
  delete process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT;
  delete process.env.O8_OWNED_GEMINI_ROOT;
  delete process.env.O8_OWNED_OPENCODE_ROOT;
  delete process.env.O8_OWNED_CURSOR_ROOT;
  delete process.env.O8_OWNED_GROK_ROOT;
  delete process.env.O8_OWNED_PRIME_AGENT_ROOT;
  delete process.env.O8_OWNED_PI_ROOT;
  resetOwnedSessionIndex();
});

describe('lookupOwnedActiveRun', () => {
  it('preserves explicit legacy capture instead of inferring required identity for the packet', async () => {
    writeSession('legacy', 'codex-owned:legacy-capture', { pid: process.pid, processIdentityRequired: false }, 'packet');
    expect((await lookupOwnedActiveRunFresh('codex-owned:legacy-capture'))?.processIdentityRequired).not.toBe(true);
  });

  it('null when the surface is not present under its root', async () => {
    expect(await lookupOwnedActiveRun('codex-owned:absent', 1000)).toBeNull();
  });

  it('{} when present but activeRun is cleared (definitively dead)', async () => {
    writeSession('s1', 'codex-owned:cleared', undefined);
    resetOwnedSessionIndex();
    expect(await lookupOwnedActiveRun('codex-owned:cleared', 1000)).toEqual({});
  });

  it('returns the run (pid/tmux) when present with an active run', async () => {
    writeSession('s2', 'codex-owned:live', { pid: 4242, tmuxSession: 'sess-x' });
    resetOwnedSessionIndex();
    expect(await lookupOwnedActiveRun('codex-owned:live', 1000)).toEqual({ pid: 4242, tmuxSession: 'sess-x' });
  });

  it('lists active runs once and omits cleared session metadata', async () => {
    writeSession('s-live', 'codex-owned:list-live', { pid: 99 });
    writeSession('s-cleared', 'codex-owned:list-cleared', undefined);
    resetOwnedSessionIndex();
    expect(await listOwnedActiveRuns(1000)).toEqual([
      { surfaceId: 'codex-owned:list-live', pid: 99, tmuxSession: undefined },
    ]);
  });

  it('indexes Claude Code owned workers under their own root marker', async () => {
    writeSession('s-claude', 'claude-code-owned:live', { pid: 31337 });
    resetOwnedSessionIndex();
    expect(await lookupOwnedActiveRun('claude-code-owned:live', 1000)).toEqual({ pid: 31337, tmuxSession: undefined });
  });

  it('indexes every registry-backed owned worker prefix', async () => {
    const surfaces = [
      'gemini-owned:live',
      'opencode-owned:live',
      'cursor-owned:live',
      'grok-owned:live',
      'prime-agent-owned:live',
      'pi-owned:live',
    ];
    surfaces.forEach((surfaceId, index) => writeSession(`owned-${index}`, surfaceId, { pid: 5000 + index }));
    resetOwnedSessionIndex();

    for (const [index, surfaceId] of surfaces.entries()) {
      expect(await lookupOwnedActiveRun(surfaceId, 1000)).toEqual({ pid: 5000 + index, tmuxSession: undefined });
    }
  });

  it('reads a known session beside a FIFO and refuses to infer a missing owner is dead', async () => {
    writeSession('known', 'codex-owned:known', { pid: 4242 });
    const sibling = join(root, 'unreadable');
    mkdirSync(sibling);
    const fifo = join(sibling, 'session.json');
    execFileSync('mkfifo', ['-m', '600', fifo], { timeout: 2_000 });
    const identity = lstatSync(fifo);
    expect(await lookupOwnedActiveRunFresh('codex-owned:known')).toMatchObject({ pid: 4242 });
    await expect(lookupOwnedActiveRunFresh('codex-owned:unreadable')).rejects.toThrow('unreadable metadata');
    const after = lstatSync(fifo);
    expect(after.isFIFO()).toBe(true);
    expect([after.dev, after.ino, after.size]).toEqual([identity.dev, identity.ino, identity.size]);
  });

  it('finds a session whose metadata is rewritten during the fresh scan', async () => {
    writeSession('busy', 'codex-owned:busy', { pid: 4242 });
    const file = join(root, 'busy/session.json');
    const record = JSON.stringify({ surfaceId: 'codex-owned:busy', activeRun: { pid: 4242 }, padding: 'x'.repeat(1 << 20) });
    let writing = true;
    const writer = (async () => {
      for (let turn = 0; writing; turn += 1) {
        writeFileSync(`${file}.${turn}.tmp`, record);
        renameSync(`${file}.${turn}.tmp`, file);
        await new Promise(resolve => setTimeout(resolve, 15));
      }
    })();
    try {
      for (let lookup = 0; lookup < 100; lookup += 1) {
        expect(await lookupOwnedActiveRunFresh('codex-owned:busy')).toMatchObject({ pid: 4242 });
      }
    } finally {
      writing = false;
      await writer;
    }
  });

  it('keeps malformed session metadata unknown while allowing a valid sibling lookup', async () => {
    writeSession('known', 'codex-owned:known', undefined);
    writeSession('corrupt', 'codex-owned:corrupt', undefined);
    writeFileSync(join(root, 'corrupt/session.json'), '{');
    expect(await lookupOwnedActiveRunFresh('codex-owned:known')).toEqual({});
    await expect(lookupOwnedActiveRunFresh('codex-owned:corrupt')).rejects.toThrow('unreadable metadata');
  });

  it('null for a surfaceId that matches no known root marker', async () => {
    expect(await lookupOwnedActiveRun('claude-code:live-1', 1000)).toBeNull();
  });

  it('memoizes within the TTL — a write after the first scan is not seen until TTL expiry', async () => {
    const t0 = 1_700_000_000_000;
    expect(await lookupOwnedActiveRun('codex-owned:new', t0)).toBeNull(); // scan #1, empty
    writeSession('s3', 'codex-owned:new', { pid: 7 });
    // Within TTL: still the cached (empty) index.
    expect(await lookupOwnedActiveRun('codex-owned:new', t0 + 1_000)).toBeNull();
    // Past the 2s TTL: fresh scan sees it.
    expect(await lookupOwnedActiveRun('codex-owned:new', t0 + 2_100)).toEqual({ pid: 7 });
  });

  it('bypasses a stale miss for safety-critical kill decisions', async () => {
    const t0 = 1_700_000_000_000;
    expect(await lookupOwnedActiveRun('pi-owned:new', t0)).toBeNull();
    writeSession('pi-new', 'pi-owned:new', { pid: 8 });

    expect(await lookupOwnedActiveRunFresh('pi-owned:new')).toEqual({ pid: 8, tmuxSession: undefined });
  });

  it('preserves the latest exact run marker through a fresh stop lookup', async () => {
    const surfaceId = 'claude-code-owned:marker';
    writeSession('marker', surfaceId, { pid: 8, processMarker: 'old-run' });
    expect(await lookupOwnedActiveRun(surfaceId)).toMatchObject({ processMarker: 'old-run' });
    writeSession('marker', surfaceId, {
      pid: 9, processGroupId: 9, commandIdentity: 'sandbox-exec', processMarker: 'new-run',
    });
    expect(await lookupOwnedActiveRunFresh(surfaceId)).toMatchObject({
      pid: 9, processGroupId: 9, commandIdentity: 'sandbox-exec', processMarker: 'new-run',
    });
  });
});
