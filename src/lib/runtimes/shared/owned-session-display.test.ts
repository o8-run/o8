import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readOwnedSessionDisplay } from '@/lib/runtimes/shared/owned-session-index';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('owned session summary', () => {
  it('restores the task, pinned model, and completed state from an archived worker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-owned-summary-'));
    roots.push(root);
    const activeRoot = join(root, 'owned-codex');
    vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', activeRoot);
    const sessionDir = join(root, 'owned-codex-archive', 'proof-c');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId: 'codex-owned:proof-c',
      title: 'Proof C',
      model: 'gpt-5.6-terra',
      recentRuns: [{ outcome: 'finished', startedAt: '2026-09-26T00:00:00Z' }],
    }));

    expect(await readOwnedSessionDisplay('codex-owned:proof-c')).toEqual({
      sessionKey: 'codex-owned:proof-c',
      name: 'Proof C',
      model: 'gpt-5.6-terra',
      runtime: 'codex',
      status: 'completed',
    });
  });

  it('refuses a path-like session identifier', async () => {
    expect(await readOwnedSessionDisplay('codex-owned:../secret')).toBeNull();
  });
});
