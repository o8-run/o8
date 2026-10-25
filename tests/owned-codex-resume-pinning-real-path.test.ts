import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

// The runtime is a finite, offline executable. Keep readiness and supervisor
// notifications outside this test; store, argv, spawn, parser and disk are real.
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({
  ensureDispatchBackendReady: vi.fn(async () => ({ ready: true })),
}));
vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

const root = mkdtempSync(join(getDataDir(), 'codex-resume-pinning-'));
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

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('owned Codex persisted resume pins through a real process', () => {
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
