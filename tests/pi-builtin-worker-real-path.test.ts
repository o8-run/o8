/**
 * #3258: bundled Pi as a packet worker, through the real dispatch path.
 *
 * The real `/api/orchestrator/delegate` route synthesizes the packet, opens the
 * lane, provisions the managed worktree and launches the `pi-builtin` runtime.
 * Pi runs as its real SDK worker process with a scripted model behind the
 * managed transport seam (no network, no spend). It writes and commits in its
 * lane worktree under lane rules (no inbox approval, command policy still
 * applied), the lane requests review, the review is submitted, the merge
 * preview passes and the reviewed commit merges.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildPiWriteHelper } from './helpers/pi-write-helper';

// The model seam: the managed transport factory is the only route a Pi worker
// has to a model. The scripted stand-in records the model it was built for.
const model = vi.hoisted(() => ({
  managedModels: [] as string[],
  openRouterModels: [] as string[],
  answers: [] as unknown[],
  seen: [] as Array<{ messages: unknown[]; tools: string[] }>,
  block: null as null | Promise<void>,
}));
vi.mock('@/lib/pi/sdk/transport', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/pi/sdk/transport')>(),
  createManagedPiTransport: (options: { model: { id: string }; observeRawUsage?: (usage: unknown) => void }) => {
    model.managedModels.push(options.model.id);
    return async function* (context: { messages: unknown[] }, signal: AbortSignal) {
      const system = (context.messages as Array<{ role?: string; toolsAdded?: Array<{ name: string }> }>)
        .filter((entry) => entry.role === 'system');
      model.seen.push({ messages: context.messages, tools: system.flatMap((entry) => (entry.toolsAdded ?? []).map((tool) => tool.name)) });
      if (model.block) {
        const gate = model.block;
        model.block = null;
        await Promise.race([gate, new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true });
        })]);
      }
      const answer = model.answers.shift() as AssistantMessage | undefined;
      if (!answer) throw new Error('No scripted answer left');
      yield* events(answer);
      options.observeRawUsage?.({ prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } });
    };
  },
}));

// #3584: an OpenRouter pin builds the OpenRouter transport instead. The scripted
// stand-in shares the answer queue and reports one provider receipt per call.
vi.mock('@/lib/pi/sdk/openrouter-transport', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/pi/sdk/openrouter-transport')>(),
  createOpenRouterPiTransport: (options: { model: { id: string }; onReceipt?: (receipt: Record<string, unknown>) => void }) => {
    model.openRouterModels.push(options.model.id);
    return async function* (context: { messages: unknown[] }) {
      model.seen.push({ messages: context.messages, tools: [] });
      const answer = model.answers.shift() as AssistantMessage | undefined;
      if (!answer) throw new Error('No scripted answer left');
      yield* events(answer);
      options.onReceipt?.({ generationId: `gen-${model.openRouterModels.length}-${model.seen.length}`, model: options.model.id,
        status: 'completed', inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, costUsd: 0.0002, reservedUsd: 0.006,
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
    };
  },
}));
vi.mock('@/lib/orchestrator/openrouter-model-metadata', () => ({
  getOpenRouterModelMetadata: async () => new Map([['openrouter/deepseek/deepseek-v4.1-flash',
    { rank: 0, label: 'DeepSeek V4.1 Flash', compatible: true, contextLength: 64_000, inputPricePerMillion: 0.3, outputPricePerMillion: 1.2 }]]),
}));
vi.mock('@/lib/cortex/qa/llm/byok-keys', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/cortex/qa/llm/byok-keys')>(),
  resolveOpenRouterKey: async () => 'fixture-openrouter-key',
}));

// Records each lane-rules answer, and can hold Pi's startup, without changing either.
const seams = vi.hoisted(() => ({
  laneAnswers: [] as Array<{ laneId: string; name: string; allowed: boolean }>,
  startGate: null as null | Promise<void>,
  startReached: null as null | (() => void),
  started: null as null | { running: boolean },
}));
vi.mock('@/lib/pi/sdk/lane-approval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pi/sdk/lane-approval')>();
  return { ...actual, createPiLaneApproval: (root: string, laneId: string) => {
    const approve = actual.createPiLaneApproval(root, laneId);
    return async (call: Parameters<typeof approve>[0], signal: AbortSignal) => {
      const allowed = await approve(call, signal);
      seams.laneAnswers.push({ laneId, name: call.name, allowed });
      return allowed;
    };
  } };
});
vi.mock('@/lib/pi/sdk/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pi/sdk/session')>();
  return { ...actual, createPiSdkSession: async (options: Parameters<typeof actual.createPiSdkSession>[0]) => {
    const gate = seams.startGate;
    if (gate) {
      seams.startGate = null;
      seams.startReached?.();
      await gate;
    }
    return (seams.started = await actual.createPiSdkSession(options));
  } };
});
// Makes command confinement unavailable, as on a kernel without Landlock.
const confinement = vi.hoisted(() => ({ unavailable: false }));
vi.mock('@/lib/sandbox/confine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sandbox/confine')>();
  return { ...actual, confinementArgs: async (...args: Parameters<typeof actual.confinementArgs>) => {
    if (confinement.unavailable) throw new actual.ConfinementUnavailable();
    return actual.confinementArgs(...args);
  } };
});
vi.mock('@/lib/push/notify', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/push/notify')>(),
  notifyApprovalCreated: vi.fn(),
}));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  assertRuntimeDispatchable: vi.fn(async () => undefined),
  getDispatchableRuntimeAvailability: vi.fn(async () => [{ id: 'pi-builtin', available: true }]),
}));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({
  ensureDispatchBackendReady: vi.fn(async () => ({
    ready: true, reason: 'test', waitedMs: 0, attempts: 1,
    lastCheck: { ready: true, reason: 'test', apiBase: 'http://127.0.0.1:1', portSource: 'default', apiPortFilePresent: false },
  })),
}));
vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const, probePath: '/', availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null,
  })),
}));
vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => undefined),
  requestRealtimeRefresh: vi.fn(async () => undefined),
}));

function message(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return { role: 'assistant', content, stopReason, model: 'openai/gpt-6-luna', api: 'openai-completions',
    provider: 'o8-managed', timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function events(answer: AssistantMessage): AssistantMessageEvent[] {
  return [{ type: 'start', partial: answer },
    ...(answer.content[0]?.type === 'text' ? [{ type: 'text_delta' as const, contentIndex: 0, delta: answer.content[0].text, partial: answer }] : []),
    { type: 'done', reason: answer.stopReason as 'stop' | 'toolUse', message: answer }];
}
function call(id: string, name: string, args: Record<string, string>): AssistantMessage {
  return message([{ type: 'toolCall', id, name, arguments: args }], 'toolUse');
}

const root = realpathSync(mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'pi-builtin-worker-')));
const priorEnv = new Map<string, string | undefined>();
const envKeys = ['O8_OWNED_PI_BUILTIN_ROOT', 'O8_CRASH_SURVIVABLE_WORKERS', 'O8_PACKAGED_APP',
  'O8_APFS_DEPENDENCY_IMAGES', 'O8_SKIP_PRELAUNCH_TYPECHECK', 'O8_API_PORT', 'O8_WS_PORT'] as const;
for (const key of envKeys) priorEnv.set(key, process.env[key]);
process.env.O8_OWNED_PI_BUILTIN_ROOT = join(root, 'owned-pi-builtin');
process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
process.env.O8_PACKAGED_APP = '0';
process.env.O8_APFS_DEPENDENCY_IMAGES = '0';
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

// Stands in for the ws-server, so the supervisor completion push is observed
// here and never reaches another o8 on this machine.
const pushes: Array<{ url?: string; authorization?: string; body: string }> = [];
const host: Server = createServer((req, res) => {
  // #3666: the operator command reads packet transcripts through the real route.
  if (req.method === 'GET' && req.url?.startsWith('/api/orchestrator/packet-transcript')) {
    void import('@/app/api/orchestrator/packet-transcript/route').then(async ({ GET }) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
      const response = await GET(new NextRequest(`http://127.0.0.1${req.url}`, { headers }));
      res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(await response.text());
    });
    return;
  }
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    pushes.push({ url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  });
});
await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
process.env.O8_API_PORT = process.env.O8_WS_PORT = String((host.address() as AddressInfo).port);

const { dispatch } = await import('@/lib/lane/commands');
const { getLane, getLaneEvents } = await import('@/lib/lane/registry');
const { POST: delegatePost } = await import('@/app/api/orchestrator/delegate/route');
const { approveAndMergePacket, submitPacketReview } = await import('@/lib/orchestrator/operator-mission-service');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { previewPacketMerge } = await import('@/lib/lane/preview-merge');
const { addRepo, updateRepo } = await import('@/lib/repos/registry');
const { listApprovals } = await import('@/lib/approvals/store');
const { resolveApproval } = await import('@/lib/approvals/resolution');
const { hasCurrentCleanWorkerExit } = await import('@/lib/lane/worker-session-state');
const { createPiLaneApproval } = await import('@/lib/pi/sdk/lane-approval');
const { getRuntime } = await import('@/lib/runtimes');
const capabilities = await import('@/lib/orchestrator/runtime-capabilities');
const { archiveOwnedPiBuiltinSession, getOwnedPiBuiltinReviewPacket } = await import('@/lib/pi-builtin/owned');
const { handleTranscript } = await import('@/lib/mcp/operator-handlers/status');
const { setApiBase } = await import('@/lib/mcp/operator-handlers/shared');
const { getOrCreateWsToken, WS_TOKEN_PATH } = await import('@/lib/ws-auth');
const { setLaneStatus } = await import('@/lib/lane/registry');
const { withPiExclusive } = await import('@/lib/pi/sdk/command');
const { refreshPolicyRules } = await import('@/lib/approvals/policies');
const { getDataDir } = await import('@/lib/data-dir-migration');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function makeRepo(name: string, isolation?: 'git-worktree') {
  const origin = join(root, `${name}.git`);
  const repoPath = join(root, name);
  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repoPath], { stdio: 'pipe' });
  git(repoPath, ['checkout', '-b', 'main']);
  git(repoPath, ['config', 'user.name', 'o8-test']);
  git(repoPath, ['config', 'user.email', 'o8@example.test']);
  git(repoPath, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repoPath, 'base.txt'), 'base\n');
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '-m', 'base']);
  git(repoPath, ['push', '-u', 'origin', 'main']);
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const entry = await addRepo(realpathSync.native(repoPath));
  if (isolation) await updateRepo(entry.id, { setup: { ...entry.setup, workspaceIsolationPreference: isolation } });
  return { repoPath, baseSha: git(repoPath, ['rev-parse', 'main']) };
}

async function waitFor<T>(read: () => T | null | Promise<T | null>, label: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function lastRunOutcome(sessionKey: string, outcome: string) {
  return waitFor(async () => {
    const packet = await getOwnedPiBuiltinReviewPacket(sessionKey);
    return packet.lastRun?.outcome === outcome ? packet : null;
  }, `Pi run outcome ${outcome}`);
}

/** Dispatches one packet to bundled Pi through the real delegate route and waits for its bound lane. */
async function delegate(repoPath: string, prompt: string, extra: Record<string, unknown> = {}) {
  const response = await delegatePost(new NextRequest('http://127.0.0.1/api/orchestrator/delegate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientMutationId: `pi-builtin-${randomUUID()}`, prompt, taskName: prompt.slice(0, 40),
      repoPath, runtime: 'pi-builtin', ...extra }),
  }));
  const delegated = await response.json() as { ok: boolean; laneId: string; packetId: string; error?: string };
  expect({ status: response.status, ok: delegated.ok, error: delegated.error }).toMatchObject({ status: 200, ok: true });
  const lane = await waitFor(() => {
    const current = getLane(delegated.laneId);
    return current?.worktreePath && current.sessionKey ? current : null;
  }, 'lane worktree and session');
  return { ...delegated, workspacePath: lane.worktreePath!, sessionKey: lane.sessionKey! };
}

/** The tool calls in a session's transcript, in order. */
async function toolCalls(sessionKey: string) {
  return (await getRuntime('pi-builtin')!.readTranscript(sessionKey)).flatMap((entry) => entry.toolCalls ?? []);
}

beforeAll(() => { buildPiWriteHelper(); }, 600_000);
beforeEach(async () => {
  await updateOperatorDefaults({
    workerRuntimes: ['pi-builtin'], defaultDispatchRuntime: 'pi-builtin', defaultDispatchModel: '',
  });
});

afterAll(async () => {
  const { closeDb } = await import('@/lib/db');
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
  closeDb();
  await new Promise((resolve) => host.close(resolve));
  vi.restoreAllMocks();
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('bundled Pi worker (#3258)', () => {
  it('is a dispatchable catalog runtime, distinct from the external Pi CLI, and not the default', () => {
    expect(capabilities.listDispatchableRuntimes()).toEqual(expect.arrayContaining(['pi', 'pi-builtin']));
    expect(capabilities.getRuntimeCapability('pi-builtin')).toMatchObject({ label: 'Pi (built-in)', dispatchable: true });
    expect(capabilities.runtimeFromSessionKeyId('pi-builtin-owned:x')).toBe('pi-builtin');
    expect(capabilities.runtimeFromOwnedSessionKey('pi-builtin-owned:x')).toBe('pi-builtin');
    expect(capabilities.runtimeFromOwnedSessionKey('pi-owned:x')).toBe('pi');
    expect(getRuntime('pi-builtin')?.capabilities).toMatchObject({
      launch: true, resume: true, interrupt: true, readTranscript: true, reviewDiffs: true,
      costTelemetry: false, streaming: false,
    });
    expect(capabilities.ORCHESTRATOR_RUNTIME_IDS[0]).not.toBe('pi-builtin');
  });

  it('runs a delegated packet in its lane worktree on the managed route and lands it through review and merge', async () => {
    const target = await makeRepo('target');
    const featureFile = 'pi-feature.txt';
    model.answers.push(
      call('w1', 'write_file', { path: featureFile, content: 'written by pi\n' }),
      // A blocked command is refused by policy before lane rules are asked.
      call('b1', 'run_command', { command: 'eval "touch blocked.txt"' }),
      // A lane command runs confined, without inbox approval; o8, not the worker, commits.
      call('c1', 'run_command', { command: `cat ${featureFile}` }),
      message([{ type: 'text', text: 'Wrote the feature file.' }]),
    );

    const response = await delegatePost(new NextRequest('http://127.0.0.1/api/orchestrator/delegate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientMutationId: `pi-builtin-3258-${Date.now()}`,
        prompt: 'Add pi-feature.txt.',
        taskName: 'pi builtin worker 3258',
        repoPath: target.repoPath,
        runtime: 'pi-builtin',
      }),
    }));
    const delegated = await response.json() as { ok: boolean; laneId: string; packetId: string; error?: string };
    expect(response.status).toBe(200);
    expect({ ok: delegated.ok, error: delegated.error }).toMatchObject({ ok: true });
    const { laneId, packetId } = delegated;

    const lane = await waitFor(() => {
      const current = getLane(laneId);
      return current?.worktreePath && current.sessionKey ? current : null;
    }, 'lane worktree and session');
    const workspacePath = lane.worktreePath!;
    const sessionKey = lane.sessionKey!;
    expect(lane.runtime).toBe('pi-builtin');
    expect(sessionKey).toMatch(/^pi-builtin-owned:/);
    expect(realpathSync(workspacePath)).not.toBe(realpathSync(target.repoPath));

    const packet = await lastRunOutcome(sessionKey, 'finished');
    expect(packet.summary).toBe('Wrote the feature file.');
    // Only the managed transport, for the managed model, ever served this worker.
    expect(new Set(model.managedModels)).toEqual(new Set(['openai/gpt-6-luna']));
    expect(model.seen[0].tools).toEqual(['read_file', 'write_file', 'run_command']);
    // Each managed call is recorded with its tokens, at no per-call charge to the operator (#3742).
    const { getDb } = await import('@/lib/db');
    const { usageLogs } = await import('@/lib/db/schema');
    const usage = getDb()!.select().from(usageLogs).all().filter((row) => row.agentName === 'pi-builtin' && row.laneId === laneId);
    expect(usage.length).toBeGreaterThan(0);
    expect(usage[0]).toMatchObject({ role: 'worker', provider: 'runtime', model: 'openai/gpt-6-luna', inputTokens: 120,
      outputTokens: 30, cacheReadTokens: 20, costUsd: 0, packetId });
    expect(JSON.parse(usage[0].metadataJson!)).toMatchObject({ payer: 'o8-managed', status: 'completed', usageReported: true });

    // The work happened in the lane worktree and nowhere else, with no inbox approval, and is not committed yet.
    expect(git(workspacePath, ['rev-parse', 'HEAD'])).toBe(target.baseSha);
    expect(git(workspacePath, ['status', '--porcelain'])).toBe(`?? ${featureFile}`);
    expect(existsSync(join(workspacePath, 'blocked.txt'))).toBe(false);
    expect(existsSync(join(target.repoPath, featureFile))).toBe(false);
    expect(listApprovals({ status: 'all' }).filter((approval) => approval.runtime === 'pi')).toEqual([]);

    // Truthful runtime surfaces: transcript, discovery, changed-file review, completion receipt.
    const runtime = getRuntime('pi-builtin')!;
    const transcript = await runtime.readTranscript(sessionKey);
    expect(transcript.find((entry) => entry.role === 'user')?.text).toContain('Add pi-feature.txt.');
    const tools = transcript.flatMap((entry) => entry.toolCalls ?? []);
    expect(tools.map((tool) => [tool.name, tool.status])).toEqual([
      ['write_file', 'done'], ['run_command', 'done'], ['run_command', 'done']]);
    expect(tools[1].preview).toMatch(/^Failed: /);
    expect(tools[2].preview).toContain('Exit code 0');
    expect(transcript.filter((entry) => entry.role === 'assistant').at(-1)?.text).toBe('Wrote the feature file.');
    expect(await runtime.discoverSessions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionKey, runtimeId: 'pi-builtin', ownership: 'owned', status: 'reviewing' }),
    ]));
    const exit = getLaneEvents(laneId, 200).findLast((event) => event.verb === 'runtime_process_exit');
    expect(exit?.payload).toMatchObject({ runtime: 'pi-builtin', surfaceId: sessionKey, classification: 'clean-exit', runtimeOutcome: 'finished' });
    expect(await hasCurrentCleanWorkerExit(getLane(laneId)!)).toBe(true);
    const completion = await waitFor(() => pushes.find((push) => push.url === '/supervisor/completed') ?? null, 'completion push');
    expect(completion.authorization).toBe(`Bearer ${getOrCreateWsToken()}`);
    expect(JSON.parse(completion.body)).toEqual({ surfaceId: sessionKey, runId: exit?.payload.runId });

    const reviewRequested = await dispatch({ verb: 'request_review', laneId, actor: 'system' });
    expect(reviewRequested.ok).toBe(true);
    expect(getLane(laneId)?.status).toBe('reviewing');
    // o8 committed the work when it went to review.
    const reviewedHeadSha = git(workspacePath, ['rev-parse', 'HEAD']);
    expect(git(workspacePath, ['rev-parse', 'HEAD^'])).toBe(target.baseSha);
    expect(git(workspacePath, ['show', '--name-only', '--format=', 'HEAD'])).toBe(featureFile);
    expect(git(workspacePath, ['status', '--porcelain'])).toBe('');
    await submitPacketReview({ packetId, approved: true, findings: [], reviewedHeadSha });
    const preview = await previewPacketMerge(packetId);
    expect({ wouldMerge: preview.wouldMerge, blockers: preview.blockers }).toEqual({ wouldMerge: true, blockers: [] });

    const merged = await approveAndMergePacket({ packetId, expectedHeadSha: reviewedHeadSha, actor: 'user' });
    expect({ merged: merged.merged, note: merged.note }).toMatchObject({ merged: true });
    expect(git(target.repoPath, ['ls-tree', '-r', '--name-only', 'main'])).toContain(featureFile);

    // Lane rules end with the lane: a merged lane's worktree gets no further writes or commands.
    const approve = createPiLaneApproval(realpathSync(workspacePath), laneId);
    expect(await approve({ name: 'run_command', args: { command: 'true' } }, new AbortController().signal)).toBe(false);
  }, 240_000);

  it('reads a dispatched packet\'s transcript through the operator command, before and after archive (#3666)', async () => {
    const target = await makeRepo('transcript');
    model.answers.push(
      call('t1', 'write_file', { path: 'notes.md', content: 'pi transcript\n' }),
      call('t2', 'run_command', { command: 'cat notes.md' }),
      message([{ type: 'text', text: 'Wrote notes.md.' }]),
    );
    const worker = await delegate(target.repoPath, 'Add notes.md.');
    await lastRunOutcome(worker.sessionKey, 'finished');
    setApiBase(`http://127.0.0.1:${(host.address() as AddressInfo).port}`);
    const read = async () => {
      const result = await handleTranscript({ packetId: worker.packetId });
      expect(result.isError).toBeFalsy();
      return (JSON.parse((result.content[0] as { text: string }).text) as { data: { sessionKey: string;
        events: Array<{ type: string; tool?: string; ok?: boolean; text?: string; summary?: string }> } }).data;
    };
    const live = await read();
    expect(live.sessionKey).toBe(worker.sessionKey);
    const shape = (events: typeof live.events) => events.map((event) => [event.type, event.tool ?? event.text ?? '']);
    expect(shape(live.events)).toEqual([
      ['tool_call', 'write_file'], ['tool_result', 'write_file'],
      ['tool_call', 'run_command'], ['tool_result', 'run_command'],
      ['assistant', 'Wrote notes.md.'], ['done', ''],
    ]);
    expect(live.events[3]).toMatchObject({ ok: true });
    expect(live.events[3].summary).toContain('pi transcript');

    // A merged packet's session is archived; its transcript stays readable.
    expect((await dispatch({ verb: 'request_review', laneId: worker.laneId, actor: 'system' })).ok).toBe(true);
    const reviewedHeadSha = git(worker.workspacePath, ['rev-parse', 'HEAD']);
    await submitPacketReview({ packetId: worker.packetId, approved: true, findings: [], reviewedHeadSha });
    expect((await approveAndMergePacket({ packetId: worker.packetId, expectedHeadSha: reviewedHeadSha, actor: 'user' })).merged).toBe(true);
    await archiveOwnedPiBuiltinSession(worker.sessionKey);
    expect(existsSync(join(process.env.O8_OWNED_PI_BUILTIN_ROOT!, worker.sessionKey.slice('pi-builtin-owned:'.length)))).toBe(false);
    expect(shape((await read()).events)).toEqual(shape(live.events));
  }, 240_000);

  it('runs two packets pinned to an OpenRouter model in separate worktrees, records each call and lands both (#3584)', async () => {
    const target = await makeRepo('openrouter-target');
    const pin = 'openrouter/deepseek/deepseek-v4.1-flash';
    await updateOperatorDefaults({ defaultDispatchModel: pin });
    const managedBefore = model.managedModels.length;
    const workers = [];
    for (const [index, file] of ['left.txt', 'right.txt'].entries()) {
      model.answers.push(call(`or${index}`, 'write_file', { path: file, content: `${file}\n` }),
        message([{ type: 'text', text: `Wrote ${file}.` }]));
      const worker = await delegate(target.repoPath, `Add ${file}.`, { model: pin });
      expect(getLane(worker.laneId)?.runtime).toBe('pi-builtin');
      expect(getLane(worker.laneId)?.model).toBe(pin);
      await lastRunOutcome(worker.sessionKey, 'finished');
      workers.push({ ...worker, file });
    }
    // Only the OpenRouter route served these workers, pinned to the exact model; the managed route never did.
    expect(model.managedModels.length).toBe(managedBefore);
    expect(model.openRouterModels.slice(-2)).toEqual(['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash']);
    expect(workers[0].workspacePath).not.toBe(workers[1].workspacePath);

    const { getDb } = await import('@/lib/db');
    const { usageLogs } = await import('@/lib/db/schema');
    const rows = getDb()!.select().from(usageLogs).all().filter((row) => row.provider === 'openrouter');
    for (const worker of workers) {
      const own = rows.filter((row) => row.packetId === worker.packetId);
      // Two calls per worker (tool call, then answer), each one row with its own generation id.
      expect(own).toHaveLength(2);
      for (const row of own) {
        expect(row).toMatchObject({ model: pin, role: 'worker', laneId: worker.laneId, sessionKey: worker.sessionKey, costUsd: 0.0002 });
        expect(JSON.parse(row.metadataJson!)).toMatchObject({ runtime: 'pi', carrier: 'openrouter', costSource: 'provider_response', status: 'completed' });
      }
      expect(new Set(own.map((row) => JSON.parse(row.metadataJson!).generationId)).size).toBe(2);
      expect(JSON.stringify(own)).not.toContain('fixture-openrouter-key');
    }

    for (const worker of workers) {
      expect(git(worker.workspacePath, ['status', '--porcelain'])).toBe(`?? ${worker.file}`);
      expect((await dispatch({ verb: 'request_review', laneId: worker.laneId, actor: 'system' })).ok).toBe(true);
      const reviewedHeadSha = git(worker.workspacePath, ['rev-parse', 'HEAD']);
      await submitPacketReview({ packetId: worker.packetId, approved: true, findings: [], reviewedHeadSha });
      const merged = await approveAndMergePacket({ packetId: worker.packetId, expectedHeadSha: reviewedHeadSha, actor: 'user' });
      expect({ merged: merged.merged, note: merged.note }).toMatchObject({ merged: true });
    }
    expect(git(target.repoPath, ['ls-tree', '-r', '--name-only', 'main']).split('\n')).toEqual(expect.arrayContaining(['left.txt', 'right.txt']));
  }, 240_000);

  it('fails an OpenRouter pin visibly when the model cannot run Pi, without falling back', async () => {
    const target = await makeRepo('openrouter-refused');
    await updateOperatorDefaults({ defaultDispatchModel: 'openrouter/unknown/no-tools-model' });
    const managedBefore = model.managedModels.length;
    const response = await delegatePost(new NextRequest('http://127.0.0.1/api/orchestrator/delegate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientMutationId: `pi-builtin-${randomUUID()}`, prompt: 'Add nothing.', taskName: 'unusable pin',
        repoPath: target.repoPath, runtime: 'pi-builtin', model: 'openrouter/unknown/no-tools-model' }),
    }));
    // The launch refuses before Pi starts, and the delegate call reports it.
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ ok: false,
      error: 'unknown/no-tools-model cannot run Pi on OpenRouter: Pi needs a text model with tool support.' });
    expect(model.managedModels.length).toBe(managedBefore);
  }, 120_000);

  it('stops a running turn, resumes the same Pi session, and keeps inbox approval outside a lane', async () => {
    const scratch = await makeRepo('scratch');
    let release!: () => void;
    model.block = new Promise<void>((resolve) => { release = resolve; });
    model.answers.push(message([{ type: 'text', text: 'never sent' }]), message([{ type: 'text', text: 'Resumed.' }]));
    const before = model.seen.length;
    const runtime = getRuntime('pi-builtin')!;
    const launched = await runtime.launch({ cwd: scratch.repoPath, prompt: 'Start something long' });
    expect(launched).toMatchObject({ ok: true });
    const sessionKey = launched.sessionKey!;
    await waitFor(() => (model.seen.length > before ? true : null), 'first model call');

    await expect(runtime.interrupt(sessionKey)).resolves.toMatchObject({ ok: true });
    release();
    await lastRunOutcome(sessionKey, 'interrupted');
    expect(await runtime.discoverSessions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionKey, sessionCapabilities: expect.objectContaining({ canSendInput: true, canInterrupt: false }) }),
    ]));

    model.answers.shift();
    await expect(runtime.resume(sessionKey, 'Continue')).resolves.toMatchObject({ ok: true });
    const resumed = await lastRunOutcome(sessionKey, 'finished');
    expect(resumed.summary).toBe('Resumed.');
    // The second process resumed the first turn's Pi session file.
    expect(model.seen.at(-1)!.messages.length).toBeGreaterThan(model.seen[before].messages.length);
    const transcript = await runtime.readTranscript(sessionKey);
    expect(transcript.filter((entry) => entry.role === 'user').map((entry) => entry.text)).toEqual(['Start something long', 'Continue']);

    // Outside a packet lane, a write keeps per-call inbox approval; a rejected one never lands.
    // The approval is filed under its repo's project, so read it across projects as the shared Inbox does.
    model.answers.push(call('w2', 'write_file', { path: 'scratch.txt', content: 'no' }),
      message([{ type: 'text', text: 'The write was not approved.' }]));
    await expect(runtime.resume(sessionKey, 'Write scratch.txt')).resolves.toMatchObject({ ok: true });
    const pending = await waitFor(() => listApprovals({ status: 'pending', projectId: null })
      .find((approval) => approval.runtime === 'pi' && approval.toolName === 'write_file') ?? null, 'inbox approval');
    resolveApproval(pending.id, 'reject', 'desktop', 'Not this one');
    await waitFor(async () => ((await getOwnedPiBuiltinReviewPacket(sessionKey)).summary === 'The write was not approved.' ? true : null),
      'rejected write turn');
    expect(existsSync(join(scratch.repoPath, 'scratch.txt'))).toBe(false);

    // An impossible workspace is refused before any process starts.
    await expect(runtime.launch({ cwd: join(root, 'missing'), prompt: 'x' })).resolves.toMatchObject({ ok: false, sideEffect: 'none' });
  }, 120_000);
  it('refuses an approved write that waited on the host lock while its lane was archived', async () => {
    const repo = await makeRepo('queued');
    let releaseLock!: () => void;
    const holding = withPiExclusive(() => new Promise<void>((resolve) => { releaseLock = resolve; }));
    model.answers.push(call('q1', 'write_file', { path: 'late.txt', content: 'late\n' }),
      message([{ type: 'text', text: 'Tried the write.' }]));
    const { laneId, sessionKey, workspacePath } = await delegate(repo.repoPath, 'Write late.txt');
    // Lane rules allowed the write while the lane was open; it now waits behind the held lock.
    await waitFor(() => seams.laneAnswers.find((answer) => answer.laneId === laneId
      && answer.name === 'write_file' && answer.allowed) ?? null, 'lane approval of the write');
    setLaneStatus(laneId, 'archived', 'system', 'test_archived');
    releaseLock();
    await holding;
    await lastRunOutcome(sessionKey, 'finished');
    expect(existsSync(join(workspacePath, 'late.txt'))).toBe(false);
    expect((await toolCalls(sessionKey))[0]?.preview).toMatch(/^Failed: /);
  }, 120_000);

  it('refuses a command on an archived lane even when an operator rule lifts its approval', async () => {
    const repo = await makeRepo('policy');
    let release!: () => void;
    model.block = new Promise<void>((resolve) => { release = resolve; });
    model.answers.push(call('p1', 'run_command', { command: 'echo ran > after-archive.txt' }),
      message([{ type: 'text', text: 'Tried the command.' }]));
    const { laneId, sessionKey, workspacePath } = await delegate(repo.repoPath, 'Run the command');
    const policyFile = join(getDataDir(), 'policies.json');
    try {
      writeFileSync(policyFile, JSON.stringify([
        { id: 'mutation-shell', requiresApproval: false, workspacePath: realpathSync(workspacePath) }]));
      refreshPolicyRules();
      setLaneStatus(laneId, 'archived', 'system', 'test_archived');
      release();
      await lastRunOutcome(sessionKey, 'finished');
    } finally {
      rmSync(policyFile, { force: true });
      refreshPolicyRules();
    }
    // The rule skipped approval, so only the lane guard could refuse it.
    expect(seams.laneAnswers.filter((answer) => answer.laneId === laneId)).toEqual([]);
    expect(existsSync(join(workspacePath, 'after-archive.txt'))).toBe(false);
    expect((await toolCalls(sessionKey))[0]?.preview).toMatch(/^Failed: /);
  }, 120_000);

  // `auto` is a copy-on-write clone with its own Git directory where the volume
  // supports it (APFS); `git-worktree` is a linked worktree whose `.git` file
  // points into the main repository.
  it.each(['auto', 'git-worktree'] as const)('confines lane commands to the lane worktree and a private temp dir (%s, #3385)', async (isolation) => {
    const repo = await makeRepo(`confined-${isolation}`, isolation === 'auto' ? undefined : isolation);
    const away = realpathSync(mkdtempSync(join(root, 'away-')));
    const tmpTarget = join('/tmp', `o8-3385-${randomUUID()}.txt`);
    const piApprovals = () => listApprovals({ status: 'all' }).filter((approval) => approval.runtime === 'pi').length;
    const approvalsBefore = piApprovals();
    getOrCreateWsToken();
    const macos = process.platform === 'darwin';
    // Each escape must exit non-zero; the effects are checked below.
    const escapes = [
      'touch ../outside-3385.txt',
      `printf x > ${tmpTarget}`,
      `ln -s ${away} escape && printf x > escape/through-link.txt`,
      // No network, loopback included: the o8 API stand-in must never see this.
      `${process.execPath} -e "fetch('http://127.0.0.1:${process.env.O8_API_PORT}/escape-3385').then(() => process.exit(0), () => process.exit(3))"`,
      // o8 commits at review; the lane cannot write Git state, here or in the main repository.
      'git add inside.txt && git commit -m "feat: lane commit"',
      'git update-ref refs/heads/main HEAD',
      'printf x > "$(git rev-parse --git-common-dir)/refs/heads/main"',
      'printf x >> "$(git rev-parse --git-common-dir)/config"',
      // macOS only: Landlock cannot deny `.git` beneath the worktree or deny reads.
      ...(macos ? ['if [ -d .git ]; then touch .git/o8-probe; else printf x >> .git; fi', `wc -c < ${WS_TOKEN_PATH}`] : []),
    ];
    model.answers.push(
      call('i1', 'run_command', { command: 'printf inside > inside.txt && printf t > "$TMPDIR/private.txt" && echo "tmp=$TMPDIR"' }),
      ...escapes.map((command, index) => call(`e${index}`, 'run_command', { command })),
      message([{ type: 'text', text: 'Tried every write.' }]),
    );
    try {
      const { sessionKey, workspacePath } = await delegate(repo.repoPath, 'Try writes inside and outside the lane.');
      const headBefore = git(workspacePath, ['rev-parse', 'HEAD']);
      const gitPointer = isolation === 'git-worktree' ? readFileSync(join(workspacePath, '.git'), 'utf8') : null;
      await lastRunOutcome(sessionKey, 'finished');
      const previews = (await toolCalls(sessionKey)).map((tool) => tool.preview ?? '');
      // Writes inside the worktree and the private temp dir succeed; the temp dir ends with the command.
      expect(previews[0]).toContain('Exit code 0');
      const privateTmp = /tmp=(\S+)/.exec(previews[0])?.[1];
      expect(privateTmp).toBeTruthy();
      expect(existsSync(privateTmp!)).toBe(false);
      expect(readFileSync(join(workspacePath, 'inside.txt'), 'utf8')).toBe('inside');
      // Each escape ran, failed, and changed nothing.
      expect(previews.slice(1).map((preview, index) => [escapes[index], /Exit code [1-9]/.test(preview)]))
        .toEqual(escapes.map((command) => [command, true]));
      expect(existsSync(join(workspacePath, '..', 'outside-3385.txt'))).toBe(false);
      expect(existsSync(tmpTarget)).toBe(false);
      expect(readdirSync(away)).toEqual([]);
      expect(pushes.some((push) => push.url === '/escape-3385')).toBe(false);
      expect(git(workspacePath, ['rev-parse', 'HEAD'])).toBe(headBefore);
      expect(git(repo.repoPath, ['rev-parse', 'main'])).toBe(repo.baseSha);
      expect(readFileSync(join(repo.repoPath, '.git', 'config'), 'utf8')).not.toMatch(/x$/);
      if (gitPointer !== null) {
        expect(git(workspacePath, ['rev-parse', '--git-dir'])).toContain(join(repo.repoPath, '.git', 'worktrees'));
        expect(readFileSync(join(workspacePath, '.git'), 'utf8')).toBe(gitPointer);
      } else {
        expect(existsSync(join(workspacePath, '.git', 'o8-probe'))).toBe(false);
      }
      // Confinement was available, so lane rules needed no inbox approval.
      expect(piApprovals()).toBe(approvalsBefore);
    } finally {
      rmSync(tmpTarget, { force: true });
    }
  }, 120_000);

  it('sends a lane command to inbox approval when confinement is unavailable (#3385)', async () => {
    const repo = await makeRepo('unconfinable');
    confinement.unavailable = true;
    model.answers.push(
      call('u1', 'run_command', { command: 'touch rejected.txt' }),
      call('u2', 'run_command', { command: 'touch approved.txt' }),
      message([{ type: 'text', text: 'Asked twice.' }]),
    );
    try {
      const { sessionKey, workspacePath } = await delegate(repo.repoPath, 'Touch two files.');
      const pendingCommand = (command: string) => waitFor(() => listApprovals({ status: 'pending', projectId: null })
        .find((approval) => approval.runtime === 'pi' && approval.command === command) ?? null, `inbox approval of ${command}`);
      // Nothing ran before the operator answered.
      resolveApproval((await pendingCommand('touch rejected.txt')).id, 'reject', 'desktop', 'No');
      expect(existsSync(join(workspacePath, 'rejected.txt'))).toBe(false);
      resolveApproval((await pendingCommand('touch approved.txt')).id, 'approve', 'desktop');
      await lastRunOutcome(sessionKey, 'finished');
      expect(existsSync(join(workspacePath, 'rejected.txt'))).toBe(false);
      expect(existsSync(join(workspacePath, 'approved.txt'))).toBe(true);
      expect((await toolCalls(sessionKey)).map((tool) => tool.preview?.startsWith('Failed: '))).toEqual([true, false]);
    } finally {
      confinement.unavailable = false;
    }
  }, 120_000);

  /** Starts a laneless launch whose Pi startup is held; resolves once startup is reached. */
  async function launchHeldAtStartup(name: string, prompt: string) {
    const repo = await makeRepo(name);
    let open!: () => void;
    const reached = new Promise<void>((resolve) => { seams.startReached = resolve; });
    seams.startGate = new Promise<void>((resolve) => { open = resolve; });
    const launching = getRuntime('pi-builtin')!.launch({ cwd: repo.repoPath, prompt });
    await reached;
    const ownedRoot = process.env.O8_OWNED_PI_BUILTIN_ROOT!;
    const sessionKey = readdirSync(ownedRoot).map((dir) => JSON.parse(readFileSync(join(ownedRoot, dir, 'session.json'), 'utf8')) as
      { surfaceId: string; latestPrompt: string }).find((session) => session.latestPrompt === prompt)!.surfaceId;
    return { sessionKey, open, launching };
  }

  it('stops a turn whose Pi process is still starting, so the prompt never runs', async () => {
    const before = model.seen.length;
    model.answers.push(message([{ type: 'text', text: 'should not run' }]));
    const { sessionKey, open, launching } = await launchHeldAtStartup('stop-start', 'Stop me while starting');
    const stopping = getRuntime('pi-builtin')!.interrupt(sessionKey);
    open();
    await launching;
    await expect(stopping).resolves.toMatchObject({ ok: true });
    await lastRunOutcome(sessionKey, 'interrupted');
    expect(model.seen.length).toBe(before);
    model.answers.shift();
  }, 120_000);

  it('keeps a starting turn owned when discovery runs during startup', async () => {
    model.answers.push(message([{ type: 'text', text: 'Started fine.' }]));
    const { sessionKey, open, launching } = await launchHeldAtStartup('discover-start', 'Discover me while starting');
    expect(await getRuntime('pi-builtin')!.discoverSessions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionKey, status: 'running' })]));
    open();
    await expect(launching).resolves.toMatchObject({ ok: true });
    const packet = await lastRunOutcome(sessionKey, 'finished');
    expect(packet.summary).toBe('Started fine.');
  }, 120_000);

  it('fails a packet whose Pi start never finishes, and closes a start that finishes late (#3741)', async () => {
    const repo = await makeRepo('start-hang');
    vi.stubEnv('O8_PI_WORKER_START_TIMEOUT_MS', '2000');
    let open!: () => void;
    seams.startGate = new Promise<void>((resolve) => { open = resolve; });
    try {
      const response = await delegatePost(new NextRequest('http://127.0.0.1/api/orchestrator/delegate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientMutationId: `pi-builtin-${randomUUID()}`, prompt: 'Start and hang.', taskName: 'start hang',
          repoPath: repo.repoPath, runtime: 'pi-builtin' }),
      }));
      // The launch settles at the deadline and says why; the lane leaves `launching` with that reason.
      const reason = 'Pi did not start within 2 seconds, so the turn was not run.';
      const body = await response.json() as { ok: boolean; laneId: string; error?: string };
      expect({ status: response.status, ok: body.ok, error: body.error }).toEqual({ status: 422, ok: false, error: reason });
      expect(getLane(body.laneId)?.status).toBe('idle');
      const events = getLaneEvents(body.laneId, 200);
      expect(events.findLast((event) => event.verb === 'status_change')?.payload).toMatchObject({ eventLabel: 'launch_failed', reason });
      const exit = events.find((event) => event.verb === 'runtime_process_exit')!.payload as { surfaceId: string };
      expect((await getOwnedPiBuiltinReviewPacket(exit.surfaceId)).lastRun).toMatchObject({ outcome: 'failed' });
      open();
      await waitFor(() => (seams.started && !seams.started.running ? true : null), 'late Pi start closed');
    } finally {
      open?.();
      vi.unstubAllEnvs();
    }
  }, 120_000);

  it('runs a read-only packet with read_file only', async () => {
    const repo = await makeRepo('read-only');
    const before = model.seen.length;
    model.answers.push(call('r1', 'read_file', { path: 'base.txt' }), message([{ type: 'text', text: 'base.txt says base.' }]));
    const { sessionKey, workspacePath } = await delegate(repo.repoPath, 'Read base.txt and report it.', { readOnly: true });
    const packet = await lastRunOutcome(sessionKey, 'finished');
    expect(packet.summary).toBe('base.txt says base.');
    expect(model.seen[before].tools).toEqual(['read_file']);
    expect((await toolCalls(sessionKey)).map((tool) => [tool.name, tool.preview])).toEqual([['read_file', 'base']]);
    expect(git(workspacePath, ['rev-parse', 'HEAD'])).toBe(repo.baseSha);
  }, 120_000);
});
