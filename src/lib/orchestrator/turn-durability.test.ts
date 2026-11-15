import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrchestratorReplayBuffers } from './replay-buffer';

// RC1 core claim — the SERVER orchestrator turn is DURABLE: it keeps persisting
// assistant text and buffering events after the origin client disconnects, so a
// reattaching client recovers the in-flight turn. The bug is CLIENT detachment,
// not server durability.
//
// REACHABILITY NOTE: the literal `handleClientMessage → 'orchestrator-send'`
// entry point cannot be driven in the vitest harness — importing `src/ws-server.ts`
// boots a live HTTP+WS server + supervisor loops on module load (no exports).
// This drives the SAME durability primitives the send handler uses, in the same
// sequence: the real persistence store (`upsertMobileOrchestratorAssistantMessage`
// / `readOrchestratorThreadMessages`) and the real replay buffer class
// (`OrchestratorReplayBuffers`, the class behind ws-server's `orchestratorReplay`
// singleton that `broadcastToOrchestratorSession` records into and
// `handleOrchestratorSubscribe` replays from). homedir() is mocked to a temp dir
// (the store's isolation pattern).

const tempHomes: string[] = [];

async function loadHistory() {
  const home = mkdtempSync(join(tmpdir(), 'o8-durability-'));
  tempHomes.push(home);
  vi.resetModules();
  vi.doMock('node:os', async () => ({
    ...(await vi.importActual<typeof import('node:os')>('node:os')),
    homedir: () => home,
  }));
  return import('@/lib/mobile/orchestrator-thread-history');
}

afterEach(() => {
  vi.doUnmock('node:os');
  vi.resetModules();
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

const REPO = '/tmp/repo';

describe('orchestrator turn durability + reattach', () => {
  it('routes undo-send through the WebSocket entry point into durable transcript truncation', async () => {
    const serverSource = readFileSync(join(process.cwd(), 'src/ws-server.ts'), 'utf-8');
    expect(serverSource).toContain("case 'orchestrator-undo-send':");
    expect(serverSource).toContain('truncateMobileOrchestratorThreadFromMessage({');

    const history = await loadHistory();
    const threadId = 'thoughts-undo-reachability';
    history.appendMobileOrchestratorUserMessage({
      tabId: threadId,
      repoPath: REPO,
      message: 'keep',
      messageId: 'orch-user-keep',
      backend: 'codex',
      timestampMs: 1000,
    });
    history.appendMobileOrchestratorUserMessage({
      tabId: threadId,
      repoPath: REPO,
      message: 'undo me',
      messageId: 'orch-user-orch-send-undo',
      backend: 'codex',
      timestampMs: 2000,
    });
    history.upsertMobileOrchestratorAssistantMessage({
      tabId: threadId,
      repoPath: REPO,
      messageId: 'assistant-2000',
      content: 'partial',
      backend: 'codex',
      timestampMs: 2001,
    });
    history.truncateMobileOrchestratorThreadFromMessage({
      tabId: threadId,
      messageId: 'orch-user-orch-send-undo',
    });

    expect(history.readOrchestratorThreadMessages(threadId)).toEqual([
      { role: 'user', content: 'keep' },
    ]);
  });

  it('assistant text keeps persisting and the replay buffer serves a reattaching client after the origin client disconnects', async () => {
    const history = await loadHistory();
    const replay = new OrchestratorReplayBuffers();
    const threadId = 'thoughts-durable-1';
    const sessionName = 'orch::codex::thoughts-durable-1';

    // Turn starts: user message persisted, busy recorded (a busy status starts
    // the replay buffer fresh, per the buffer's turn-boundary contract).
    history.appendMobileOrchestratorUserMessage({ tabId: threadId, repoPath: REPO, message: 'summarize the diff', backend: 'codex', timestampMs: 1000 });
    replay.record(sessionName, { channel: 'orchestrator', event: 'status', data: { status: 'busy', threadId, backend: 'codex' } });

    // Stream tokens; persist incrementally, exactly as handleOrchestratorSendMsgOnce does.
    let accum = '';
    for (const tok of ['The diff ', 'bounds ', 'the transport.']) {
      accum += tok;
      replay.record(sessionName, { channel: 'orchestrator', event: 'output', data: { text: tok, threadId, backend: 'codex', assistantMessageId: 'assistant-1000' } });
      history.upsertMobileOrchestratorAssistantMessage({ tabId: threadId, repoPath: REPO, messageId: 'assistant-1000', content: accum, backend: 'codex', timestampMs: 1001 });
    }

    // === ORIGIN CLIENT DISCONNECTS mid-turn (no terminal 'ready' yet). ===
    // The server has no reference to the socket — it keeps persisting + buffering.
    accum += ' Done.';
    replay.record(sessionName, { channel: 'orchestrator', event: 'output', data: { text: ' Done.', threadId, backend: 'codex', assistantMessageId: 'assistant-1000' } });
    history.upsertMobileOrchestratorAssistantMessage({ tabId: threadId, repoPath: REPO, messageId: 'assistant-1000', content: accum, backend: 'codex', timestampMs: 1002 });

    // (a) chat-history kept accruing assistant text AFTER the disconnect.
    const persisted = history.readOrchestratorThreadMessages(threadId);
    expect(persisted.find((m) => m.role === 'assistant')?.content).toBe('The diff bounds the transport. Done.');

    // (b) a NEW subscriber (since:0) gets the busy snapshot + every replayed output.
    const replayed = replay.since(sessionName, 0)
      .map((raw) => JSON.parse(raw) as { event?: string; data?: { status?: string; text?: string } });
    expect(replayed[0]?.data?.status).toBe('busy'); // busy snapshot leads the reattach
    const streamedText = replayed.filter((e) => e.event === 'output').map((e) => e.data?.text).join('');
    expect(streamedText).toBe('The diff bounds the transport. Done.');
  });

  it('once the turn resolves (terminal ready) the buffer drops entries — a post-turn reattach relies on persisted history', async () => {
    const history = await loadHistory();
    const replay = new OrchestratorReplayBuffers();
    const threadId = 'thoughts-durable-2';
    const sessionName = 'orch::codex::thoughts-durable-2';

    history.appendMobileOrchestratorUserMessage({ tabId: threadId, repoPath: REPO, message: 'ship it', backend: 'codex', timestampMs: 1000 });
    replay.record(sessionName, { channel: 'orchestrator', event: 'status', data: { status: 'busy', threadId } });
    replay.record(sessionName, { channel: 'orchestrator', event: 'output', data: { text: 'shipped.', threadId, assistantMessageId: 'assistant-1000' } });
    history.upsertMobileOrchestratorAssistantMessage({ tabId: threadId, repoPath: REPO, messageId: 'assistant-1000', content: 'shipped.', backend: 'codex', timestampMs: 1001 });

    // Terminal ready — the buffer drops so a post-turn reattach doesn't double the reply.
    replay.record(sessionName, { channel: 'orchestrator', event: 'status', data: { status: 'ready', threadId } });
    expect(replay.since(sessionName, 0)).toEqual([]);

    // …but the persisted transcript still holds the full reply.
    expect(history.readOrchestratorThreadMessages(threadId).find((m) => m.role === 'assistant')?.content).toBe('shipped.');
  });
});
