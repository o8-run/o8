import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/runtimes/shared/cli-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/cli-resolver')>();
  return { ...actual, resolveCli: vi.fn(async () => {
    throw new actual.CliNotFoundError('fixture-missing-cli', []);
  }) };
});

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-discovery-no-probe-'));
vi.stubEnv('PI_CODING_AGENT_DIR', path.join(root, 'absent-user-pi'));
vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', '');
process.env.O8_OWNED_PI_ROOT = path.join(root, 'pi');
const { resolveCli } = await import('@/lib/runtimes/shared/cli-resolver');
const { discoverRuntimeSessions } = await import('@/lib/runtime/inventory-discovery');
const { piRuntime } = await import('@/lib/runtimes/pi');
const { antigravityRuntime } = await import('@/lib/runtimes/antigravity');
const runtimes = [piRuntime, antigravityRuntime];

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('runtime inventory does not probe CLI installation to read owned sessions', () => {
  it('runs repeated fresh discovery through the real aggregator without resolving any CLI', async () => {
    for (let tick = 0; tick < 3; tick += 1) {
      const discovered = await discoverRuntimeSessions(runtimes, { fresh: true });
      expect(discovered).toHaveLength(runtimes.length);
      for (const entry of discovered) {
        expect(entry.status).toBe('fulfilled');
        if (entry.status === 'fulfilled') expect(entry.value.sessions).toEqual([]);
      }
    }
    expect(resolveCli).not.toHaveBeenCalled();
  });

  it('keeps a persisted session visible when its executable is no longer installed', async () => {
    const sessionDir = path.join(process.env.O8_OWNED_PI_ROOT!, 'saved-session');
    mkdirSync(sessionDir, { recursive: true });
    const metadata = path.join(sessionDir, 'session.json');
    const saved = JSON.stringify({
      surfaceId: 'pi-owned:saved-session', sessionDir, cwd: root, repoPath: root,
      title: 'Saved worker result', createdAt: '2026-09-07T00:00:00.000Z',
      updatedAt: '2026-09-07T00:00:00.000Z', latestPrompt: 'fixture',
      latestSummary: 'Finished fixture work', recentRuns: [],
    });
    writeFileSync(metadata, saved);
    const results = await discoverRuntimeSessions([piRuntime], { fresh: true });
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { sessions: [
      { sessionKey: 'pi-owned:saved-session', ownership: 'owned', initialTask: 'Finished fixture work' },
    ] } });
    expect(readFileSync(metadata, 'utf8')).toBe(saved);
    expect(resolveCli).not.toHaveBeenCalled();
  });
});
