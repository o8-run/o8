import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  launches: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/lane/commands', () => ({
  dispatch: vi.fn(async (command: { verb: string }) => (
    command.verb === 'open_lane'
      ? { ok: true, laneId: 'lane-automation-setup' }
      : { ok: true, note: 'automation launched' }
  )),
}));

vi.mock('@/lib/worktree/launch', () => ({
  prepareLaunchWorktree: vi.fn(async (options: Record<string, unknown>) => {
    captured.launches.push(options);
    return null;
  }),
}));


const root = mkdtempSync(path.join(os.tmpdir(), 'o8-automation-setup-real-path-'));
const dataDir = path.join(root, 'data');
const repoPath = path.join(root, 'repo');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function automationRequest(registeredRepoPath: string): Request {
  return new Request('http://localhost/api/automations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'registered setup automation',
      owner: 'operator@example.test',
      repoPath: registeredRepoPath,
      branch: 'main',
      runtime: 'codex',
      prompt: 'verify the registered setup contract',
      triggerKind: 'manual',
    }),
  });
}

afterAll(async () => {
  const { closeDb } = await import('@/lib/db');
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

describe('automation repository setup reachability', () => {
  it('passes persisted install opt-out and saved arguments through the real run route', async () => {
    mkdirSync(repoPath);
    git(repoPath, 'init', '-q', '-b', 'main');
    git(repoPath, 'config', 'user.name', 'o8 test');
    git(repoPath, 'config', 'user.email', 'o8-test@example.test');
    writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({
      name: 'automation-setup-fixture',
      version: '1.0.0',
      packageManager: 'npm@11.6.2',
    }, null, 2));
    writeFileSync(path.join(repoPath, 'package-lock.json'), JSON.stringify({
      name: 'automation-setup-fixture', version: '1.0.0', lockfileVersion: 3,
      packages: { '': { name: 'automation-setup-fixture', version: '1.0.0' } },
    }, null, 2));
    git(repoPath, 'add', 'package.json', 'package-lock.json');
    git(repoPath, 'commit', '-qm', 'base');

    const [{ addRepo, updateRepo }, createRoute, runRoute] = await Promise.all([
      import('@/lib/repos/registry'),
      import('@/app/api/automations/route'),
      import('@/app/api/automations/[id]/run/route'),
    ]);
    const repo = await addRepo(repoPath);
    await updateRepo(repo.id, {
      setup: {
        ...repo.setup,
        installCommand: 'npm ci --ignore-scripts',
        installOnCreateWorkspace: false,
      },
    });
    const createdResponse = await createRoute.POST(automationRequest(repo.localPath));
    const createdBody = await createdResponse.json() as { automation: { id: string } };
    expect(createdResponse.status).toBe(200);

    const firstRun = await runRoute.POST(
      new Request('http://localhost/api/automations/run', { method: 'POST' }),
      { params: Promise.resolve({ id: createdBody.automation.id }) },
    );
    expect(firstRun.status, await firstRun.clone().text()).toBe(200);
    expect(captured.launches.at(-1)).toMatchObject({
      repoRoot: repo.localPath,
      envMode: repo.setup.envMode,
      envFiles: repo.setup.envFiles,
      repoSetup: {
        installCommand: 'npm ci --ignore-scripts',
        installOnCreateWorkspace: false,
      },
    });

    await updateRepo(repo.id, {
      setup: {
        ...repo.setup,
        installCommand: 'npm ci --ignore-scripts',
        installOnCreateWorkspace: true,
      },
    });
    const secondRun = await runRoute.POST(
      new Request('http://localhost/api/automations/run', { method: 'POST' }),
      { params: Promise.resolve({ id: createdBody.automation.id }) },
    );
    expect(secondRun.status, await secondRun.clone().text()).toBe(200);
    expect(captured.launches.at(-1)).toMatchObject({
      repoSetup: {
        installCommand: 'npm ci --ignore-scripts',
        installOnCreateWorkspace: true,
      },
    });
  }, 30_000);
});
