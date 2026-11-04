import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

// The provider is offline. Session storage, credential isolation, argv, stdin,
// subprocess ownership, parsing, runtime actions and archive restoration are real.
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({
  ensureDispatchBackendReady: vi.fn(async () => ({ ready: true })),
}));
vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: vi.fn(async () => ({ agents: [] })),
}));
vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

const root = realpathSync(mkdtempSync(join(getDataDir(), 'claude-continuation-')));
const sessionsRoot = join(root, 'sessions');
const binary = join(root, 'claude-fixture.mjs');
const threadId = '671d7c73-b85f-4489-90ec-05d95af4776a';
const ownedSurfaceIds = new Set<string>();
vi.stubEnv('CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT', sessionsRoot);
vi.stubEnv('O8_CLAUDE_CODE_BIN', binary);
vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '1');
vi.stubEnv('O8_WORKER_SANDBOX', 'off');
vi.stubEnv('ANTHROPIC_API_KEY', '');
vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'synthetic-continuation-fixture');

writeFileSync(binary, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('claude-fixture 1.0.0');
} else {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const prompt = JSON.parse(raw).message.content;
  const resumeIndex = args.indexOf('--resume');
  const sessionId = resumeIndex < 0 ? '${threadId}' : args[resumeIndex + 1];
  const statePath = join(process.env.CLAUDE_CONFIG_DIR, sessionId + '.fixture.json');
  const missing = resumeIndex >= 0 && !existsSync(statePath);
  const prior = missing || resumeIndex < 0 ? [] : JSON.parse(readFileSync(statePath, 'utf8'));
  const history = [...prior, prompt];
  appendFileSync(join(process.cwd(), 'argv-receipts.jsonl'), JSON.stringify({
    args, prompt, sessionId, history, configDir: process.env.CLAUDE_CONFIG_DIR,
    cwd: process.cwd(), credential: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  }) + '\\n');
  if (prompt === 'hold') {
    setInterval(() => {}, 1000);
  } else if (prompt === 'external-signal') {
    process.kill(process.pid, 'SIGINT');
  } else {
    if (!missing) writeFileSync(statePath, JSON.stringify(history));
    console.log(JSON.stringify({ type: 'result', subtype: missing ? 'error_during_execution' : 'success',
      session_id: sessionId, is_error: missing, result: missing ? 'Saved conversation not found' : JSON.stringify(history) }));
    if (missing) process.exitCode = 1;
  }
}
`);
chmodSync(binary, 0o700);

const {
  launchOwnedClaudeCodeSession, archiveOwnedClaudeCodeSession, getOwnedClaudeCodeRuntimeTail,
  getOwnedClaudeCodeFleetAdditions,
} = await import('@/lib/claude-code/owned');
const { claudeCodeRuntime } = await import('@/lib/runtimes/claude-code');
const { performRuntimeAction } = await import('@/lib/runtime/actions');

function sessionPath(surfaceId: string) {
  return join(sessionsRoot, surfaceId.slice('claude-code-owned:'.length), 'session.json');
}
function readSession(surfaceId: string): OwnedSessionRecord {
  return JSON.parse(readFileSync(sessionPath(surfaceId), 'utf8'));
}
function receipts(repoPath: string): Array<{
  args: string[]; prompt: string; sessionId: string; history: string[];
  configDir: string; cwd: string; credential: string;
}> {
  try {
    return readFileSync(join(repoPath, 'argv-receipts.jsonl'), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line));
  } catch { return []; }
}
async function settled(surfaceId: string, count: number, outcome = 'finished') {
  await vi.waitFor(async () => {
    await getOwnedClaudeCodeRuntimeTail(surfaceId);
    const session = readSession(surfaceId);
    expect(session.activeRun).toBeUndefined();
    expect(session.recentRuns).toHaveLength(count);
    expect(session.recentRuns[0].outcome).toBe(outcome);
    expect(session.recentRuns[0].childExit).toBeDefined();
  }, { timeout: 10_000, interval: 50 });
  return readSession(surfaceId);
}
async function launch(label: string) {
  const repoPath = join(root, label);
  mkdirSync(repoPath);
  execFileSync('git', ['init', '-q', repoPath]);
  const result = await launchOwnedClaudeCodeSession({
    cwd: repoPath, prompt: 'inspect resume pins', claudeCodeCarrier: 'native',
    claudeCodeModel: 'claude-opus-5', effort: 'high',
  });
  if (result.ok) ownedSurfaceIds.add(result.surfaceId);
  expect(result, result.note).toMatchObject({ ok: true });
  await settled(result.surfaceId, 1);
  return { repoPath, surfaceId: result.surfaceId };
}

afterAll(async () => {
  try {
    // A failed assertion must not leave a fixture process alive or erase its
    // ownership record before Stop can verify it.
    for (const surfaceId of ownedSurfaceIds) {
      await getOwnedClaudeCodeRuntimeTail(surfaceId);
      if (readSession(surfaceId).activeRun) {
        expect(await performRuntimeAction({ action: 'stop', surfaceId }))
          .toMatchObject({ ok: true, status: 'completed' });
      }
    }
    rmSync(root, { recursive: true, force: true });
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

describe.skipIf(process.platform === 'win32')('owned Claude continuation through persisted runtime state', () => {
  it.each(['warm', 'archived'] as const)('continues the exact %s conversation with its pins', async (kind) => {
    const { repoPath, surfaceId } = await launch(kind);
    const original = readSession(surfaceId);
    expect(original.threadId).toBe(threadId);
    if (kind === 'archived') expect((await archiveOwnedClaudeCodeSession(surfaceId)).archived).toBe(true);

    expect(claudeCodeRuntime.capabilities.resume).toBe(true);
    expect(await claudeCodeRuntime.resume(surfaceId, 'verify the same session')).toMatchObject({ ok: true, sessionKey: surfaceId });
    await settled(surfaceId, 2);
    // Inventory can omit a completed/archived worker. The public action must
    // still resolve only this owned address, without selecting another session.
    expect(await performRuntimeAction({ action: 'steer', surfaceId, message: 'one final check' }))
      .toMatchObject({ ok: true, status: 'queued', sessionKey: surfaceId });
    const saved = await settled(surfaceId, 3);
    expect(saved).toMatchObject({ model: original.model, effort: original.effort, threadId });
    expect(saved.identity).toEqual(original.identity);
    expect(saved.runtimeConfig).toEqual(original.runtimeConfig);
    const calls = receipts(repoPath);
    expect(calls).toHaveLength(3);
    expect(calls[2].history).toEqual(['inspect resume pins', 'verify the same session', 'one final check']);
    for (const call of calls) {
      expect(call.cwd).toBe(realpathSync(repoPath));
      expect(call.configDir).toBe(calls[0].configDir);
      expect(call.credential).toBe('synthetic-continuation-fixture');
      expect(call.args).toContain('--disable-slash-commands');
      expect(call.args[call.args.indexOf('--model') + 1]).toBe('claude-opus-5');
      expect(call.args[call.args.indexOf('--effort') + 1]).toBe('high');
      expect(call.args[call.args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
      expect(call.args).not.toContain('--continue');
    }
    expect(calls[0].args).not.toContain('--resume');
    expect(calls.slice(1).every((call) => call.args[call.args.indexOf('--resume') + 1] === threadId)).toBe(true);
    const tail = await getOwnedClaudeCodeRuntimeTail(surfaceId);
    expect(tail?.surface.capabilities.sendInput).toBe(true);
    expect(tail?.surface.lifecycle?.lastRunMode).toBe('resume');
  }, 30_000);

  it('rejects discovered, missing and invalid identities without starting a process', async () => {
    expect(await claudeCodeRuntime.resume(`claude-code:${threadId}`, 'continue'))
      .toMatchObject({ ok: false, note: expect.stringContaining('Only owned') });
    expect(await claudeCodeRuntime.resume('claude-code-owned:missing', 'continue'))
      .toMatchObject({ ok: false, note: expect.stringContaining('not found') });
    const { repoPath, surfaceId } = await launch('invalid');
    const original = readSession(surfaceId);
    // A missing thread can now continue from the saved task and transcript.
    // Without the saved session itself, this owned target cannot be resolved.
    const metadata = sessionPath(surfaceId);
    renameSync(metadata, `${metadata}.unavailable`);
    try {
      expect(await claudeCodeRuntime.resume(surfaceId, 'no saved session'))
        .toMatchObject({ ok: false, note: expect.stringContaining('not found') });
    } finally {
      renameSync(`${metadata}.unavailable`, metadata);
    }
    for (const id of ['--continue', 'last-session', '../another.jsonl']) {
      writeFileSync(sessionPath(surfaceId), JSON.stringify({ ...original, threadId: id }));
      expect(await claudeCodeRuntime.resume(surfaceId, 'must not launch'))
        .toMatchObject({ ok: false, note: expect.stringContaining('invalid') });
    }
    expect(receipts(repoPath)).toHaveLength(1);
  });

  it('reports a missing provider transcript as failed without falling back to a fresh conversation', async () => {
    const { repoPath, surfaceId } = await launch('missing-transcript');
    const saved = readSession(surfaceId);
    const absentId = '8382bafc-08bc-4c13-9d90-cc0701f6d26e';
    writeFileSync(sessionPath(surfaceId), JSON.stringify({ ...saved, threadId: absentId }));
    expect(await claudeCodeRuntime.resume(surfaceId, 'no fallback')).toMatchObject({ ok: true });
    const failed = await settled(surfaceId, 2, 'failed');
    expect(failed.threadId).toBe(absentId);
    expect(failed.recentRuns[0].childExit?.code).toBe(1);
    expect(receipts(repoPath)).toHaveLength(2);
    expect(receipts(repoPath)[1].args).toContain('--resume');
  });

  it('refuses overlapping input and verifies that Stop kills the owned process', async () => {
    const { repoPath, surfaceId } = await launch('active');
    expect(await claudeCodeRuntime.resume(surfaceId, 'hold')).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(receipts(repoPath)).toHaveLength(2), { timeout: 10_000 });
    const activePid = readSession(surfaceId).activeRun?.pid;
    try {
      expect(await claudeCodeRuntime.resume(surfaceId, 'must not overlap'))
        .toMatchObject({ ok: false, note: expect.stringContaining('active run') });
      expect(receipts(repoPath)).toHaveLength(2);
    } finally {
      const stop = performRuntimeAction({ action: 'stop', surfaceId });
      await Promise.all([getOwnedClaudeCodeRuntimeTail(surfaceId), getOwnedClaudeCodeFleetAdditions({ fresh: true })]);
      expect(await stop).toMatchObject({ ok: true, status: 'completed', aborted: true });
    }
    const stopped = await settled(surfaceId, 2, 'interrupted');
    expect(stopped.recentRuns[0].interruptRequestedAt).toEqual(expect.any(String));
    expect(stopped.recentRuns[1].outcome).toBe('finished');
    expect(stopped.recentRuns[0].childExit?.signal).toBe('SIGINT');
    expect((await getOwnedClaudeCodeRuntimeTail(surfaceId))?.surface.lifecycle?.lastOutcome).toBe('interrupted');
    expect(() => process.kill(activePid!, 0)).toThrow();
    expect(receipts(repoPath)).toHaveLength(2);
  }, 20_000);

  it('keeps an unrequested signal exit failed instead of treating all signals as Stop', async () => {
    const { surfaceId } = await launch('external-signal');
    expect(await claudeCodeRuntime.resume(surfaceId, 'external-signal')).toMatchObject({ ok: true });
    const failed = await settled(surfaceId, 2, 'failed');
    expect(failed.recentRuns[0].childExit?.signal).toBe('SIGINT');
    expect(failed.recentRuns[0].interruptRequestedAt).toBeUndefined();
  });
});
