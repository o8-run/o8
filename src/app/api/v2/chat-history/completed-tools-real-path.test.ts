// @vitest-environment jsdom
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { OrchestratorBackend } from '@/lib/lane/orchestrator-backends/types';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { OrchestratorReplayBuffers as ReplayBuffers } from '@/lib/orchestrator/replay-buffer';
import { ToolCallChipCluster } from '@/components/desktop/thoughts/chat-panel/ToolCallChipCluster';
import { deserializeStoredTranscript } from '@/lib/transcripts/history-serde';

const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { dir: mkdtempSync(join(tmpdir(), 'o8-completed-tools-')) };
});
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => fixture.dir, migrateDataDirOnce: () => {} }));
vi.mock('@/lib/llm/thread-auto-title', () => ({ maybeQueueThreadAutoTitle: () => {} }));
vi.mock('@/lib/operator/defaults', async original => ({
  ...await original<typeof import('@/lib/operator/defaults')>(),
  resolveInAppOrchestratorEnabledSync: () => true,
}));
vi.mock('@/lib/repos/repo-path-registry', () => ({ resolveRepoPathFromRegistry: async (repoRoot: string) => ({ ok: true, repoRoot }) }));
vi.mock('@/lib/orchestrator/compaction-scorer', () => ({ scoreCompactionSegment: async () => null }));
vi.mock('@/lib/runtimes/shared/cli-resolver', () => ({ resolveCli: async () => ({ path: 'fixture-codex' }) }));
vi.mock('@/lib/providers/child-process', async original => ({ ...await original<typeof import('@/lib/providers/child-process')>(), spawn: () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Decisions made\n- Retain tool evidence.' } }) + '\n'));
    child.emit('close', 0);
  });
  return child;
} }));
const { POST, GET } = await import('./route');
const { POST: compact } = await import('@/app/api/orchestrator/compact/route');
const { upsertMobileOrchestratorAssistantMessage } = await import('@/lib/mobile/orchestrator-thread-history');
const { sendOrchestratorBackendTurn } = await import('@/lib/lane/orchestrator-send-entry');
const { OrchestratorReplayBuffers } = await import('@/lib/orchestrator/replay-buffer');
const repoPath = '/repo/completed-tools';
const tools = [
  { id: 'one', name: 'exec_command', args: { cmd: 'printf one' }, status: 'done', result: 'one result\n' },
  { id: 'two', name: 'exec_command', args: { cmd: 'exit 7' }, status: 'error', result: 'two failed\n' },
  { id: 'three', name: 'exec_command', args: { cmd: 'printf three' }, status: 'done', result: 'three result\n' },
] as const;
const post = async (body: Record<string, unknown>) => {
  const response = await POST(new NextRequest('http://localhost/api/v2/chat-history', {
    method: 'POST', headers: { 'Content-Type': 'application/json', host: 'localhost' }, body: JSON.stringify(body),
  }));
  expect(response.status).toBe(200);
};
const load = async (tabId: string) => {
  const response = await GET(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${tabId}`));
  expect(response.status).toBe(200);
  return await response.json();
};
async function runTurn(tabId: string, checkMidTurn?: (replay: ReplayBuffers) => Promise<void>, events?: OrchestratorEvent[]) {
  await post({ tabId, repoPath, messages: [{ id: 'user', role: 'user', content: 'Run three tools.', timestamp: 1 }] });
  let text = '';
  const replay = new OrchestratorReplayBuffers();
  replay.record(tabId, { event: 'status', data: { status: 'busy' } });
  const backend: OrchestratorBackend = { id: 'codex', label: 'Fixture', peekSession: () => null,
    ensureSession: () => ({ sessionName: tabId, status: 'ready' }),
    sendTurn: async (_repo, _message, emit) => {
      emit({ type: 'text', text: 'Checking commands. ' });
      for (const tool of tools) emit({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.args });
      for (const tool of tools) emit({ type: 'tool_result', id: tool.id, name: tool.name, output: tool.result, isError: tool.status === 'error' });
      if (checkMidTurn) await checkMidTurn(replay);
      for (const event of events ?? []) emit(event);
      emit({ type: 'text', text: 'Finished.' });
      emit({ type: 'done', sessionId: null, cost: null });
    },
  };
  await sendOrchestratorBackendTurn(backend, repoPath, 'Run three tools.', event => {
    if (event.type === 'text') text += event.text;
    if (event.type === 'text' || event.type === 'done') upsertMobileOrchestratorAssistantMessage({
      tabId, repoPath, messageId: 'assistant', content: text, backend: 'codex', timestampMs: 2,
    });
    replay.record(tabId, { event: event.type === 'done' ? 'status' : event.type, data: event.type === 'done' ? { status: 'ready' } : { ...event, status: undefined } });
  }, { threadId: tabId, transcriptMessageId: 'assistant' }, 'fleet');
  expect(replay.since(tabId, 0)).toEqual([]);
  // The desktop's enrichment is older than the server's terminal write.
  await post({ tabId, repoPath, messages: [{ id: 'assistant', role: 'assistant', content: text, timestamp: 2, toolCalls: tools }] });
  return load(tabId);
}
async function expectTools(record: Awaited<ReturnType<typeof load>>) {
  const restored = deserializeStoredTranscript(record.messages);
  const assistant = restored.find(message => message.id === 'assistant')!;
  expect(assistant.toolCalls).toEqual(tools.map(tool => expect.objectContaining(tool)));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(ToolCallChipCluster, { toolCalls: assistant.toolCalls! })));
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('two failed');
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
}
afterAll(() => rmSync(fixture.dir, { recursive: true, force: true }));
describe('completed tool history through production save/load routes', () => {
  it('reloads the three ids, full results and failure alert after terminal persistence rejects stale enrichment', async () => {
    const tabId = 'thoughts-tools-complete';
    await expectTools(await runTurn(tabId, async replay => {
      // Mid-turn recovery still uses the unchanged replay tail.
      expect(replay.since(tabId, 0).map(raw => JSON.parse(raw)).filter(event => event.event === 'tool_result')).toHaveLength(3);
      expect((await load(tabId)).messages.find((message: { id: string }) => message.id === 'assistant').toolCalls).toBeUndefined();
    }));
    const before = (await load(tabId)).messages.find((message: { id: string }) => message.id === 'assistant');
    await post({ tabId, repoPath, messages: [{ ...before, persistedVersion: before.persistedVersion - 1,
      content: 'stale conflicting text', backend: 'claude', model: 'conflicting-model', toolCalls: [] }] });
    expect((await load(tabId)).messages.find((message: { id: string }) => message.id === 'assistant')).toEqual(before);
  });
  it('retains tools from summarized and retained turns after real compaction and a stale save', async () => {
    const tabId = 'thoughts-tools-compaction';
    await runTurn(tabId);
    await post({ tabId, repoPath, messages: Array.from({ length: 80 }, (_, index) => ({
      id: `tail-${index}`, role: index % 2 ? 'assistant' : 'user', content: `Thread continuation ${index}.`, timestamp: index + 100,
      ...(index === 79 ? { toolCalls: tools } : {}),
    })) });
    const response = await compact(new NextRequest('http://localhost/api/orchestrator/compact', {
      method: 'POST', headers: { 'Content-Type': 'application/json', host: 'localhost' }, body: JSON.stringify({ repoPath, threadId: tabId, trigger: 'manual', keepTailCount: 4 }),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).applied).toBe(true);
    // A pre-compaction client can still save after the summary commits.
    await post({ tabId, repoPath, messages: [{ id: 'assistant', role: 'assistant', content: 'Old snapshot', timestamp: 2, toolCalls: [] }] });
    const record = await load(tabId);
    await expectTools(record);
    expect(record.messages.find((message: { id: string }) => message.id === 'tail-79').toolCalls).toEqual(tools);
    expect(record.messages.filter((message: { type?: string }) => message.type === 'compaction')).toHaveLength(1);
  });
  it('keeps duplicate ids unique, full output intact and unmatched results separate from pending calls', async () => {
    const output = 'complete output\n'.repeat(2_000);
    const record = await runTurn('thoughts-tools-identities', undefined, [
      { type: 'tool_use', id: 'one', name: 'exec_command', input: tools[0].args },
      { type: 'tool_result', id: 'one', name: 'exec_command', output },
      { type: 'tool_use', id: 'pending', name: 'exec_command', input: { cmd: 'pending' } },
      { type: 'tool_result', id: 'unmatched', name: 'exec_command', output: 'Unmatched failure', isError: true },
    ]);
    const calls = record.messages.find((message: { id: string }) => message.id === 'assistant').toolCalls;
    expect(calls.filter((tool: { id: string }) => tool.id === 'one')).toHaveLength(1);
    expect(calls.find((tool: { id: string }) => tool.id === 'one').result).toBe(output);
    expect(calls.find((tool: { id: string }) => tool.id === 'pending')).not.toHaveProperty('result');
    expect(calls.find((tool: { id: string }) => tool.id === 'pending')).not.toHaveProperty('status');
    expect(calls.find((tool: { id: string }) => tool.id === 'unmatched').status).toBe('error');
  });
  it('discards rejected-attempt tools rather than persisting them with the retry', async () => {
    const record = await runTurn('thoughts-tools-retry', undefined, [
      { type: 'turn_retry', attempt: 2, reason: 'retry', notice: 'Trying again' },
      { type: 'tool_use', id: 'retry', name: 'exec_command', input: { cmd: 'printf retry' } },
      { type: 'tool_result', id: 'retry', name: 'exec_command', output: 'retry result' },
    ]);
    expect(record.messages.find((message: { id: string }) => message.id === 'assistant').toolCalls).toEqual([
      expect.objectContaining({ id: 'retry', result: 'retry result', status: 'done' }),
    ]);
  });
});
