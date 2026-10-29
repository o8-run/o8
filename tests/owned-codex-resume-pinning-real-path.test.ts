import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import { NextRequest } from 'next/server';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
const seam = vi.hoisted(() => ({ afterPrepared: undefined as (() => void) | undefined,
  beforeSupervisor: undefined as (() => void) | undefined, finalGit: undefined as (() => void) | undefined,
  beforeBridge: undefined as (() => void) | undefined, inFinalClaim: false, bridgeAttempts: 0 }));
vi.mock('@/lib/providers/child-process', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/providers/child-process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
    const output = Reflect.apply(actual.execFileSync, undefined, args);
    if (seam.inFinalClaim && seam.finalGit && args[1]?.includes('rev-parse') && args[1]?.includes('HEAD')) {
      const callback = seam.finalGit; seam.finalGit = undefined; callback();
    }
    return output;
  } };
});
vi.mock('@/lib/runtimes/shared/owned-session/credential-spawn', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/owned-session/credential-spawn')>();
  return { ...actual, spawnCredentialCheckedChild: (...args: Parameters<typeof actual.spawnCredentialCheckedChild>) => {
    seam.inFinalClaim = true;
    try { return actual.spawnCredentialCheckedChild(...args); } finally { seam.inFinalClaim = false; }
  } };
});
vi.mock('@/lib/runtime/o8d-supervisor', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/runtime/o8d-supervisor')>();
  return { ...actual, processSupervisorEnabled: (...args: Parameters<typeof actual.processSupervisorEnabled>) => Boolean(seam.beforeSupervisor) || actual.processSupervisorEnabled(...args),
    ownedSupervisorClient: () => seam.beforeSupervisor ? { spawn: async (build: () => unknown) => {
      const callback = seam.beforeSupervisor!; seam.beforeSupervisor = undefined; callback();
      try { build(); } catch { throw new actual.SupervisorError('submission-refused'); }
      throw new Error('Fixture supervisor must not receive an admitted stale launch.');
    } } : actual.ownedSupervisorClient() };
});
vi.mock('@/lib/runtimes/shared/owned-session/session-io', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/owned-session/session-io')>();
  return { ...actual, createOwnedSessionIo: (...args: Parameters<typeof actual.createOwnedSessionIo>) => {
    const io = actual.createOwnedSessionIo(...args);
    return { ...io, saveSession: async (session: OwnedSessionRecord) => {
      await io.saveSession(session);
      if (session.activeRun?.spawnState === 'prepared' && seam.afterPrepared) {
        const callback = seam.afterPrepared; seam.afterPrepared = undefined; callback();
      }
    } };
  } };
});

// The runtime is a finite, offline executable. Keep readiness and supervisor
// notifications outside this test; store, argv, spawn, parser and disk are real.
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({
  ensureDispatchBackendReady: vi.fn(async () => ({ ready: true })),
}));
vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
  if (String(url).includes('/terminal-spawn')) { seam.bridgeAttempts++; const callback = seam.beforeBridge; seam.beforeBridge = undefined; callback?.(); }
  return new Response('{}', { status: 200 });
}));

const root = realpathSync(mkdtempSync(join(getDataDir(), 'codex-resume-pinning-')));
const sessionsRoot = join(root, 'sessions');
const binary = join(root, 'codex-fixture.mjs');
vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', sessionsRoot);
vi.stubEnv('O8_CODEX_BIN', binary);
vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '1');
vi.stubEnv('O8_WORKER_SANDBOX', 'off');

writeFileSync(binary, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-fixture 1.0.0');
} else {
  const resumeIndex = args.indexOf('resume');
  const threadId = resumeIndex < 0 ? 'fixture-saved-thread' : args[resumeIndex + 1];
  const modelIndex = args.indexOf('--model');
  const receipt = {
    args, threadId, cwd: process.cwd(),
    model: modelIndex < 0 ? 'fixture-default-other-model' : args[modelIndex + 1],
    effort: args.find((arg) => arg.startsWith('model_reasoning_effort=')) ?? 'fixture-default-effort',
  };
  appendFileSync(join(process.cwd(), 'argv-receipts.jsonl'), JSON.stringify(receipt) + '\\n');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
  console.log(JSON.stringify({ type: 'item.completed', item: {
    id: 'reply', type: 'agent_message', text: 'Offline fixture completed.',
  } }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
}
`);
chmodSync(binary, 0o700);

const {
  launchOwnedCodexSession,
  continueOwnedCodexSession,
  archiveOwnedCodexSession,
  getOwnedCodexRuntimeTail,
} = await import('@/lib/codex/owned');

function readSession(surfaceId: string): OwnedSessionRecord {
  const sessionDir = join(sessionsRoot, surfaceId.slice('codex-owned:'.length));
  return JSON.parse(readFileSync(join(sessionDir, 'session.json'), 'utf8'));
}

async function settledSession(surfaceId: string, runCount: number): Promise<OwnedSessionRecord> {
  await vi.waitFor(async () => {
    await getOwnedCodexRuntimeTail(surfaceId);
    const session = readSession(surfaceId);
    expect(session.activeRun).toBeUndefined();
    expect(session.threadId).toBe('fixture-saved-thread');
    expect(session.recentRuns).toHaveLength(runCount);
    expect(session.recentRuns.every((run) => run.outcome === 'finished' && run.childExit?.code === 0)).toBe(true);
  }, { timeout: 10_000, interval: 50 });
  return readSession(surfaceId);
}

beforeEach(() => { seam.afterPrepared = undefined; seam.beforeSupervisor = undefined; seam.finalGit = undefined; seam.beforeBridge = undefined; });

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('owned Codex persisted resume pins through a real process', () => {
  it.each(['prepared-head', 'supervisor-head', 'final-git-session', 'final-git-lane', 'bridge'] as const)('fences %s through the real approval route without a second offline process', async boundary => {
    const repoPath = join(root, `repo-terminal-${boundary}`);
    mkdirSync(repoPath);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();
    const commit = () => git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
    git('init', '-q', '-b', 'main'); commit();
    const launched = await launchOwnedCodexSession({ cwd: repoPath, prompt: 'initial fixture turn', model: 'gpt-5.6-sol', effort: 'high' });
    const session = await settledSession(launched.surfaceId, 1);
    const { attachSession, createLane, setLaneStatus } = await import('@/lib/lane/registry');
    const lane = createLane({ runtime: 'codex', repoPath, branch: 'main', sessionKey: session.surfaceId });
    setLaneStatus(lane.id, 'awaiting_input', 'system', 'approval_required');
    session.laneId = lane.id;
    // The offline process is detached; its persisted terminal binding supplies the adapter.
    session.recentRuns[0].tmuxSession = 'fixture-prepared-head-terminal';
    writeFileSync(join(session.sessionDir, 'session.json'), JSON.stringify(session));
    const { createApproval, getApproval } = await import('@/lib/approvals/store');
    const approval = createApproval({ source: 'runtime', runtime: 'codex', agent: 'codex', sessionKey: session.surfaceId, risk: 'medium', title: 'Resume', description: 'Resume', summary: 'Resume', metadata: { Lane: lane.id }, continuation: { kind: 'lane', laneId: lane.id, verb: 'resume' } });
    const { GET, POST } = await import('@/app/api/panel/approvals/route');
    const { getOrCreateWsToken } = await import('@/lib/ws-auth');
    const projection = await GET(new NextRequest(`http://localhost/api/panel/approvals?sessionKey=${session.surfaceId}&terminalSession=fixture-prepared-head-terminal`));
    const { terminalAdapter } = await projection.json();
    expect(terminalAdapter).toMatchObject({ runId: session.recentRuns[0].id });
    if (boundary === 'prepared-head') seam.afterPrepared = commit;
    if (boundary === 'bridge') seam.beforeBridge = commit;
    if (boundary === 'supervisor-head') seam.beforeSupervisor = commit;
    if (boundary === 'final-git-session') seam.finalGit = () => { const current = readSession(session.surfaceId); current.threadId = 'replacement-thread'; writeFileSync(join(session.sessionDir, 'session.json'), JSON.stringify(current)); };
    if (boundary === 'final-git-lane') seam.finalGit = () => { attachSession(lane.id, 'codex-owned:replacement', 'system'); };
    const bridgesBefore = seam.bridgeAttempts;
    if (boundary === 'bridge') vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '0');
    const response = await POST(new NextRequest('http://localhost/api/panel/approvals', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${getOrCreateWsToken()}` }, body: JSON.stringify({ id: approval.id, action: 'approve', terminalAdapter }) }));
    vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '1');
    expect(response.status).toBe(200);
    if (getApproval(approval.id)?.resolution?.continuationStatus === 'completed') await settledSession(session.surfaceId, 2);
    expect(seam.afterPrepared).toBeUndefined();
    if (boundary.startsWith('final-git')) expect(seam.finalGit).toBeUndefined();
    if (boundary === 'supervisor-head') expect(seam.beforeSupervisor).toBeUndefined();
    if (boundary === 'bridge') { expect(seam.bridgeAttempts).toBe(bridgesBefore); seam.beforeBridge = undefined; }
    expect(getApproval(approval.id)?.resolution?.continuationStatus, getApproval(approval.id)?.audit.at(-1)?.note).toBe(boundary === 'bridge' ? 'completed' : 'failed');
    expect(readFileSync(join(repoPath, 'argv-receipts.jsonl'), 'utf8').trim().split('\n')).toHaveLength(boundary === 'bridge' ? 2 : 1);
    expect(readSession(session.surfaceId).recentRuns.filter(run => run.spawnState === 'started')).toHaveLength(boundary === 'bridge' ? 2 : 1);
  }, 30_000);
  it.each([1, 2, 3])('refuses a terminal action fence at validation %s before spawning', async failAt => {
    const { withOwnedActionFence } = await import('@/lib/runtimes/shared/owned-session/action-fence');
    const repoPath = join(root, `repo-terminal-fence-${failAt}`);
    mkdirSync(repoPath);
    execFileSync('git', ['init', '-q', repoPath]);
    const launched = await launchOwnedCodexSession({ cwd: repoPath, prompt: 'initial fixture turn', model: 'gpt-5.6-sol', effort: 'high' });
    await settledSession(launched.surfaceId, 1);
    let checks = 0;
    const attempt = withOwnedActionFence(launched.surfaceId, async session => {
      expect(session?.surfaceId).toBe(launched.surfaceId);
      if (++checks === failAt) throw new Error('reviewed terminal changed');
    }, () => continueOwnedCodexSession(launched.surfaceId, 'must not spawn'));
    const error = await attempt.then(async () => {
      await settledSession(launched.surfaceId, 2);
      return null;
    }, failure => failure as Error);
    expect(error?.message).toBe('reviewed terminal changed');
    expect(checks).toBe(failAt);
    expect(readSession(launched.surfaceId).recentRuns).toHaveLength(1);
    expect(readFileSync(join(repoPath, 'argv-receipts.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it.each([
    ['warm-high', 'gpt-5.6-sol', 'high', false],
    ['warm-max', 'gpt-5.6-terra', 'max', false],
    ['archived-ultra', 'gpt-5.6-terra', 'ultra', true],
  ] as const)('preserves %s effort on %s resume', async (kind, model, effort, archived) => {
    const repoPath = join(root, `repo-${kind}`);
    mkdirSync(repoPath);
    execFileSync('git', ['init', '-q', repoPath]);

    const launched = await launchOwnedCodexSession({
      cwd: repoPath, prompt: 'initial fixture turn', model, effort,
    });
    expect(launched.ok).toBe(true);
    const original = await settledSession(launched.surfaceId, 1);
    expect(original).toMatchObject({ model, effort });
    if (archived) {
      expect((await archiveOwnedCodexSession(launched.surfaceId)).archived).toBe(true);
    }

    // The caller supplies only the session address and prompt. Pins must be
    // loaded from disk, including after the archived directory is restored.
    const { withOwnedActionFence } = await import('@/lib/runtimes/shared/owned-session/action-fence');
    const resume = () => continueOwnedCodexSession(launched.surfaceId, 'follow-up fixture turn');
    const resumed = archived ? await resume() : await withOwnedActionFence(launched.surfaceId, async session => {
      expect(session?.surfaceId).toBe(launched.surfaceId);
      expect(session?.threadId).toBe(original.threadId);
    }, resume);
    expect(resumed.ok).toBe(true);
    const saved = await settledSession(launched.surfaceId, 2);
    expect(saved).toMatchObject({ model: original.model, effort: original.effort, threadId: original.threadId });
    expect(saved.runtimeConfig).toEqual(original.runtimeConfig);
    expect(saved.identity).toEqual(original.identity);
    expect(new Set(saved.recentRuns.map((run) => run.mode))).toEqual(new Set(['launch', 'resume']));

    const receipts = readFileSync(join(repoPath, 'argv-receipts.jsonl'), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; model: string; effort: string; threadId: string; cwd: string });
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({
        model, effort: `model_reasoning_effort=${effort}`, threadId: original.threadId, cwd: realpathSync(repoPath),
      });
      expect(receipt.args).toContain('--ignore-user-config');
      expect(receipt.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    }
    expect(receipts[1].args.slice(0, 3)).toEqual(['exec', 'resume', original.threadId]);
    expect(receipts[1].args.at(-1)).toBe('follow-up fixture turn');
    expect(receipts[1].args).not.toContain('-s');
  }, 20_000);
});
