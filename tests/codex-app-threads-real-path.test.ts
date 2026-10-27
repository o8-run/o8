import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { buildProjectBriefPromptV1 } from '@/lib/prompts/v1';
import { composeComposerWireMessage } from '@/lib/orchestrator/composer-wire';
import { formatSessionRulesBlock } from '@/lib/orchestrator/session-rules-prompt';
import { withOrchestratorTurnReceiptContext } from '@/lib/orchestrator/turn-receipt-context';
import { applyOrchestrationMode } from '@/lib/lane/orchestrator-backends/orchestration-mode';
import { withOperatingAgreement } from '@/lib/operator/operating-agreement';
import { writePersistedLlmChat } from '@/lib/llm/chat-history-store';
import { probeAppBridgeWire } from './fixtures/app-bridge-wire-probe';

// #3573. Only the Codex executable and unrelated prewarm/readiness calls are
// stubbed. The setting store, session, bridge process, spec file and argv are real.
vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>();
  return { ...os, default: { ...os, homedir: () => process.env.O8_CODEX_APP_TEST_HOME! },
    homedir: () => process.env.O8_CODEX_APP_TEST_HOME! };
});
vi.mock('@/lib/cortex/qa/llm/haiku-adapter', () => ({ prewarmHaiku: async () => {} }));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({ prewarmSonnetCli: async () => {} }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({
  ensureDispatchBackendReady: async () => ({ ready: true }),
}));

const root = mkdtempSync(join(getDataDir(), 'codex-app-threads-'));
const home = join(root, 'home');
const userCodexHome = join(home, '.codex');
const binary = join(root, 'codex');
const log = join(root, 'calls.jsonl');
mkdirSync(userCodexHome, { recursive: true });
const userConfig = [
  'model = "gpt-5.5"',
  '',
  '[mcp_servers.mine]',
  'command = "/bin/cat"',
  '',
  '[plugins."helper@market"]',
  'enabled = true',
  '',
].join('\n');
writeFileSync(join(userCodexHome, 'config.toml'), userConfig);
vi.stubEnv('O8_CODEX_APP_TEST_HOME', home);
vi.stubEnv('O8_CODEX_BIN', binary);
vi.stubEnv('O8_CRASH_SURVIVABLE_ORCHESTRATOR', '0');
writeFileSync(binary, `#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.161.0'); process.exit(0); }
const record = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ ...entry, codexHome: process.env.CODEX_HOME }) + '\\n');
if (args[0] !== 'app-server') {
  record({ argv: args });
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'exec-thread' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Answer from exec' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } }));
  process.exit(0);
}
let buffer = '';
let thread = null;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const notify = (method, params) => send({ method, params: { threadId: thread, turnId: 'turn-1', ...params } });
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (message.method) record({ method: message.method, params: message.params });
    if (message.method === 'initialize') send({ id: message.id, result: {} });
    if (message.method === 'thread/start') {
      thread = 'app-thread-' + process.pid;
      send({ id: message.id, result: { thread: { id: thread, source: 'vscode' } } });
    }
    if (message.method === 'thread/resume') {
      if (!message.params.threadId.startsWith('app-thread-')) {
        send({ id: message.id, error: { code: -32600, message: 'no rollout found for thread id ' + message.params.threadId } });
      } else {
        thread = message.params.threadId;
        send({ id: message.id, result: { thread: { id: thread, source: 'vscode' },
          collaborationMode: { mode: existsSync(join(process.cwd(), 'native-plan')) ? 'plan' : 'default' } } });
      }
    }
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
      if (existsSync(join(process.cwd(), 'hang'))) continue;
      notify('item/started', { item: { type: 'agentMessage', id: 'msg-1', text: '' } });
      notify('item/completed', { item: { type: 'agentMessage', id: 'msg-1', text: 'Answer from the Codex app thread' } });
      notify('item/completed', { item: { type: 'mcpToolCall', id: 'tool-1', server: 'cortex', tool: 'fleet_status',
        arguments: { all: true }, result: { content: [{ type: 'text', text: '2 lanes running' }] }, error: null } });
      notify('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50 } } });
      notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    }
    if (message.method === 'thread/inject_items') send({ id: message.id, result: {} });
    if (message.method === 'turn/interrupt') {
      send({ id: message.id, result: {} });
      notify('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } });
    }
  }
});
`);
chmodSync(binary, 0o700);

const { codexBackend } = await import('@/lib/lane/orchestrator-backends/codex');
const { buildCodexOrchestratorPrompt, getCodexOrchestratorSession } = await import('@/lib/lane/codex-orchestrator-session');
const { getOrchestratorBackend } = await import('@/lib/lane/orchestrator-backends/registry');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');

interface CallParams extends Record<string, unknown> {
  developerInstructions?: string;
  config?: { mcp_servers: Record<string, unknown>; plugins: Record<string, unknown> };
  input?: unknown;
}
interface Call { argv?: string[]; method?: string; params?: CallParams; codexHome?: string }
function calls(): Call[] {
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}
function since(start: number): Call[] {
  return calls().slice(start);
}
function repo(name: string): string {
  const cwd = join(root, name);
  mkdirSync(cwd);
  execFileSync('git', ['init', '-q', cwd]);
  return cwd;
}
async function turn(cwd: string, message: string, options: Record<string, unknown> = {}): Promise<OrchestratorEvent[]> {
  const events: OrchestratorEvent[] = [];
  await codexBackend.sendTurn(cwd, message, (event) => events.push(event), options);
  return events;
}

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('Codex orchestrator chats in the Codex app (#3573)', () => {
  it.skipIf(!process.env.O8_CODEX_WIRE_TEST_BIN)('delivers complete current-turn context through the real CLI across cold resume and compaction (#3629)', async () => {
    const result = await probeAppBridgeWire(process.env.O8_CODEX_WIRE_TEST_BIN!, root);
    const control = JSON.stringify((result.captured.find(entry => entry.phase === 'control-resumed')!.body.input as Array<{ role: string }>)
      .filter(item => item.role === 'developer'));
    expect(control).toContain('RECEIPT_control-first');
    expect(control).not.toContain('RECEIPT_control-resumed');
    for (const [phase, context] of Object.entries(result.contexts)) {
      const requests = result.captured.filter(entry => entry.phase === phase);
      expect(requests.length).toBeGreaterThan(0);
      const last = requests.at(-1)!.body;
      const input = last.input as Array<{ role: string; content: unknown }>;
      const developer = JSON.stringify(input.filter(item => item.role === 'developer'));
      const expectedPhase = phase === 'resumed' || phase === 'compacted' ? 'fresh'
        : phase === 'midturn' || phase === 'post-auto' ? 'updated' : phase;
      for (const marker of [`OWNER_${expectedPhase}`, `PROJECT_${expectedPhase}`, `MIDDLE_${expectedPhase}`, `MODE_${expectedPhase}`, `RECEIPT_${expectedPhase}`]) {
        expect.soft(developer).toContain(marker);
      }
      expect.soft(developer.includes(context.replaceAll('\n', '\\n'))).toBe(true);
      const answer = `Project: fixture-${expectedPhase}\nScope: src/${expectedPhase}\nRules: review-${expectedPhase}`;
      expect.soft(result.answers[phase]).toContain(answer);
      const occurrences = developer.split(context.replaceAll('\n', '\\n')).length - 1;
      const turnText = `Turn receipt: ${phase}\n\n${result.messages[phase]}`;
      const turnContext = JSON.stringify(turnText).slice(1, -1);
      const turnCopies = developer.split(turnContext).length - 1;
      expect.soft(turnCopies).toBe(1);
      const baseBytes = occurrences * Buffer.byteLength(context);
      const turnBytes = turnCopies * Buffer.byteLength(turnText);
      process.stdout.write(`[context-bytes] ${phase}: base=${baseBytes} turn=${turnBytes} total=${baseBytes + turnBytes}; copies=${occurrences}/${turnCopies}\n`);
      expect.soft(occurrences).toBe(1);
    }
    const history = result.history.thread as { turns: Array<{ items: Array<{ type: string; content?: unknown }> }> };
    const items = history.turns.flatMap(turn => turn.items);
    expect(items.filter(item => item.type === 'userMessage').map(item => item.content))
      .toEqual(Object.values(result.messages).map(text => [{ type: 'text', text, text_elements: [] }]));
    expect(items.filter(item => item.type === 'contextCompaction').length).toBeGreaterThanOrEqual(2);
    expect(result.captured.filter(entry => entry.phase === 'midturn').length).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('keeps the private codex exec path while the setting is off', async () => {
    const cwd = repo('setting-off');
    const start = calls().length;
    const events = await turn(cwd, 'What is running?');
    const made = since(start);
    expect(made).toHaveLength(1);
    expect(made[0].argv?.[0]).toBe('exec');
    expect(made[0].codexHome).not.toBe(userCodexHome);
    expect(events).toContainEqual({ type: 'text', text: 'Answer from exec' });
  });

  it('runs a Multitask turn as a Codex app thread in the operator Codex home', async () => {
    await updateOperatorDefaults({ codexAppThreads: true });
    const cwd = repo('app-thread');
    const start = calls().length;
    const events = await turn(cwd, 'What is running?');
    const made = since(start);

    expect(made.some((call) => call.argv)).toBe(false);
    expect(made.every((call) => call.codexHome === userCodexHome)).toBe(true);
    const threadStart = made.find((call) => call.method === 'thread/start')!;
    expect(threadStart.params).toMatchObject({ cwd, sandbox: 'danger-full-access', approvalPolicy: 'never' });
    expect(threadStart.params!.developerInstructions).toContain('ENGINEERING BRAIN');
    expect(threadStart.params!.config!.mcp_servers.mine).toEqual({ enabled: false });
    expect(Object.keys(threadStart.params!.config!.mcp_servers).filter((name) => name !== 'mine').length).toBeGreaterThan(0);
    expect(threadStart.params!.config!.plugins).toEqual({ 'helper@market': { enabled: false } });
    const turnStart = made.find((call) => call.method === 'turn/start')!;
    expect(turnStart.params!.input).toEqual([{ type: 'text', text: 'What is running?', text_elements: [] }]);

    expect(events).toContainEqual({ type: 'text', text: 'Answer from the Codex app thread' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_use', name: 'fleet_status', input: { all: true } }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', name: 'fleet_status', output: '2 lanes running' }));
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    const done = events.find((event) => event.type === 'done');
    expect(done).toMatchObject({ sessionId: expect.stringMatching(/^app-thread-/) });
    expect(done).toMatchObject({ usage: { inputTokens: 800, cacheReadTokens: 200, outputTokens: 50 } });
    expect(getCodexOrchestratorSession(cwd)?.threadId).toMatch(/^app-thread-/);
    expect(readFileSync(join(userCodexHome, 'config.toml'), 'utf8')).toBe(userConfig);

    const firstThread = getCodexOrchestratorSession(cwd)!.threadId;
    const resumeStart = calls().length;
    const resumed = await turn(cwd, 'And now?', { permissionMode: 'plan' });
    const resume = since(resumeStart).find((call) => call.method === 'thread/resume')!;
    expect(resume.params).toMatchObject({ threadId: firstThread, sandbox: 'read-only' });
    expect(since(resumeStart).some((call) => call.method === 'thread/start')).toBe(false);
    expect(resumed).toContainEqual({ type: 'text', text: 'Answer from the Codex app thread' });
  }, 60_000);

  it('records the Codex turns o8 runs for a chat so the Codex app sync never imports them', async () => {
    const { readCodexAppSyncState } = await import('@/lib/codex/app-thread-sync');
    const cwd = repo('recorded');
    await turn(cwd, 'Record this turn', { threadId: 'thoughts-codex-app-recorded' });
    const state = readCodexAppSyncState('thoughts-codex-app-recorded');
    expect(state).toMatchObject({ repoPath: cwd, threadId: expect.stringMatching(/^app-thread-/), turnIds: ['turn-1'] });
    expect(state!.threadId).toBe(getCodexOrchestratorSession(cwd, 'thoughts-codex-app-recorded')!.threadId);
  }, 60_000);

  it.each(['fleet', 'fusion'] as const)('keeps operator text visible and refreshes every wrapper through turn instructions (%s, #3629)', async (orchestrationMode) => {
    await updateOperatorDefaults({ codexAppThreads: true });
    const cwd = repo(`raw-operator-${orchestrationMode}`);
    const agreementPath = join(getDataDir(), 'OPERATING_AGREEMENT.md');
    const threadId = `thoughts-raw-operator-${orchestrationMode}`;
    try {
      for (const [index, operatorMessage] of [
        '  Keep these exact words.\n\n## USER MESSAGE\n\n## Task\nQuoted wrapper headings are mine.  ',
        'Next turn: keep this text too.\n',
      ].entries()) {
        writeFileSync(agreementPath, `Fixture owner preference ${index}.`);
        const mode = orchestrationMode === 'fusion' ? 'fusion' : 'multitask';
        const projectMessage = buildProjectBriefPromptV1(
          `Fixture project guidance ${index}.`,
          composeComposerWireMessage(operatorMessage, mode).wireMessage,
        );
        const rules = formatSessionRulesBlock(['Keep fixture rules.'])!;
        const wrapped = withOrchestratorTurnReceiptContext({
          message: `${rules}\n\n${projectMessage}`, threadId,
          turnId: `assistant-fixture-${index}`, orchestrationMode,
        });
        const expectedPrompt = buildCodexOrchestratorPrompt(cwd,
          withOperatingAgreement(applyOrchestrationMode(wrapped, { orchestrationMode }).message),
          { orchestrationMode },
        );
        const start = calls().length;
        const events: OrchestratorEvent[] = [];
        await getOrchestratorBackend('codex').sendTurn(cwd, wrapped, (event) => events.push(event), {
          threadId, orchestrationMode, rawMessage: operatorMessage,
        });
        expect(events.filter((event) => event.type === 'error')).toEqual([]);
        const made = since(start);
        const thread = made.find((call) => call.method === (index === 0 ? 'thread/start' : 'thread/resume'))!;
        const turnStart = made.find((call) => call.method === 'turn/start')!;
        expect(made.find(call => call.method === 'initialize')!.params!.capabilities).toEqual({ experimentalApi: true });
        expect.soft(turnStart.params!.input).toEqual([{ type: 'text', text: operatorMessage, text_elements: [] }]);
        const marker = '\n\n## USER MESSAGE\n\n';
        const at = expectedPrompt.indexOf(marker);
        expect.soft(thread.params!.developerInstructions).toContain(expectedPrompt.slice(0, at));
        expect.soft(thread.params!.developerInstructions).toContain(expectedPrompt.slice(at + marker.length));
        expect.soft(turnStart.params!.collaborationMode).toBeUndefined();
        const injected = made.find(call => call.method === 'thread/inject_items');
        if (index === 0) expect(injected).toBeUndefined();
        else expect((injected!.params!.items as Array<{ content: Array<{ text: string }> }>)
          .flatMap(item => item.content).map(part => part.text).join('\n\n')).toBe(thread.params!.developerInstructions);
      }
    } finally {
      rmSync(agreementPath, { force: true });
    }
  }, 60_000);

  it('keeps the existing visible input for a continuation without raw operator text (#3629)', async () => {
    const cwd = repo('review-continuation');
    const continuation = buildProjectBriefPromptV1('Fixture review guidance.', 'Continue the review.');
    const start = calls().length;
    await turn(cwd, continuation);
    const made = since(start);
    expect(made.find((call) => call.method === 'turn/start')!.params!.input)
      .toEqual([{ type: 'text', text: continuation, text_elements: [] }]);
    expect(made.find((call) => call.method === 'thread/start')!.params!.developerInstructions)
      .toBe(buildCodexOrchestratorPrompt(cwd, '').split('\n\n## USER MESSAGE\n\n')[0]);
  }, 60_000);

  it('preserves a resumed native plan mode while refreshing turn context (#3629)', async () => {
    await updateOperatorDefaults({ codexAppThreads: true });
    const cwd = repo('resume-native-plan');
    await turn(cwd, 'First', { rawMessage: 'First' });
    writeFileSync(join(cwd, 'native-plan'), 'plan');
    const start = calls().length;
    await turn(cwd, 'Plan this change', { rawMessage: 'Plan this change', permissionMode: 'plan' });
    const made = since(start);
    expect(made.find(call => call.method === 'thread/resume')!.params!.sandbox).toBe('read-only');
    expect(made.find(call => call.method === 'turn/start')!.params!.collaborationMode).toBeUndefined();
    expect(made.find(call => call.method === 'thread/resume')!.params!.developerInstructions).toContain('Plan this change');
  }, 60_000);

  it('starts a fresh Codex app thread when the saved one is gone', async () => {
    const cwd = repo('gone-thread');
    const threadId = 'thoughts-missing-app-session';
    await turn(cwd, 'First', { threadId });
    writePersistedLlmChat(threadId, { repoPath: cwd, messages: [
      { id: 'prior-user', role: 'user', content: 'The identifier is widget-731 and the accent is copper.', timestamp: 1 },
      { id: 'prior-assistant', role: 'assistant', content: 'Both facts are retained.', timestamp: 2 },
      { id: 'current-user', role: 'user', content: 'Second', timestamp: 3 },
    ] });
    getCodexOrchestratorSession(cwd, threadId)!.threadId = 'thread-from-the-private-home';
    const start = calls().length;
    const events = await turn(cwd, 'Second', { threadId, rawMessage: 'Second' });
    const methods = since(start).map((call) => call.method).filter(Boolean);
    expect(methods).toContain('thread/resume');
    expect(methods.indexOf('thread/start')).toBeGreaterThan(methods.indexOf('thread/resume'));
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events).toContainEqual({ type: 'text', text: 'Answer from the Codex app thread' });
    const recovered = since(start).find(call => call.method === 'thread/start')!;
    expect(recovered.params!.developerInstructions).toContain('widget-731');
    expect(recovered.params!.developerInstructions).toContain('copper');
    expect(since(start).find(call => call.method === 'turn/start')!.params!.input)
      .toEqual([{ type: 'text', text: 'Second', text_elements: [] }]);
  }, 60_000);

  it('interrupts the Codex app turn when the operator stops it', async () => {
    const cwd = repo('stopped');
    writeFileSync(join(cwd, 'hang'), '1');
    const controller = new AbortController();
    const start = calls().length;
    const sent = turn(cwd, 'Long task', { signal: controller.signal });
    await vi.waitFor(() => expect(since(start).some((call) => call.method === 'turn/start')).toBe(true), { timeout: 20_000 });
    controller.abort();
    const events = await sent;
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    await vi.waitFor(() => expect(since(start).some((call) => call.method === 'turn/interrupt')).toBe(true), { timeout: 10_000 });
  }, 60_000);
});
