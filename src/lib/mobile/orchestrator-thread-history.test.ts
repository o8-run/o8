import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPOSER_MODE_DIRECTIVES } from '@/lib/orchestrator/composer-wire';

const tempHomes: string[] = [];
const previousO8DataDir = process.env.O8_DATA_DIR;
const previousCortexDataDir = process.env.CORTEX_IDE_DATA_DIR;

async function loadHistoryModule() {
  const home = mkdtempSync(join(tmpdir(), 'o8-orch-history-'));
  tempHomes.push(home);
  process.env.O8_DATA_DIR = home;
  process.env.CORTEX_IDE_DATA_DIR = home;
  vi.resetModules();
  vi.doMock('node:os', async () => ({
    ...(await vi.importActual<typeof import('node:os')>('node:os')),
    homedir: () => home,
  }));
  return import('./orchestrator-thread-history');
}

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('node:os');
  vi.resetModules();
  if (previousO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = previousO8DataDir;
  if (previousCortexDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previousCortexDataDir;
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('orchestrator thread history persistence', () => {
  it('titles a server-saved thread once it has an exchange, without a client POST', async () => {
    const history = await loadHistoryModule();
    // No title, as the mobile client creates it: the file holds "New chat".
    const thread = history.createMobileOrchestratorThread({ repoPath: '/tmp/repo' });
    history.appendMobileOrchestratorUserMessage({
      tabId: thread.id, repoPath: '/tmp/repo', message: 'Fix the login redirect loop', backend: 'codex', timestampMs: 1_000,
    });
    history.upsertMobileOrchestratorAssistantMessage({
      tabId: thread.id, repoPath: '/tmp/repo', messageId: 'assistant-1', content: 'Fixed.', backend: 'codex', timestampMs: 1_001,
    });
    const file = history.safeOrchestratorHistoryPath(thread.id);
    // No OpenRouter key in the temp home: the code fallback names it.
    await vi.waitFor(() => expect(JSON.parse(readFileSync(file, 'utf8')).titleSource).toBe('code'));
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.title).not.toBe('New chat');
    expect(saved.messages).toHaveLength(2);
  });

  it('repairs persisted legacy history before first use while post-health startup is still pending', async () => {
    const history = await loadHistoryModule();
    mkdirSync(history.ORCHESTRATOR_HISTORY_DIR, { recursive: true });
    const file = history.safeOrchestratorHistoryPath('thoughts-first-use');
    writeFileSync(file, JSON.stringify({
      repoPath: join(process.env.O8_DATA_DIR!, 'repo'), backend: 'codex',
      messages: [
        { id: 'answer', role: 'assistant', content: 'answer', timestamp: 999 },
        { id: 'question', role: 'user', content: `${COMPOSER_MODE_DIRECTIVES.solo}\n\nquestion`, timestamp: 1_000 },
      ],
    }));
    expect(history.readOrchestratorThreadMessages('thoughts-first-use')).toEqual([
      { role: 'user', content: 'question' }, { role: 'assistant', content: 'answer' },
    ]);
    expect(JSON.parse(readFileSync(file, 'utf8')).messages.map((message: { role: string }) => message.role))
      .toEqual(['user', 'assistant']);
  });

  it('repairs exact legacy composer preambles in bubbles and auto-derived titles', async () => {
    const history = await loadHistoryModule();
    const thread = history.createMobileOrchestratorThread({
      repoPath: '/tmp/repo',
      title: '[Mode: Solo] Work directly in this session',
    });
    history.appendMobileOrchestratorUserMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      message: `${COMPOSER_MODE_DIRECTIVES.solo}\n\nFix the title source`,
      backend: 'codex',
      timestampMs: 1_000,
    });

    // Simulate an install whose legacy history predates the repair marker.
    rmSync(join(process.env.O8_DATA_DIR!, '.composer-preamble-repaired-v1'), { force: true });
    history.repairComposerPreamblePollution();

    const persisted = JSON.parse(
      readFileSync(history.safeOrchestratorHistoryPath(thread.id), 'utf-8'),
    ) as {
      title?: string;
      titleSource?: string;
      messages: Array<{ role?: string; content?: string }>;
    };
    expect(persisted.messages.find((message) => message.role === 'user')?.content)
      .toBe('Fix the title source');
    expect(persisted.title).toBe('Fix the title source');
    expect(persisted.titleSource).toBe('code');
  });

  it('can pair a streamed assistant message with the exact persisted user timestamp', async () => {
    const history = await loadHistoryModule();
    const thread = history.createMobileOrchestratorThread({ repoPath: '/tmp/repo' });

    history.appendMobileOrchestratorUserMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      message: 'hello',
      backend: 'codex',
      timestampMs: 1234,
    });
    history.upsertMobileOrchestratorAssistantMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      messageId: 'assistant-1234',
      content: 'hi',
      backend: 'codex',
      timestampMs: 1234,
    });

    const persisted = JSON.parse(readFileSync(history.safeOrchestratorHistoryPath(thread.id), 'utf-8'));
    expect(persisted.messages.map((message: { id?: string }) => message.id)).toEqual([
      'user-1234',
      'assistant-1234',
    ]);
  });

  it('consumes a worker buffered before the assistant receipt exists', async () => {
    const history = await loadHistoryModule();
    const receiptStore = await import('./orchestrator-turn-receipt');
    const chatStore = await import('@/lib/llm/chat-history-store');
    const thread = history.createMobileOrchestratorThread({ repoPath: '/tmp/repo' });
    history.appendMobileOrchestratorUserMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      message: 'dispatch first',
      backend: 'codex',
      timestampMs: 1_500,
    });

    expect(receiptStore.appendMobileOrchestratorTurnWorker({
      tabId: thread.id,
      messageId: 'assistant-1500',
      worker: { packetId: 'packet-early', runtime: 'codex', model: 'gpt-5.6-terra' },
    })).toBe(true);
    expect(chatStore.readPersistedLlmChat(thread.id)?.history.pendingTurnWorkers).toEqual({
      'assistant-1500': [
        { packetId: 'packet-early', runtime: 'codex', model: 'gpt-5.6-terra' },
      ],
    });
    const beforeClientWrite = chatStore.readPersistedLlmChat(thread.id)?.history;
    chatStore.writePersistedLlmChat(thread.id, { messages: beforeClientWrite?.messages ?? [] });
    expect(chatStore.readPersistedLlmChat(thread.id)?.history.pendingTurnWorkers).toEqual({
      'assistant-1500': [
        { packetId: 'packet-early', runtime: 'codex', model: 'gpt-5.6-terra' },
      ],
    });

    history.upsertMobileOrchestratorAssistantMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      messageId: 'assistant-1500',
      content: 'done',
      backend: 'codex',
      receipt: { leadModel: 'gpt-5.6-sol', effort: 'high', mode: 'multitask' },
      timestampMs: 1_501,
    });

    const persisted = chatStore.readPersistedLlmChat(thread.id)?.history;
    expect(persisted?.pendingTurnWorkers).toBeUndefined();
    expect(chatStore.mapLlmHistoryToMobileTranscript(persisted?.messages ?? [])[1]?.receipt?.workers).toEqual([
      { packetId: 'packet-early', runtime: 'codex', model: 'gpt-5.6-terra' },
    ]);
  });

  it('projects pending workers at read time when a late buffer survives beside a receipt', async () => {
    await loadHistoryModule();
    const chatStore = await import('@/lib/llm/chat-history-store');
    const worker = { packetId: 'packet-late', runtime: 'codex' as const, model: 'gpt-5.6-terra' };
    const transcript = chatStore.mapLlmHistoryToMobileTranscript([
      {
        id: 'assistant-late',
        role: 'assistant',
        content: 'done',
        timestamp: 1_600,
        receipt: { leadModel: 'gpt-5.6-sol', effort: 'high', mode: 'multitask' },
      },
    ], undefined, { 'assistant-late': [worker] });

    expect(transcript[0]?.receipt?.workers).toEqual([worker]);
  });

  it('persists terminal cache and cost truth onto the streamed assistant message', async () => {
    const history = await loadHistoryModule();
    const thread = history.createMobileOrchestratorThread({ repoPath: '/tmp/repo' });
    history.appendMobileOrchestratorUserMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      message: 'measure this turn',
      backend: 'claude',
      timestampMs: 2_000,
    });
    history.upsertMobileOrchestratorAssistantMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      messageId: 'assistant-2000',
      content: 'done',
      backend: 'claude',
      tokens: { input: 203, output: 11, cacheRead: 40_448, cacheWrite: 0 },
      timestampMs: 2_001,
    });

    const persisted = JSON.parse(readFileSync(history.safeOrchestratorHistoryPath(thread.id), 'utf-8')) as {
      messages: Array<{ id?: string; tokens?: unknown }>;
    };
    expect(persisted.messages.find((message) => message.id === 'assistant-2000')).toMatchObject({
      tokens: { input: 203, output: 11, cacheRead: 40_448, cacheWrite: 0 },
    });
  });

  it('rewinds an undone turn from its exact client message id', async () => {
    const history = await loadHistoryModule();
    const thread = history.createMobileOrchestratorThread({ repoPath: '/tmp/repo' });

    history.appendMobileOrchestratorUserMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      message: 'keep this turn',
      messageId: 'orch-user-send-1',
      backend: 'codex',
      timestampMs: 1000,
    });
    history.upsertMobileOrchestratorAssistantMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      messageId: 'assistant-1000',
      content: 'kept',
      backend: 'codex',
      timestampMs: 1001,
    });
    history.appendMobileOrchestratorUserMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      message: 'undo this turn',
      messageId: 'orch-user-send-2',
      backend: 'codex',
      timestampMs: 2000,
    });
    history.upsertMobileOrchestratorAssistantMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      messageId: 'assistant-2000',
      content: 'partial response',
      backend: 'codex',
      timestampMs: 2001,
    });

    history.truncateMobileOrchestratorThreadFromMessage({
      tabId: thread.id,
      messageId: 'orch-user-send-2',
    });

    const persisted = JSON.parse(readFileSync(history.safeOrchestratorHistoryPath(thread.id), 'utf-8'));
    expect(persisted.messages.map((message: { id?: string }) => message.id)).toEqual([
      'orch-user-send-1',
      'assistant-1000',
    ]);
  });

  it('reuses cached parses until the history file mtime or size changes', async () => {
    const history = await loadHistoryModule();
    const thread = history.createMobileOrchestratorThread({ repoPath: '/tmp/repo', title: 'Alpha' });
    const filePath = history.safeOrchestratorHistoryPath(thread.id);
    const cachedAtSeconds = Math.floor(statSync(filePath).mtimeMs / 1000) - 1;
    utimesSync(filePath, cachedAtSeconds, cachedAtSeconds);

    expect(history.listMobileOrchestratorThreads()[0]?.title).toBe('Alpha');
    const raw = readFileSync(filePath, 'utf-8');
    writeFileSync(filePath, raw.replace('"Alpha"', '"Bravo"'));
    utimesSync(filePath, cachedAtSeconds, cachedAtSeconds);

    expect(history.listMobileOrchestratorThreads()[0]?.title).toBe('Alpha');
    writeFileSync(filePath, raw.replace('"Alpha"', '"Charlie"'));

    expect(history.listMobileOrchestratorThreads()[0]?.title).toBe('Charlie');
  });

  it('uses a human-readable fallback without deriving an orchestrator title from prompt text', async () => {
    const history = await loadHistoryModule();
    const tabId = 'thoughts-1783108800000';

    history.appendMobileOrchestratorUserMessage({
      tabId,
      repoPath: '/tmp/repo',
      message: 'The hygiene packet is awaiting review. Review the diff properly.',
      backend: 'codex',
      timestampMs: new Date('2026-07-07T21:29:00.000Z').getTime(),
    });

    const listed = history.listMobileOrchestratorThreads()[0];
    expect(listed?.title).toBe('Untitled conversation');
    expect(listed?.title).not.toContain('hygiene packet');
  });

  it('does not turn a normal message append into a fresh reveal request', async () => {
    const history = await loadHistoryModule();
    const thread = history.createMobileOrchestratorThread({ repoPath: '/tmp/repo', reveal: false });

    history.appendMobileOrchestratorUserMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      message: 'keep this thread quiet',
      backend: 'codex',
      timestampMs: new Date('2026-07-07T21:29:00.000Z').getTime(),
    });

    expect(history.listMobileOrchestratorRevealRequests('2026-07-07T00:00:00.000Z')).toEqual([]);
  });

  it('persists OpenClaw agent ids on projected mobile thread rows', async () => {
    const history = await loadHistoryModule();
    const thread = history.createMobileOrchestratorThread({
      repoPath: '/tmp/repo',
      backend: 'openclaw',
      agent: 'main',
    });

    history.appendMobileOrchestratorUserMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      message: 'hello mister',
      backend: 'openclaw',
      agent: 'main',
      timestampMs: new Date('2026-07-07T21:29:00.000Z').getTime(),
    });

    const listed = history.listMobileOrchestratorThreads({ backend: 'openclaw' })[0];
    expect(listed?.backend).toBe('openclaw');
    expect(listed?.agent).toBe('main');
  });

  it('projects terminal OpenClaw failures as failed instead of permanently busy', async () => {
    const history = await loadHistoryModule();
    const thread = history.createMobileOrchestratorThread({
      repoPath: '/tmp/repo',
      backend: 'openclaw',
      agent: 'main',
    });

    history.appendMobileOrchestratorUserMessage({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      message: 'trigger gateway failure',
      backend: 'openclaw',
      agent: 'main',
      timestampMs: new Date('2026-07-07T21:29:00.000Z').getTime(),
    });
    expect(history.listMobileOrchestratorThreads({ backend: 'openclaw' })[0]?.status).toBe('busy');

    history.markMobileOrchestratorThreadFailed({
      tabId: thread.id,
      repoPath: '/tmp/repo',
      error: 'openclaw gateway exited or failed to spawn before becoming ready',
      backend: 'openclaw',
      agent: 'main',
      timestampMs: new Date('2026-07-07T21:29:01.000Z').getTime(),
    });

    const listed = history.listMobileOrchestratorThreads({ backend: 'openclaw' })[0];
    expect(listed?.status).toBe('failed');
    expect(listed?.agent).toBe('main');
  });

  it('async stat token matches the sync token across states', async () => {
    const history = await loadHistoryModule();

    // Empty history dir: both tokens agree.
    expect(await history.mobileOrchestratorThreadHistoryStatTokenAsync()).toBe(
      history.mobileOrchestratorThreadHistoryStatToken(),
    );

    const first = history.createMobileOrchestratorThread({ repoPath: '/tmp/repo', title: 'Alpha' });
    history.createMobileOrchestratorThread({ repoPath: '/tmp/repo', title: 'Bravo' });
    expect(await history.mobileOrchestratorThreadHistoryStatTokenAsync()).toBe(
      history.mobileOrchestratorThreadHistoryStatToken(),
    );

    // A file mutation must move both tokens in lockstep.
    const before = history.mobileOrchestratorThreadHistoryStatToken();
    const filePath = history.safeOrchestratorHistoryPath(first.id);
    const raw = readFileSync(filePath, 'utf-8');
    writeFileSync(filePath, raw.replace('"Alpha"', '"Charlie"'));
    const afterSync = history.mobileOrchestratorThreadHistoryStatToken();
    expect(afterSync).not.toBe(before);
    expect(await history.mobileOrchestratorThreadHistoryStatTokenAsync()).toBe(afterSync);
  });
});
