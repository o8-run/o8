import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-codex-transcript-tail-'));
const ownedCodexRoot = join(dataDir, 'owned-codex');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = ownedCodexRoot;

const { POST } = await import('@/app/api/mobile/sync/route');
const { getRuntime } = await import('@/lib/runtimes/registry');
const {
  latestTranscriptEventAt,
  readSessionTranscriptEvents,
} = await import('@/lib/orchestrator/packet-transcript');
const {
  RUNNING_TRANSCRIPT_STALL_MS,
  classifyLaneTranscriptFault,
} = await import('@/lib/lane/transcript-health');

function syncRequest(sessionKey: string, sinceId?: string) {
  return new NextRequest('http://localhost:3001/api/mobile/sync', {
    method: 'POST',
    body: JSON.stringify({ history: { sessionKey, sinceId, limit: 200 } }),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readSync(sessionKey: string, sinceId?: string) {
  const response = await POST(syncRequest(sessionKey, sinceId));
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    history: {
      sessionKey: string;
      entries: Array<{ id: string; text: string }>;
      replace?: boolean;
    };
  }>;
}

async function transcriptActivityAt(sessionKey: string) {
  const readback = await readSessionTranscriptEvents(sessionKey);
  return latestTranscriptEventAt(readback.events);
}

async function waitForMtimeTick() {
  await new Promise((resolve) => setTimeout(resolve, 15));
}

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('owned Codex run-log transcript ingestion real path', () => {
  it('deduplicates replayed command items without collapsing reused item ids', async () => {
    const sessionId = 'codex-owned-replayed-items';
    const sessionKey = `codex-owned:${sessionId}`;
    const sessionDir = join(ownedCodexRoot, sessionId);
    const runsDir = join(sessionDir, 'runs');
    const firstStdoutPath = join(runsDir, 'first.jsonl');
    const secondStdoutPath = join(runsDir, 'second.jsonl');
    const stderrPath = join(runsDir, 'run.stderr.log');
    const firstCommand = '/bin/echo first';
    const secondCommand = '/bin/echo second';
    const commandEvents = (command: string, output: string) => [
      JSON.stringify({
        type: 'item.started',
        item: { id: 'item_1', type: 'command_execution', command },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command,
          aggregated_output: output,
          exit_code: 0,
        },
      }),
    ];

    mkdirSync(runsDir, { recursive: true });
    const firstEvents = commandEvents(firstCommand, 'first');
    writeFileSync(firstStdoutPath, `${firstEvents.join('\n')}\n`);
    writeFileSync(secondStdoutPath, `${[
      ...firstEvents,
      ...commandEvents(secondCommand, 'second'),
    ].join('\n')}\n`);
    writeFileSync(stderrPath, '');
    const recentRuns = [
      { id: 'first', startedAt: '2026-08-23T12:00:00.000Z', stdoutPath: firstStdoutPath },
      { id: 'second', startedAt: '2026-08-23T12:01:00.000Z', stdoutPath: secondStdoutPath },
    ].map((run) => ({
      ...run,
      mode: 'launch',
      prompt: 'Exercise replayed transcript items.',
      pid: process.pid,
      stderrPath,
      outcome: 'completed',
    }));
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId: sessionKey,
      sessionDir,
      cwd: dataDir,
      repoPath: dataDir,
      title: 'Replayed items fixture',
      createdAt: recentRuns[0]!.startedAt,
      updatedAt: recentRuns[1]!.startedAt,
      latestPrompt: recentRuns[1]!.prompt,
      latestSummary: 'completed',
      activeRun: null,
      recentRuns,
    }));

    const readback = await readSessionTranscriptEvents(sessionKey);
    const calls = readback.events.filter((event) => event.type === 'tool_call');
    const results = readback.events.filter((event) => event.type === 'tool_result');

    expect(calls).toEqual([
      expect.objectContaining({ args: firstCommand }),
      expect.objectContaining({ args: secondCommand }),
    ]);
    expect(results).toEqual([
      expect.objectContaining({ summary: 'first' }),
      expect.objectContaining({ summary: 'second' }),
    ]);
  });

  it('streams every later append through mobile sync and advances transcript activity', async () => {
    const sessionId = 'codex-owned-live-append';
    const sessionKey = `codex-owned:${sessionId}`;
    const sessionDir = join(ownedCodexRoot, sessionId);
    const runsDir = join(sessionDir, 'runs');
    const stdoutPath = join(runsDir, 'live.stdout.jsonl');
    const stderrPath = join(runsDir, 'live.stderr.log');
    const startedAt = new Date(Date.now() - 10_000).toISOString();
    const run = {
      id: 'live-run',
      mode: 'launch',
      prompt: 'Keep streaming the fake worker transcript.',
      startedAt,
      pid: process.pid,
      stdoutPath,
      stderrPath,
      outcome: 'running',
    } as const;

    mkdirSync(runsDir, { recursive: true });
    writeFileSync(stdoutPath, `${JSON.stringify({
      type: 'item.started',
      item: { id: 'command-1', type: 'command_execution', command: '/bin/echo first' },
    })}\n`);
    writeFileSync(stderrPath, '');
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId: sessionKey,
      sessionDir,
      cwd: dataDir,
      repoPath: dataDir,
      title: 'Live append fixture',
      createdAt: startedAt,
      updatedAt: startedAt,
      latestPrompt: run.prompt,
      latestSummary: 'running',
      activeRun: run,
      recentRuns: [run],
    }));

    const first = await readSync(sessionKey);
    expect(first.history.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Running /bin/echo first' }),
    ]));
    const firstCursor = first.history.entries.at(-1)!.id;
    const runtime = getRuntime('codex')!;
    const running = await runtime.readTranscript(sessionKey, undefined, 200);
    const runningCall = running.flatMap(entry => entry.toolCalls ?? []);
    expect(runningCall).toEqual([expect.objectContaining({ status: 'running' })]);
    const firstActivityAt = await transcriptActivityAt(sessionKey);
    expect(firstActivityAt).not.toBeNull();

    await waitForMtimeTick();
    appendFileSync(stdoutPath, `${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'command-1',
        type: 'command_execution',
        command: '/bin/echo first',
        aggregated_output: 'first',
        exit_code: 0,
      },
    })}\n`);
    const second = await readSync(sessionKey, firstCursor);
    expect(second.history.replace).not.toBe(true);
    expect(second.history.entries).toEqual([
      expect.objectContaining({ text: 'Run /bin/echo first' }),
    ]);
    const secondCursor = second.history.entries.at(-1)!.id;
    expect(secondCursor).not.toBe(firstCursor);
    // A cursor remains addressable after completion, and repeating the poll
    // cannot consume another client's copy of the same completion event.
    expect((await readSync(sessionKey, firstCursor)).history.entries).toEqual(second.history.entries);
    expect((await readSync(sessionKey, secondCursor)).history.entries).toEqual([]);
    const settled = await runtime.readTranscript(sessionKey, undefined, 200);
    const settledCall = settled.flatMap(entry => entry.toolCalls ?? []);
    expect(settledCall).toEqual([expect.objectContaining({
      id: runningCall[0]!.id, status: 'done', result: 'first',
    })]);
    expect(settled.find(entry => entry.toolCalls?.length)?.id)
      .toBe(running.find(entry => entry.toolCalls?.length)?.id);
    const secondActivityAt = await transcriptActivityAt(sessionKey);
    expect(Date.parse(secondActivityAt!)).toBeGreaterThan(Date.parse(firstActivityAt!));

    await waitForMtimeTick();
    appendFileSync(stdoutPath, `${JSON.stringify({
      type: 'item.completed',
      item: { id: 'message-1', type: 'agent_message', text: 'Still working after the first burst.' },
    })}\n`);
    const third = await readSync(sessionKey, secondCursor);
    expect(third.history.replace).not.toBe(true);
    expect(third.history.entries).toEqual([
      expect.objectContaining({ text: 'Still working after the first burst.' }),
    ]);
    const thirdCursor = third.history.entries.at(-1)!.id;
    expect((await readSync(sessionKey, thirdCursor)).history.entries).toEqual([]);
    const full = await readSync(sessionKey);
    expect(full.history.entries.filter(entry => entry.id === firstCursor)).toHaveLength(1);
    expect(full.history.entries.filter(entry => entry.id === secondCursor)).toHaveLength(1);
    const thirdActivityAt = await transcriptActivityAt(sessionKey);
    expect(Date.parse(thirdActivityAt!)).toBeGreaterThan(Date.parse(secondActivityAt!));
  });

  it('surfaces a running lane whose transcript has not advanced past the threshold', () => {
    const now = Date.now();
    const fault = classifyLaneTranscriptFault({
      status: 'running',
      createdAt: new Date(now - RUNNING_TRANSCRIPT_STALL_MS - 1).toISOString(),
      lastEventAt: null,
    }, {
      lastTranscriptAt: null,
      readFailed: false,
    }, now);

    expect(fault).toEqual(expect.objectContaining({
      code: 'transcript_stalled',
      thresholdMs: RUNNING_TRANSCRIPT_STALL_MS,
    }));
  });
});
