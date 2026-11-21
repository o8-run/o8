import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const resolveCliMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock('@/lib/runtimes/shared/cli-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/cli-resolver')>();
  return {
    ...actual,
    resolveCli: resolveCliMock,
  };
});

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-empty-spawn-routes-'));
const repoPath = path.join(dataDir, 'repo');
execFileSync('git', ['init', '-q', repoPath]);
process.env.CORTEX_IDE_DATA_DIR = dataDir;
delete process.env.O8_DATA_DIR;

const { CliNotFoundError } = await import('@/lib/runtimes/shared/cli-resolver');
const cliProxyRoute = await import('@/app/api/v2/proxy/cli/route');

beforeEach(() => {
  spawnMock.mockReset();
  resolveCliMock.mockReset();
  resolveCliMock.mockRejectedValue(
    new CliNotFoundError('codex', ['env:O8_CODEX_BIN', 'which:codex']),
  );
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('cold-start runtime spawn routes', () => {
  it('returns an install action instead of a raw spawn ENOENT from the CLI proxy', async () => {
    const response = await cliProxyRoute.POST(new Request('http://localhost/api/v2/proxy/cli', {
      method: 'POST',
      body: JSON.stringify({
        runtime: 'codex',
        model: 'cli:codex:gpt-5.6-sol',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }));
    const payload = await response.json() as { code?: string; error?: string };

    expect(response.status).toBe(503);
    expect(payload.code).toBe('runtime_not_installed');
    expect(payload.error).toContain('[runtime] Codex is not installed');
    expect(payload.error).toContain('npm i -g @openai/codex');
    expect(payload.error).not.toContain('ENOENT');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses an unregistered repo path instead of silently spawning from the server cwd', async () => {
    const response = await cliProxyRoute.POST(new Request('http://localhost/api/v2/proxy/cli', {
      method: 'POST',
      body: JSON.stringify({
        runtime: 'codex',
        model: 'cli:codex:gpt-5.6-sol',
        messages: [{ role: 'user', content: 'hello' }],
        repoPath,
      }),
    }));
    const payload = await response.json() as { code?: string; error?: string };

    expect(response.status).toBe(400);
    expect(payload.code).toBe('repo_unavailable');
    expect(payload.error).toContain('[repo]');
    expect(payload.error).toContain('must match a path registered');
    expect(resolveCliMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
