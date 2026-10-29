import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
import type { RuntimeLaunchResult } from '@/lib/runtime/actions';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function registration(repo: string, workspace: string) {
  const stat = lstatSync(workspace);
  const gitStat = lstatSync(join(workspace, '.git'));
  return {
    device: stat.dev,
    inode: stat.ino,
    gitDevice: gitStat.dev,
    gitInode: gitStat.ino,
    gitFile: gitStat.isFile(),
    gitDirectory: gitStat.isDirectory(),
    commonDir: realpathSync(git(workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir')),
    branch: git(workspace, 'branch', '--show-current'),
    head: git(workspace, 'rev-parse', 'HEAD'),
    worktrees: git(repo, 'worktree', 'list', '--porcelain'),
  };
}

export function declarativeGovernanceRollbackTests(fixture: { repo: () => string }) {
  it.each(['git-worktree', 'auto'] as const)(
    'stops the worker and retains its workspace when the real route cannot persist its governance lane (%s)',
    async (preference) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
      const repoPath = fixture.repo();
      const { addRepo, updateRepo } = await import('@/lib/repos/registry');
      const repo = await addRepo(repoPath);
      // A linked-worktree assertion must actually launch that layout. Auto on
      // APFS creates an independent repository, absent from the parent's list.
      await updateRepo(repo.id, { setup: { ...repo.setup, workspaceIsolationPreference: preference } });
      const { getApfsCowCapability } = await import('@/lib/worktree/apfs');
      const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
      const capability = preference === 'auto'
        ? await getApfsCowCapability(repoPath, resolveWorktreeRootLayout(repoPath).primaryBase)
        : null;
      const expectedKind = capability?.canCowClone ? 'apfs-cow-clone' : 'git-worktree';
      const laneRegistry = await import('@/lib/lane/registry');
      const { getRuntime } = await import('@/lib/runtimes');
      const runtime = getRuntime('qoder')!;
      const sessionsBefore = new Set((await runtime.discoverSessions()).map((session) => session.sessionKey));
      let before: ReturnType<typeof registration> | undefined;
      const createLane = vi.spyOn(laneRegistry, 'createLane').mockImplementationOnce((input) => {
        before = registration(repoPath, input.worktreePath!);
        throw new Error('synthetic lane persistence failure');
      });
      try {
        const { POST } = await import('@/app/api/runtime/launch/route');
        const response = await POST(new NextRequest('http://localhost/api/runtime/launch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            runtime: 'qoder',
            prompt: 'prove launch rollback',
            repoPath,
            isolate: true,
            clientMutationId: `runtime-launch-lane-failure-${preference}`,
          }),
        }));

        expect(response.status).toBe(409);
        const result = await response.json() as RuntimeLaunchResult;
        expect(result).toMatchObject({
          ok: false,
          outcomeUnknown: true,
          retryable: false,
          surfaceId: expect.stringMatching(/^qoder-owned:/),
          note: expect.stringContaining('its worktree could not be cleaned after governance registration failed'),
          worktree: { isolationKind: expectedKind },
        });
        expect(createLane).toHaveBeenCalledTimes(1);
        const workspace = result.worktree!;
        expect(existsSync(workspace.path)).toBe(true);
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const extra = (await runtime.discoverSessions())
            .filter((session) => !sessionsBefore.has(session.sessionKey));
          if (extra.length === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect((await runtime.discoverSessions())
          .filter((session) => !sessionsBefore.has(session.sessionKey))).toEqual([]);
        const after = registration(repoPath, workspace.path);
        expect(before).toBeDefined();
        expect(after).toEqual(before);
        expect(after.branch).toBe(workspace.branch);
        expect(after.head).toBe(git(repoPath, 'rev-parse', 'HEAD'));
        if (expectedKind === 'git-worktree') {
          // Preserve the original two-registration requirement for this layout.
          expect(after.worktrees.match(/^worktree /gm)).toHaveLength(2);
          expect(after.worktrees).toContain(`worktree ${workspace.path}\n`);
          expect(after).toMatchObject({ gitFile: true, gitDirectory: false, commonDir: join(repoPath, '.git') });
        } else {
          expect(after.worktrees.match(/^worktree /gm)).toHaveLength(1);
          expect(after).toMatchObject({ gitFile: false, gitDirectory: true, commonDir: join(workspace.path, '.git') });
          expect(git(workspace.path, 'worktree', 'list', '--porcelain')).toContain(`worktree ${workspace.path}\n`);
        }
        const { readWorktreeMetaSnapshot } = await import('@/lib/worktree/metadata-store');
        expect((await readWorktreeMetaSnapshot(repoPath))[workspace.id]).toMatchObject({
          status: 'ready',
          sessionKey: result.surfaceId,
          branchName: workspace.branch,
          isolationKind: expectedKind,
          materializationIdentity: { canonicalPath: workspace.path, device: after.device, inode: after.inode },
        });
        expect(laneRegistry.listLanes().filter((lane) => lane.sessionKey === result.surfaceId)).toEqual([]);
      } finally {
        createLane.mockRestore();
      }
    },
    40_000,
  );
}
