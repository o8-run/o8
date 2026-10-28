/**
 * #2465 — judgment-scored compaction, record-only, through the real
 * `autoCompactOrchestratorThread`.
 *
 * Real-path doctrine: threads are persisted chat-history files in this file's
 * temp data dir, the provider setting goes through the real operator-defaults
 * store, the key comes from the data-dir key file, the scorer call goes over
 * HTTP to the local systemone fixture, receipts are read back from the
 * persisted `judgment_receipts` table, and the replay label reads the archives
 * the real compaction wrote. Stubbed: the summarizer (a fake Codex binary, as
 * in auto-compact.test.ts).
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { startJudgmentEndpointFixture, type JudgmentEndpointFixture } from './fixtures/judgment-endpoint';

const h = vi.hoisted(() => ({
  /** Baseline switch: behave as if auto-compaction never called the scorer. */
  withoutScorer: false,
}));

vi.mock('@/lib/orchestrator/compaction-scorer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orchestrator/compaction-scorer')>();
  return {
    ...actual,
    scoreCompactionSegment: (...args: Parameters<typeof actual.scoreCompactionSegment>) => (
      h.withoutScorer ? Promise.resolve(null) : actual.scoreCompactionSegment(...args)
    ),
  };
});

const originalEnv = {
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  O8_CODEX_BIN: process.env.O8_CODEX_BIN,
};
const testRoot = mkdtempSync(join(os.tmpdir(), 'o8-compaction-scorer-'));
const dataDir = join(testRoot, 'data');
const repoPath = join(testRoot, 'repo');
const fakeCodex = join(testRoot, 'fake-codex.mjs');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_CODEX_BIN = fakeCodex;
mkdirSync(join(dataDir, 'chat-history'), { recursive: true });
mkdirSync(repoPath, { recursive: true });
writeFileSync(fakeCodex, [
  '#!/usr/bin/env node',
  "console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 321, output_tokens: 45 } }));",
  "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Decisions made\\n- Reconcile first.\\nFiles touched\\n- src/lib/billing/reconcile.ts\\nOpen questions\\n- None.\\nCurrent mission state\\n- Continue.' } }));",
].join('\n'));
chmodSync(fakeCodex, 0o755);

const { getSqlite } = await import('@/lib/db');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { judgmentKeyPath } = await import('@/lib/judgment/key');
const { autoCompactOrchestratorThread } = await import('@/lib/orchestrator/auto-compact');
const { setCompactionScorerTransportForTests, ENTRY_TEXT_BUDGET } = await import('@/lib/orchestrator/compaction-scorer');
const { runReplay } = await import('../scripts/judgment-replay.mjs');

const KEY = 'ts-fixture-key-compaction-2465';
const HUGE_HEAD = 'HEAD-MARK src/lib/billing/reconcile.ts line 1';
const HUGE_TAIL = 'TAIL-MARK 42 rows reconciled';
const HUGE_TOOL_RESULT = `${HUGE_HEAD}\n${'x'.repeat(6_000)}\n${HUGE_TAIL}`;
const COMPACTED_IDS = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'];
const SCORES: Record<string, number> = { m0: 0.92, m1: 0.12, m2: 0.55, m3: 0.3, m4: 0.7, m5: 0.2 };

let fixture: JudgmentEndpointFixture;

function seedThread(threadId: string) {
  const texts = [
    'Fix #2465 before the next release.',
    'Looking at it now.',
    HUGE_TOOL_RESULT,
    'ok thanks',
    'Next I will run the checks.',
    'sounds good',
    'What else is left?',
    'Only the docs pass.',
  ];
  writeFileSync(join(dataDir, 'chat-history', `${threadId}.json`), JSON.stringify({
    repoPath,
    messages: texts.map((content, index) => ({
      id: `m${index}`,
      role: index === 2 ? 'tool' : index % 2 === 0 ? 'user' : 'assistant',
      content,
      timestamp: index + 1,
      ...(index === 2 ? { toolCalls: [{ name: 'exec_command', result: 'done' }] } : {}),
    })),
  }));
}

function scorerReply() {
  return {
    status: 200,
    delayMs: 5,
    body: {
      model: 'jev-fixture',
      answers: Object.fromEntries(COMPACTED_IDS.map((id) => [`entry_${id}`, { type: 'noul', noul: SCORES[id] }])),
      usage: { input_tokens: 900, output_tokens: 12 },
    },
  };
}

async function compact(threadId: string) {
  seedThread(threadId);
  const result = await autoCompactOrchestratorThread({ repoPath, threadId, keepTailCount: 2, trigger: 'manual', force: true });
  expect(result.applied).toBe(true);
  const record = JSON.parse(readFileSync(join(dataDir, 'chat-history', `${threadId}.json`), 'utf8')) as { messages: Array<Record<string, unknown>> };
  const archive = JSON.parse(readFileSync(join(dataDir, 'orchestrator-archives', result.archiveRef!), 'utf8')) as Record<string, unknown>;
  const entry = record.messages[0] as { text: string; compaction: Record<string, unknown> & { summary: string } };
  return { result, record, archive, entry };
}

/** Per-run ids, clocks, and the thread id normalized so two runs compare byte for byte. */
function normalized(value: unknown, threadId: string): string {
  return JSON.stringify(value)
    .split(threadId).join('<thread>')
    .replace(/orch-compaction-\d+/g, 'orch-compaction-<t>')
    .replace(/"operationId":"compaction-[\w-]+"/g, '"operationId":"<operation>"')
    .replace(/"(startedAt|completedAt)":\d+/g, '"$1":<t>')
    .replace(/"timestamp":\d{13}/g, '"timestamp":<t>')
    .replace(/"(savedAt|archivedAt)":"[^"]*"/g, '"$1":"<t>"')
    .replace(/"timestampLabel":"[^"]*"/g, '"timestampLabel":"<t>"')
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, '<stamp>');
}

const stampFree = (text: string | null) => (text ?? '').replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, '<stamp>');

beforeAll(async () => {
  await updateOperatorDefaults({ productTelemetryEnabled: false });
  fixture = await startJudgmentEndpointFixture();
  setCompactionScorerTransportForTests({ endpoint: fixture.endpoint, timeoutMs: 2_000, maxAttempts: 1 });
  writeFileSync(judgmentKeyPath(), `${KEY}\n`);
  chmodSync(judgmentKeyPath(), 0o600);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

beforeEach(async () => {
  fixture.reset();
  h.withoutScorer = false;
  await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
});

afterAll(async () => {
  setCompactionScorerTransportForTests(undefined);
  vi.restoreAllMocks();
  await fixture.close();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(testRoot, { recursive: true, force: true });
});

describe('judgment-scored compaction through autoCompactOrchestratorThread', () => {
  it('scores every compacted entry in one call, records scorer output on the entry and the archive, and leaves the text unchanged', async () => {
    await updateOperatorDefaults({ judgmentProvider: 'off' });
    const off = await compact('thoughts-scorer-baseline');
    expect(fixture.seen).toHaveLength(0);

    await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
    fixture.replies.push(scorerReply());
    const on = await compact('thoughts-scorer-on');

    // One request, every compacted entry id in the state, one question per entry.
    expect(fixture.seen).toHaveLength(1);
    const body = fixture.seen[0].body as { state: { entries: Array<{ id: string; question: string; role: string; text: string | null; clipped?: { chars: number } }> }; questions: Record<string, { type: string; instructions: string }> };
    expect(body.state.entries.map((entry) => entry.id)).toEqual(COMPACTED_IDS);
    expect(Object.keys(body.questions)).toEqual(COMPACTED_IDS.map((id) => `entry_${id}`));
    expect(new Set(Object.values(body.questions).map((question) => question.instructions)).size).toBe(1);

    // The oversize tool result arrives as head + tail + size.
    const huge = body.state.entries.find((entry) => entry.id === 'm2')!;
    expect(HUGE_TOOL_RESULT.length).toBeGreaterThan(ENTRY_TEXT_BUDGET);
    expect(huge.role).toBe('tool');
    expect(huge.clipped).toEqual({ chars: HUGE_TOOL_RESULT.length + '\n\nTool: exec_command\ndone'.length, headChars: 800, tailChars: 800 });
    expect(huge.text).toContain(HUGE_HEAD);
    expect(huge.text).toContain(HUGE_TAIL);
    expect(huge.text!.length).toBeLessThan(ENTRY_TEXT_BUDGET);

    // The scorer record lands on the compaction entry and in the archive.
    const scorer = on.entry.compaction.scorer as { receiptId: string; scores: Record<string, number>; buckets: Record<string, string[]>; latencyMs: number; truncated: boolean };
    expect(scorer).toMatchObject({
      scores: SCORES,
      buckets: { keep: ['m0', 'm4'], drop: ['m1', 'm3', 'm5'], summarize: ['m2'] },
      truncated: false,
    });
    expect(on.archive.scorer).toEqual(scorer);
    const receipt = getSqlite().prepare('SELECT id, surface, ok, latency_ms, lane_id FROM judgment_receipts WHERE id = ?')
      .get(scorer.receiptId) as { id: string; surface: string; ok: number; latency_ms: number; lane_id: string | null };
    expect(receipt).toMatchObject({ id: scorer.receiptId, surface: 'compaction-scorer', ok: 1, lane_id: null });
    expect(receipt.latency_ms).toBeGreaterThan(0);

    // Summary, compaction entry text, and resume prelude are byte-identical to the setting-off run.
    expect(on.entry.compaction.summary).toBe(off.entry.compaction.summary);
    expect(on.entry.text).toBe(off.entry.text);
    expect(stampFree(on.result.resumePrelude)).toBe(stampFree(off.result.resumePrelude));
    const { scorer: _entryScorer, ...onCompaction } = on.entry.compaction;
    expect(normalized(onCompaction, 'thoughts-scorer-on')).toBe(normalized(off.entry.compaction, 'thoughts-scorer-baseline'));
    expect(normalized(on.record.messages.slice(1), 'thoughts-scorer-on')).toBe(normalized(off.record.messages.slice(1), 'thoughts-scorer-baseline'));
  }, 30_000);

  it('with the setting off sends nothing and writes the record and archive the unhooked path writes', async () => {
    h.withoutScorer = true;
    const baseline = await compact('thoughts-scorer-unhooked');
    h.withoutScorer = false;
    await updateOperatorDefaults({ judgmentProvider: 'off' });
    fixture.replies.push(scorerReply());
    const off = await compact('thoughts-scorer-off');

    expect(fixture.seen).toHaveLength(0);
    expect(off.entry.compaction).not.toHaveProperty('scorer');
    expect(off.archive).not.toHaveProperty('scorer');
    expect(normalized(off.record, 'thoughts-scorer-off')).toBe(normalized(baseline.record, 'thoughts-scorer-unhooked'));
    expect(normalized(off.archive, 'thoughts-scorer-off')).toBe(normalized(baseline.archive, 'thoughts-scorer-unhooked'));
  }, 30_000);

  it('replays the compaction label from the archive and the later turns of the same thread', async () => {
    fixture.replies.push(scorerReply());
    const threadId = 'thoughts-scorer-replay';
    const on = await compact(threadId);
    const later = Date.parse(on.archive.archivedAt as string) + 1_000;
    // Later turns reuse the path from m2 and the issue number from m0, nothing else.
    const filePath = join(dataDir, 'chat-history', `${threadId}.json`);
    const record = JSON.parse(readFileSync(filePath, 'utf8')) as { messages: Array<Record<string, unknown>> };
    record.messages.push(
      { id: 'later-1', role: 'user', content: 'Open src/lib/billing/reconcile.ts again.', timestamp: later },
      { id: 'later-2', role: 'assistant', content: 'Closing #2465 with that change.', timestamp: later + 1 },
    );
    writeFileSync(filePath, JSON.stringify(record));

    const stdout: string[] = [];
    const code = await runReplay(['--label', 'compaction'], { stdout: (text: string) => stdout.push(text), stderr: () => undefined });
    const text = stdout.join('\n');
    expect(code).toBe(0);
    expect(fixture.seen).toHaveLength(1);
    expect(text).toContain('compaction by p(needed): n=6 scored entries (positives 2, negatives 4)');
    expect(text).toContain('AUC 0.875 (n=6)');
    expect(text).toMatch(/with scorer and later turns: 1;/);
  }, 30_000);
});
