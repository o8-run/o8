/**
 * #2448 — loop detection from tool-call patterns, record-only and advisory.
 *
 * Real-path doctrine: every case drives the REAL supervisor tick
 * (`supervisorTick` through `runSupervisorTickForTesting`, with the callbacks
 * `startSupervisorLoop` installs). The tick's transcript callback reads the
 * real `/api/runtime/transcript` route, which resolves a registered runtime
 * adapter fixture through `readRuntimeTranscript`. The lane and the inbox are
 * real DB rows, the provider setting comes from the real operator-defaults
 * store, the key from the data-dir key file, and the call goes over HTTP to
 * the local systemone fixture.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRuntime, RuntimeTranscriptEntry } from '@/lib/runtimes/types';
import type { SupervisorCallbacks } from '@/lib/supervisor/agent-supervisor-types';
import { startJudgmentEndpointFixture, type JudgmentEndpointFixture } from './fixtures/judgment-endpoint';

const h = vi.hoisted(() => ({
  transcripts: new Map<string, RuntimeTranscriptEntry[]>(),
  /** Baseline switch: behave as if the tick had no loop hook. */
  withoutHook: false,
}));

vi.mock('@/lib/supervisor/loop-detector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supervisor/loop-detector')>();
  return {
    ...actual,
    startLoopChecks: (...args: Parameters<typeof actual.startLoopChecks>) => (
      h.withoutHook ? undefined : actual.startLoopChecks(...args)
    ),
  };
});

const originalEnv = {
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
};
const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-loop-detector-data-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const { getSqlite } = await import('@/lib/db');
const { createLane } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { judgmentKeyPath } = await import('@/lib/judgment/key');
const { registerRuntime } = await import('@/lib/runtimes/registry');
const { listInboxItems } = await import('@/lib/supervisor/inbox');
const { setLoopDetectorForTests, waitForLoopChecks, buildLoopState } = await import('@/lib/supervisor/loop-detector');
const supervisor = await import('@/lib/supervisor/agent-supervisor');
const transcriptRoute = await import('@/app/api/runtime/transcript/route');
const { runReplay } = await import('../scripts/judgment-replay.mjs');

const KEY = 'ts-fixture-key-loop-detector-2448';
const RUNTIME_ID = 'loopfixture';
const PACKET_TITLE = 'Rewrite the billing reconciler';
const ASSISTANT_TEXT = 'ASSISTANT-2448 I will run the suite again and see whether it passes now.';
const FAILING_COMMAND = 'Run npm test -- src/feature.test.ts';
const FAILING_OUTPUT = 'FAIL src/feature.test.ts\nError: expected 2 to be 1';

let fixture: JudgmentEndpointFixture;
const repoDirs: string[] = [];

function loopReply(p: number) {
  return { status: 200, body: { model: 'jev-1.13.0', answers: { loop: { type: 'noul', noul: p } }, usage: { input_tokens: 412, output_tokens: 4 } } };
}

const at = (second: number) => new Date(Date.UTC(2026, 8, 18, 10, 0, second));

function toolPair(sessionKey: string, n: number, command: string, output: string): RuntimeTranscriptEntry[] {
  return [
    { id: `${sessionKey}:call-${n}`, role: 'tool', toolName: 'exec_command', text: command, timestamp: at(2 * n + 2) },
    { id: `${sessionKey}:out-${n}`, role: 'system', text: output, timestamp: at(2 * n + 3) },
  ];
}

function transcriptFor(sessionKey: string, commands: Array<[string, string]>): RuntimeTranscriptEntry[] {
  return [
    { id: `${sessionKey}:prompt`, role: 'user', text: `Packet: ${PACKET_TITLE}. Make the suite pass.`, timestamp: at(0) },
    { id: `${sessionKey}:narration`, role: 'assistant', text: ASSISTANT_TEXT, timestamp: at(1) },
    ...commands.flatMap(([command, output], n) => toolPair(sessionKey, n, command, output)),
  ];
}

/** A new tool call lands between ticks, as it does in a live loop. */
function appendCall(sessionKey: string, command: string, output: string) {
  const entries = h.transcripts.get(sessionKey)!;
  const n = entries.filter((entry) => entry.role === 'tool').length;
  entries.push(...toolPair(sessionKey, n, command, output));
}

function setupAgent(packetId: string, commands: Array<[string, string]>) {
  const repoPath = mkdtempSync(join(os.tmpdir(), `${packetId}-`));
  repoDirs.push(repoPath);
  const sessionKey = `${RUNTIME_ID}-owned:${packetId}`;
  h.transcripts.set(sessionKey, transcriptFor(sessionKey, commands));
  const lane = createLane({
    repoPath, worktreePath: repoPath, branch: `inline/${packetId}`, baseBranch: 'main',
    runtime: 'codex', label: PACKET_TITLE, packetId, sessionKey,
  });
  supervisor.registerWatchedAgent(sessionKey, repoPath, PACKET_TITLE, `Brief: ${PACKET_TITLE}`);
  return { lane, sessionKey, repoPath };
}

/** The ws-server's transcript callback, reading the real route. */
async function fetchTranscript(sessionKey: string, limit: number) {
  const response = await transcriptRoute.GET(new NextRequest(`http://localhost/api/runtime/transcript?sessionKey=${encodeURIComponent(sessionKey)}&limit=${limit}`));
  const payload = await response.json() as { transcript: Array<{ id: string; role: string; text: string; timestamp?: number; timestampLabel?: string; toolName?: string }> };
  return payload.transcript.map((entry) => ({
    id: entry.id, role: entry.role, text: entry.text, timestamp: entry.timestamp, timestampLabel: entry.timestampLabel, toolName: entry.toolName,
  }));
}

const callbacks: SupervisorCallbacks = {
  fetchFleetStatus: async () => [...h.transcripts.keys()].map((sessionKey) => ({ sessionKey, status: 'running' })),
  fetchTranscript,
  steerAgent: vi.fn(async () => {}),
  interruptAgent: vi.fn(async () => {}),
  relaunchAgent: vi.fn(async () => ({ status: 'held' as const, reason: 'test' })),
  broadcastAgentUpdate: vi.fn(),
  queueOrchestratorEscalation: vi.fn(),
};

/** One real tick with every watched agent due, then the detached checks settled. */
async function tick() {
  for (const agent of supervisor.getWatchedAgents()) agent.nextPollAt = 0;
  await supervisor.runSupervisorTickForTesting();
  await waitForLoopChecks();
}

function laneEvents(laneId: string) {
  return (getSqlite().prepare('SELECT verb, actor, payload_json FROM lane_events WHERE lane_id = ? ORDER BY rowid')
    .all(laneId) as Array<{ verb: string; actor: string; payload_json: string }>)
    .map((row) => ({ verb: row.verb, actor: row.actor, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));
}
const eventsOf = (laneId: string, verb: string) => laneEvents(laneId).filter((event) => event.verb === verb);
const loopItems = (packetId: string) => listInboxItems().filter((item) => item.kind === 'possible_loop' && item.packetId === packetId);

beforeAll(async () => {
  fixture = await startJudgmentEndpointFixture();
  writeFileSync(judgmentKeyPath(), `${KEY}\n`);
  chmodSync(judgmentKeyPath(), 0o600);
  const runtime = {
    id: RUNTIME_ID,
    displayName: 'Loop detector test runtime',
    capabilities: {
      discover: false, readTranscript: true, launch: false, resume: false,
      interrupt: false, reviewDiffs: false, costTelemetry: false, streaming: false,
    },
    discoverSessions: async () => [],
    readTranscript: async (sessionKey: string) => h.transcripts.get(sessionKey) ?? [],
    launch: async () => ({ ok: false, note: 'not supported' }),
    resume: async () => ({ ok: false, note: 'not supported' }),
    interrupt: async () => ({ ok: false, note: 'not supported' }),
    getChangedFiles: async () => [],
  } as unknown as AgentRuntime;
  registerRuntime(runtime);
  supervisor.startSupervisorLoop(callbacks);
  supervisor.stopSupervisorLoop();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

beforeEach(async () => {
  for (const agent of supervisor.getWatchedAgents()) supervisor.unregisterWatchedAgent(agent.surfaceId);
  h.transcripts.clear();
  h.withoutHook = false;
  fixture.reset();
  setLoopDetectorForTests({ transport: { endpoint: fixture.endpoint, timeoutMs: 2_000, maxAttempts: 1 }, minIntervalMs: 0 });
  await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
});

afterAll(async () => {
  for (const agent of supervisor.getWatchedAgents()) supervisor.unregisterWatchedAgent(agent.surfaceId);
  setLoopDetectorForTests(undefined);
  vi.restoreAllMocks();
  await fixture.close();
  for (const dir of repoDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('loop detection on the supervisor tick', () => {
  it('raises one advisory possible_loop on the second positive tick for the same failing command, and not again', async () => {
    const { lane, sessionKey } = setupAgent('pkt-loop', Array.from({ length: 5 }, () => [FAILING_COMMAND, FAILING_OUTPUT] as [string, string]));

    fixture.replies.push(loopReply(0.9));
    await tick();
    expect(fixture.seen).toHaveLength(1);
    expect(eventsOf(lane.id, 'loop_check')).toHaveLength(1);
    expect(eventsOf(lane.id, 'possible_loop')).toHaveLength(0);
    expect(loopItems('pkt-loop')).toHaveLength(0);

    appendCall(sessionKey, FAILING_COMMAND, FAILING_OUTPUT);
    fixture.replies.push(loopReply(0.9));
    await tick();
    expect(fixture.seen).toHaveLength(2);
    expect(eventsOf(lane.id, 'loop_check')).toHaveLength(2);
    const receipts = eventsOf(lane.id, 'judgment').map((event) => event.payload);
    expect(receipts).toHaveLength(2);
    expect(receipts[1]).toMatchObject({ ok: true, surface: 'loop-detector', packetId: 'pkt-loop' });
    const receiptId = receipts[1].receiptId as string;
    expect(receiptId).toBeTruthy();
    const raised = eventsOf(lane.id, 'possible_loop');
    expect(raised).toHaveLength(1);
    expect(raised[0].payload).toMatchObject({
      receiptId, advisory: true, band: 0.6, p: [0.9, 0.9],
      pattern: { toolName: 'exec_command', count: 6, failed: true, resultHead: 'FAIL src/feature.test.ts\nError: expected 2 to be 1' },
    });
    const items = loopItems('pkt-loop');
    expect(items).toHaveLength(1);
    expect(items[0].errorExcerpt).toContain('exec_command');
    expect(items[0].errorExcerpt).toContain('"FAIL src/feature.test.ts Error: expected 2 to be 1"');
    expect(items[0].errorExcerpt).toContain(`receipt ${receiptId}`);
    expect(items[0].errorExcerpt).toContain('Advisory, nothing stopped');

    appendCall(sessionKey, FAILING_COMMAND, FAILING_OUTPUT);
    fixture.replies.push(loopReply(0.9));
    await tick();
    expect(fixture.seen).toHaveLength(3);
    expect(eventsOf(lane.id, 'loop_check')).toHaveLength(3);
    expect(eventsOf(lane.id, 'possible_loop')).toHaveLength(1);
    expect(loopItems('pkt-loop')).toHaveLength(1);
    // Advisory only: nothing was steered or interrupted.
    expect(callbacks.steerAgent).not.toHaveBeenCalled();
    expect(callbacks.interruptAgent).not.toHaveBeenCalled();
  }, 30_000);

  it('records loop_check only for a window of distinct commands', async () => {
    const commands = ['Run ls src', 'Run cat src/a.ts', 'Run npm run lint', 'Run npx tsc --noEmit', 'Run git status'];
    const { lane, sessionKey } = setupAgent('pkt-distinct', commands.map((command) => [command, 'ok'] as [string, string]));
    fixture.replies.push(loopReply(0.1));
    await tick();
    appendCall(sessionKey, 'Run git diff --stat', 'ok');
    fixture.replies.push(loopReply(0.1));
    await tick();
    expect(fixture.seen).toHaveLength(2);
    expect(eventsOf(lane.id, 'loop_check').map((event) => event.payload.p)).toEqual([0.1, 0.1]);
    expect(eventsOf(lane.id, 'loop_check')[0].payload.counts).toEqual({ toolCalls: 5, distinctTools: 1, distinctArgHashes: 5, repeatedArgHashRuns: 0 });
    expect(eventsOf(lane.id, 'possible_loop')).toHaveLength(0);
    expect(loopItems('pkt-distinct')).toHaveLength(0);
  }, 30_000);

  it('sends tool names, argument hashes, and output heads, never assistant text, the prompt, or the packet title', async () => {
    setupAgent('pkt-state', Array.from({ length: 5 }, () => [FAILING_COMMAND, FAILING_OUTPUT] as [string, string]));
    fixture.replies.push(loopReply(0.5));
    await tick();
    expect(fixture.seen).toHaveLength(1);
    const serialized = JSON.stringify(fixture.seen[0].body);
    expect(serialized).not.toContain('ASSISTANT-2448');
    expect(serialized).not.toContain(ASSISTANT_TEXT);
    expect(serialized).not.toContain(PACKET_TITLE);
    expect(serialized).not.toContain('Brief:');
    expect(serialized).not.toContain('npm test --');
    expect(serialized).toContain('exec_command');
    expect(serialized).toContain('FAIL src/feature.test.ts');
    const body = fixture.seen[0].body as { questions: Record<string, { instructions: string }>; state: { window: unknown[] } };
    expect(body.questions.loop.instructions).toBe('Is this agent repeating the same actions without progress?');
    expect(body.state.window).toHaveLength(5);
  }, 30_000);

  it('with the setting off, makes no request and leaves the tick events identical to a tick without the hook', async () => {
    const commands = Array.from({ length: 5 }, () => [FAILING_COMMAND, FAILING_OUTPUT] as [string, string]);
    await updateOperatorDefaults({ judgmentProvider: 'off' });

    const baseline = setupAgent('pkt-off-baseline', commands);
    h.withoutHook = true;
    await tick();
    h.withoutHook = false;
    supervisor.unregisterWatchedAgent(baseline.sessionKey);
    h.transcripts.delete(baseline.sessionKey);

    const off = setupAgent('pkt-off', commands);
    await tick();
    await tick();

    expect(fixture.seen).toHaveLength(0);
    const shape = (laneId: string) => laneEvents(laneId).map((event) => ({ verb: event.verb, actor: event.actor }));
    expect(shape(off.lane.id)).toEqual(shape(baseline.lane.id));
    expect(eventsOf(off.lane.id, 'judgment')).toHaveLength(0);
    expect(eventsOf(off.lane.id, 'loop_check')).toHaveLength(0);
  }, 30_000);

  it('the loop replay label scores the recorded checks and prints n, sending nothing', async () => {
    // Seeded history: a looping lane the orchestrator later steered (positive)
    // and a distinct-command lane whose packet merged (negative).
    const looping = setupAgent('pkt-replay-loop', Array.from({ length: 5 }, () => [FAILING_COMMAND, FAILING_OUTPUT] as [string, string]));
    const fine = setupAgent('pkt-replay-fine', ['Run ls', 'Run cat a', 'Run lint', 'Run tsc', 'Run status'].map((command) => [command, 'ok'] as [string, string]));
    fixture.replies.push(loopReply(0.9), loopReply(0.2));
    await tick();
    recordLaneEvent(looping.lane.id, 'steered_packet', 'orchestrator', { packetId: 'pkt-replay-loop', source: 'orchestrator', message: 'stop rerunning' });
    const now = new Date().toISOString();
    getSqlite().prepare(`
      INSERT INTO session_outcomes (id, repo_path, runtime, packet_id, outcome, summary, started_at, completed_at, merged_clean)
      VALUES ('out-replay-fine', ?, 'codex', 'pkt-replay-fine', 'succeeded', 'done', ?, ?, 1)
    `).run(fine.repoPath, now, now);
    const seenBefore = fixture.seen.length;

    const stdout: string[] = [];
    const code = await runReplay(['--label', 'loop'], { stdout: (text: string) => stdout.push(text), stderr: () => undefined });
    expect(code).toBe(0);
    expect(fixture.seen).toHaveLength(seenBefore);
    const text = stdout.join('\n');
    expect(text).toMatch(/loop by p\(loop\): n=\d+ labeled checks \(positives \d+, negatives \d+\)/);
    expect(text).toMatch(/AUC [\d.]+ \(n=\d+\)\s+Brier [\d.]+ \(n=\d+\)/);
  }, 30_000);

  it('buildLoopState counts runs of repeated argument hashes and marks error output', () => {
    const entries = transcriptFor('s', [['Run a', 'ok'], ['Run b', 'Error: boom'], ['Run b', 'Error: boom'], ['Run c', 'ok']]);
    const state = buildLoopState(entries.map((entry) => ({ id: entry.id, role: entry.role, text: entry.text, toolName: entry.toolName })));
    expect(state.counts).toEqual({ toolCalls: 4, distinctTools: 1, distinctArgHashes: 3, repeatedArgHashRuns: 1 });
    expect(state.window.map((call) => call.failed)).toEqual([false, true, true, false]);
  });
});
