import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureSharedCheckoutTeam,
  failSharedCheckoutMember,
  recordSharedCheckoutMember,
  reserveSharedCheckoutMember,
} from '@/lib/orchestrator/shared-checkout-team';
import { sharedTeamWorkerLanes } from '@/app/dashboard/hooks/useOutsideWorkerLaunchBridge';
import { GET } from './route';
import { getOrCreateWsToken } from '@/lib/ws-auth';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('active Fast team workspace read', () => {
  it('restores a running worker and a failed launch with a real surface to native panes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-fast-placement-'));
    roots.push(root);
    const repoPath = join(root, 'repo');
    mkdirSync(repoPath);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
    writeFileSync(join(repoPath, 'README.md'), '# fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local', 'commit', '-m', 'fixture'], { cwd: repoPath });
    vi.stubEnv('O8_DATA_DIR', join(root, 'state'));
    const input = { repoPath, parentThreadId: 'thoughts-fast-parent' };
    await ensureSharedCheckoutTeam(input);
    await reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'Worker A', clientMutationId: 'a', paths: ['src/a'] });
    await recordSharedCheckoutMember({ ...input, surfaceId: 'codex-owned:fast-a', runtime: 'codex', taskName: 'Worker A', clientMutationId: 'a' });
    await reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'Worker B', clientMutationId: 'b', paths: ['src/b'] });
    await recordSharedCheckoutMember({ ...input, surfaceId: 'codex-owned:fast-b', runtime: 'codex', taskName: 'Worker B', clientMutationId: 'b' });
    await failSharedCheckoutMember({ ...input, clientMutationId: 'b' });
    const ownedSessionDir = join(root, 'state', 'owned-codex', 'fast-a');
    mkdirSync(ownedSessionDir, { recursive: true });
    vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', join(root, 'state', 'owned-codex'));
    writeFileSync(join(ownedSessionDir, 'session.json'), JSON.stringify({
      launchMutationId: 'a', surfaceId: 'codex-owned:fast-a', cwd: realpathSync(repoPath),
      repoPath: realpathSync(repoPath), recentRuns: [{ outcome: 'finished' }],
    }));

    const response = await GET(new NextRequest(
      `http://localhost/api/orchestrator/shared-team/active?repoPath=${encodeURIComponent(repoPath)}`,
      { headers: { authorization: `Bearer ${getOrCreateWsToken()}` } },
    ));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ team: {
      repoPath: realpathSync(repoPath),
      parentThreadId: 'thoughts-fast-parent',
      members: [
        { surfaceId: 'codex-owned:fast-a', runtime: 'codex', taskName: 'Worker A', state: 'running', outcome: 'finished' },
        { surfaceId: 'codex-owned:fast-b', runtime: 'codex', taskName: 'Worker B', state: 'failed', outcome: 'unknown' },
      ],
    } });
    expect(sharedTeamWorkerLanes(body.team).map((lane) => ({ sessionKey: lane.sessionKey, status: lane.status })))
      .toEqual([
        { sessionKey: 'codex-owned:fast-a', status: 'completed' },
        { sessionKey: 'codex-owned:fast-b', status: 'launch_failed' },
      ]);
  });
});

it('reads finished Shared membership after restart, deduplicates receipts, and excludes a different parent in the same repo', async () => {
  const { createHash } = await import('node:crypto');
  const root = mkdtempSync(join(tmpdir(), 'o8-team-history-')); roots.push(root);
  const repoPath = realpathSync(root); const state = join(root, 'state');
  vi.stubEnv('O8_DATA_DIR', state);
  vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', join(state, 'owned-codex'));
  const id = createHash('sha256').update(repoPath).digest('hex').slice(0, 24);
  const archive = join(state, 'shared-checkout-teams', 'archive'); mkdirSync(archive, { recursive: true });
  const member = { surfaceId: 'codex-owned:completed', runtime: 'codex', taskName: 'Finished work', state: 'running', clientMutationId: 'history-owned' };
  for (const suffix of ['100', '101']) writeFileSync(join(archive, `${id}-${suffix}.json`), JSON.stringify({ path: repoPath, parentThreadId: 'thoughts-parent', members: [member] }));
  writeFileSync(join(archive, `${id}-200.json`), JSON.stringify({ path: repoPath, parentThreadId: 'thoughts-other', members: [{ ...member, surfaceId: 'codex-owned:unrelated' }] }));
  const owned = join(state, 'owned-codex', 'completed'); mkdirSync(owned, { recursive: true });
  writeFileSync(join(owned, 'session.json'), JSON.stringify({ surfaceId: member.surfaceId, launchMutationId: member.clientMutationId, cwd: repoPath, repoPath, recentRuns: [{ outcome: 'finished' }] }));
  const url = `http://localhost/api/orchestrator/shared-team/active?repoPath=${encodeURIComponent(repoPath)}&threadId=thoughts-parent`;
  for (let read = 0; read < 2; read++) {
    const response = await GET(new NextRequest(url, { headers: { authorization: `Bearer ${getOrCreateWsToken()}` } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ threadId: 'thoughts-parent', workers: [{
      sessionKey: member.surfaceId, name: member.taskName, runtime: 'codex', status: 'completed',
      parentTurnId: null, returnStatus: null, returnReason: null, model: null, effort: null,
      recovery: { worktreePath: repoPath, worktreeExists: true, branch: null, runId: null,
        actions: [], retired: false },
    }] });
  }
});
