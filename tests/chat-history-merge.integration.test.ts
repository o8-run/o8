import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { POST, GET, DELETE, PATCH } from '@/app/api/v2/chat-history/route';
import { getDataDir } from '@/lib/data-dir-migration';
import { LiveCaptions } from '@/lib/voice/managed-live/captions';
import { serializeTranscriptForStorage, deserializeStoredTranscript } from '@/lib/transcripts/history-serde';
import { visibleVoiceTranscript } from '@/lib/transcripts/voice-captions';
import { dedupeDisplayMessages } from '@/components/desktop/thoughts/chat-panel/dedupe-display-messages';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { persistRuntimeSessionHandoff, readRuntimeSessionHandoff } from '@/lib/lane/runtime-session-handoff';
import { writePersistedLlmChat } from '@/lib/llm/chat-history-store';

// End-to-end verify for #1282: the real chat-history route must merge by default
// (a partial POST can't drop a stored turn) and full-replace only on replace:true.
// Uses a throwaway thoughts- tabId under the isolated test data dir; cleaned up.

const tabId = `thoughts-itest1282-${process.pid}-${Math.floor(performance.now())}`;

const post = (body: Record<string, unknown>) =>
  POST(new NextRequest('http://localhost/api/v2/chat-history', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));

const patch = (body: Record<string, unknown>) =>
  PATCH(new NextRequest('http://localhost/api/v2/chat-history', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));

async function storedIds(): Promise<string[]> {
  const res = await GET(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${encodeURIComponent(tabId)}`));
  const data = await res.json();
  return (data.messages ?? []).map((m: { id: string }) => m.id);
}

async function storedMessages(): Promise<Array<Record<string, unknown>>> {
  const res = await GET(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${encodeURIComponent(tabId)}`));
  const data = await res.json();
  return data.messages ?? [];
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

const user = { id: 'u1', role: 'user', timestamp: 100, content: 'Hey buddy' };
const assistant = { id: 'a1', role: 'assistant', timestamp: 101, content: 'hi!' };

afterAll(async () => {
  await DELETE(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${encodeURIComponent(tabId)}`));
});

describe('chat-history route merge (#1282)', () => {
  it.each(['route', 'store'] as const)('preserves a pending runtime handoff through a stale %s save', async writer => {
    const id = `${tabId}-handoff-${writer}`;
    try {
      await post({ tabId: id, messages: [user, assistant], repoPath: process.cwd() });
      const state = { previousThreadId: 'missing-thread', replacementThreadId: 'empty-thread', inputAccepted: false };
      persistRuntimeSessionHandoff(id, state);
      if (writer === 'route') expect((await post({ tabId: id, messages: [user] })).ok).toBe(true);
      else writePersistedLlmChat(id, { messages: [{ ...user, role: 'user' }] });
      expect(readRuntimeSessionHandoff(id)).toEqual(state);
    } finally {
      await DELETE(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${id}`));
    }
  });
  it('persists streamed voice, its exact send link and separate spoken replies across stale writes and reload', async () => {
    let captions: MobileTranscriptEntry[] = [];
    const projection = new LiveCaptions('voice-session', updates => { captions = dedupeDisplayMessages([...captions, ...updates]); });
    projection.observe({ type: 'session.input_transcript.delta', event_id: 'a', delta: 'Read this', start_ms: 0, end_ms: 100 });
    const stale = serializeTranscriptForStorage(captions);
    expect((await post({ tabId, replace: true, messages: stale })).ok).toBe(true);
    projection.observe({ type: 'session.input_transcript.delta', event_id: 'b', delta: ' file', start_ms: 100, end_ms: 200 });
    projection.submitted(['a', 'b'], 'orch-user-caption-test');
    projection.observe({ type: 'session.output_transcript.delta', event_id: 'c', delta: 'I will check.', start_ms: 200, end_ms: 300 });
    const sent: MobileTranscriptEntry = { id: 'orch-user-caption-test', role: 'user', text: 'Read this file' };
    expect((await post({ tabId, messages: serializeTranscriptForStorage([...captions, sent]) })).ok).toBe(true);
    expect((await post({ tabId, messages: stale })).ok).toBe(true);
    const restored = deserializeStoredTranscript(await storedMessages());
    expect(restored.find(entry => entry.voice?.direction === 'input')).toMatchObject({ text: 'Read this file', voice: { delegatedUserMessageId: sent.id } });
    const visible = visibleVoiceTranscript(restored);
    expect(visible.filter(entry => entry.role === 'user')).toEqual([expect.objectContaining({ id: sent.id, text: sent.text })]);
    expect(visible.find(entry => entry.voice?.direction === 'output')).toMatchObject({ text: 'I will check.' });
    expect(visible.every(entry => !entry.receipt)).toBe(true);
  });
  it('a partial [user]-only POST does NOT drop the stored assistant reply', async () => {
    await post({ tabId, replace: true, messages: [user, assistant] }); // seed full turn
    await post({ tabId, messages: [user] });                            // the bug: partial POST
    expect(await storedIds()).toEqual(['u1', 'a1']);                    // reply survived
  });

  it('replace:true does a full replace (intentional truncation)', async () => {
    await post({ tabId, replace: true, messages: [user, assistant] }); // reset
    await post({ tabId, replace: true, messages: [user] });            // truncate
    expect(await storedIds()).toEqual(['u1']);                         // assistant dropped
  });

  it('keeps server-authored runtime attribution through a legacy full-transcript POST', async () => {
    await post({
      tabId,
      replace: true,
      messages: [user, { ...assistant, backend: 'codex', model: 'gpt-5.6', persistedVersion: 2 }],
    });
    await post({ tabId, messages: [user, assistant] });

    expect((await storedMessages()).find((message) => message.id === 'a1')).toMatchObject({
      backend: 'codex',
      model: 'gpt-5.6',
      persistedVersion: 2,
    });
  });

  it('serializes a stale client POST behind a worker receipt append', async () => {
    const receipt = { leadModel: 'gpt-5.6-sol', effort: 'high', mode: 'multitask' };
    await post({ tabId, replace: true, messages: [user, { ...assistant, receipt }] });
    const markerPath = join(getDataDir(), `chat-history-lock-${process.pid}`);
    rmSync(markerPath, { force: true });
    const childCode = `
      import { writeFileSync } from 'node:fs';
      const { withCanonicalChatHistoryLock } = (await import('./src/lib/llm/chat-history-store.ts')).default;
      const { appendMobileOrchestratorTurnWorker } = (await import('./src/lib/mobile/orchestrator-turn-receipt.ts')).default;
      withCanonicalChatHistoryLock(process.env.O8_TEST_TAB_ID, () => {
        writeFileSync(process.env.O8_TEST_LOCK_MARKER, 'locked');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
        if (!appendMobileOrchestratorTurnWorker({
          tabId: process.env.O8_TEST_TAB_ID,
          messageId: 'a1',
          worker: { packetId: 'packet-race', runtime: 'codex', model: 'gpt-5.6-terra' },
        })) process.exitCode = 1;
      });
    `;
    const child = spawn(process.execPath, [
      '--import=./scripts/register-server-only-stub.mjs',
      '--import=tsx',
      '--input-type=module',
      '--eval',
      childCode,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        O8_TEST_TAB_ID: tabId,
        O8_TEST_LOCK_MARKER: markerPath,
      },
      stdio: 'pipe',
    });
    const childExit = once(child, 'exit');
    await waitForFile(markerPath);
    expect((await post({ tabId, messages: [user, assistant] })).ok).toBe(true);
    const [exitCode] = await childExit;
    expect(exitCode).toBe(0);
    expect((await storedMessages()).find((message) => message.id === 'a1')).toMatchObject({
      receipt: {
        ...receipt,
        workers: [{ packetId: 'packet-race', runtime: 'codex', model: 'gpt-5.6-terra' }],
      },
    });
    rmSync(markerPath, { force: true });
  });

  it('a metadata PATCH waits for a worker receipt append instead of writing its stale snapshot back', async () => {
    const receipt = { leadModel: 'gpt-5.6-sol', effort: 'high', mode: 'multitask' };
    await post({ tabId, replace: true, messages: [user, { ...assistant, receipt }] });
    await patch({ tabId, starred: false });
    const markerPath = join(getDataDir(), `chat-history-patch-lock-${process.pid}`);
    rmSync(markerPath, { force: true });
    const childCode = `
      import { writeFileSync } from 'node:fs';
      const { withCanonicalChatHistoryLock } = (await import('./src/lib/llm/chat-history-store.ts')).default;
      const { appendMobileOrchestratorTurnWorker } = (await import('./src/lib/mobile/orchestrator-turn-receipt.ts')).default;
      withCanonicalChatHistoryLock(process.env.O8_TEST_TAB_ID, () => {
        writeFileSync(process.env.O8_TEST_LOCK_MARKER, 'locked');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
        if (!appendMobileOrchestratorTurnWorker({
          tabId: process.env.O8_TEST_TAB_ID,
          messageId: 'a1',
          worker: { packetId: 'packet-patch-race', runtime: 'codex', model: 'gpt-5.6-terra' },
        })) process.exitCode = 1;
      });
    `;
    const child = spawn(process.execPath, [
      '--import=./scripts/register-server-only-stub.mjs',
      '--import=tsx',
      '--input-type=module',
      '--eval',
      childCode,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        O8_TEST_TAB_ID: tabId,
        O8_TEST_LOCK_MARKER: markerPath,
      },
      stdio: 'pipe',
    });
    const childExit = once(child, 'exit');
    await waitForFile(markerPath);
    expect((await patch({ tabId, starred: true })).ok).toBe(true);
    // Read the moment PATCH resolves, before the child exits: a PATCH that did
    // not wait for the lock resolves while the child still sleeps, and the
    // worker row is not on disk yet.
    const afterPatch = await storedMessages();
    expect(afterPatch.find((message) => message.id === 'a1')).toMatchObject({
      receipt: {
        ...receipt,
        workers: [{ packetId: 'packet-patch-race', runtime: 'codex', model: 'gpt-5.6-terra' }],
      },
    });
    const [exitCode] = await childExit;
    expect(exitCode).toBe(0);
    const res = await GET(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${encodeURIComponent(tabId)}`));
    expect((await res.json()).starred).toBe(true);
    rmSync(markerPath, { force: true });
  });
});
