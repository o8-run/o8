/**
 * #3408: the composer's "o8" choice runs on the built-in Pi orchestrator.
 *
 * Drives an o8 turn the way the composer and ws-server do: the o8 option from
 * the composer catalogue, the real send payload, the registered backend for the
 * payload's `backend`, and the ws-server send seam. Pi then runs for real (its
 * worker process, the managed transport, the real route resolver and a paid
 * entitlement file), with o8 commands over /api/mcp and approvals through the
 * real inbox route, all behind the real middleware gate. Only the relay is
 * scripted: its answers stand in for the managed model, so there is no network.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { buildPiWriteHelper } from './helpers/pi-write-helper';

vi.mock('@/lib/push/notify', () => ({ notifyApprovalCreated: vi.fn() }));
// The platform check Pi runs before it starts, with a switch to stand in for Windows.
const platform = vi.hoisted(() => ({ override: null as NodeJS.Platform | null }));
vi.mock('@/lib/pi/sdk/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pi/sdk/platform')>();
  return { ...actual, requirePiPlatform: (value?: NodeJS.Platform) => actual.requirePiPlatform(platform.override ?? value) };
});

const { getDataDir } = await import('@/lib/data-dir-migration');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { safeOrchestratorHistoryPath } = await import('@/lib/mobile/orchestrator-thread-history');
const { resetToolSpinePortIdentityForTests } = await import('@/lib/mcp/tool-spine/build');
const { getOrchestratorBackend } = await import('@/lib/lane/orchestrator-backends/registry');
const { isOrchestratorBackendId } = await import('@/lib/lane/orchestrator-backends/types');
const { piBackend } = await import('@/lib/lane/orchestrator-backends/pi');
const { sendOrchestratorBackendTurn } = await import('@/lib/lane/orchestrator-send-entry');
const { O8_MANAGED_PI_MODEL } = await import('@/lib/pi/sdk/live-contract');
const { COMPOSER_MODEL_GROUPS } = await import('@/components/desktop/thoughts/ModelThinkingChip');
const { buildOrchestratorSendPayload } = await import('@/components/desktop/thoughts/use-orchestrator-stream/send-payload');
const { appendMobileOrchestratorUserMessage, upsertMobileOrchestratorAssistantMessage } = await import('@/lib/mobile/orchestrator-thread-history');
const { readPersistedLlmChat } = await import('@/lib/llm/chat-history-store');
const { resolveTurnReceiptMode } = await import('@/lib/lane/orchestrator-send-entry');
const { withOrchestratorTurnReceiptContext } = await import('@/lib/orchestrator/turn-receipt-context');
const { createLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { resolveReviewChatOrigin } = await import('@/lib/orchestrator/review-continuation-origin');
const { runReviewChatContinuation } = await import('@/lib/ws-server/review-chat-continuation');
const { prepareOrchestratorTurn } = await import('@/components/desktop/thoughts/use-orchestrator-stream/turn-option-resolution');
type OrchestratorEvent = import('@/lib/lane/orchestrator-stream-events').OrchestratorEvent;

const RELAY = 'https://relay.test';
const saved = Object.fromEntries(['NEXT_ORIGIN', 'O8_API_PORT', 'O8_PROXY_URL', 'O8_PLAN', 'GOOGLE_AI_API_KEY',
  'OPENROUTER_API_KEY'].map(key => [key, process.env[key]]));
const networkFetch = globalThis.fetch;
let api: Server;
let origin = '';
let paidToken = '';
let root = '';

/** The scripted relay: every managed model call takes the next answer and is recorded. */
const relay = { answers: [] as Array<() => Response>, requests: [] as Array<{ auth: string | null; body: Record<string, unknown> }> };
function sse(chunks: unknown[]) {
  return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
}
const callTool = (id: string, name: string, args: Record<string, unknown>) => () => sse([{ choices: [{ delta: { tool_calls: [
  { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }]);
const say = (text: string) => () => sse([{ choices: [{ delta: { content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2 } }]);

beforeAll(async () => {
  buildPiWriteHelper();
  root = await realpath(await mkdtemp(join(tmpdir(), 'o8-model-pi-')));
  // A paid install: the managed route resolves from this entitlement file to the relay.
  const { privateKey, publicKey } = await generateKeyPair('EdDSA');
  process.env.O8_LICENSE_PUBKEY = await exportSPKI(publicKey);
  paidToken = await new SignJWT({ plan: 'pro' }).setProtectedHeader({ alg: 'EdDSA' }).setSubject('account-o8-model')
    .setIssuedAt().setExpirationTime('1h').sign(privateKey);
  await writeFile(join(getDataDir(), 'entitlement.json'), JSON.stringify({ plan: 'pro', status: 'active', licenseKey: paidToken }));
  process.env.O8_PROXY_URL = RELAY;
  for (const key of ['O8_PLAN', 'GOOGLE_AI_API_KEY', 'OPENROUTER_API_KEY']) delete process.env[key];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(RELAY)) return networkFetch(input, init);
    if (url !== `${RELAY}/v1/inference`) throw new Error(`Unexpected relay call: ${url}`);
    relay.requests.push({ auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) });
    const answer = relay.answers.shift();
    if (!answer) throw new Error('No scripted relay answer left');
    return answer();
  });

  getOrCreateWsToken();
  const { panelGateMiddleware } = await import('@/middleware');
  const routes: Record<string, Record<string, (request: NextRequest) => Promise<Response>>> = {
    '/api/mcp': await import('@/app/api/mcp/route') as never,
    '/api/orchestrator/create-mission': await import('@/app/api/orchestrator/create-mission/route') as never,
    '/api/panel/repos': await import('@/app/api/panel/repos/route') as never,
    '/api/panel/approvals': await import('@/app/api/panel/approvals/route') as never,
    '/api/v2/proxy/llm': await import('@/app/api/v2/proxy/llm/route') as never,
  };
  api = createServer(async (req, res) => {
    // The loopback Host gate compares the Host header with the URL's port.
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const handler = routes[url.pathname]?.[req.method ?? 'GET'];
    if (!handler) { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
    const gate = panelGateMiddleware(new NextRequest(url, { method: req.method, headers, body }));
    const response = gate.headers.get('x-middleware-next') === '1'
      ? await handler(new NextRequest(url, { method: req.method, headers, body }))
      : gate;
    res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') ?? 'application/json' })
      .end(await response.text());
  });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const { port } = api.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  process.env.NEXT_ORIGIN = origin;
  process.env.O8_API_PORT = String(port);
  await writeFile(join(getDataDir(), 'api-port'), String(port));
  resetToolSpinePortIdentityForTests();
}, 600_000);

afterAll(async () => {
  await piBackend.closeAll();
  vi.unstubAllGlobals();
  await new Promise(resolve => api.close(resolve));
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  delete process.env.O8_LICENSE_PUBKEY;
  resetToolSpinePortIdentityForTests();
  await rm(root, { recursive: true, force: true });
});

/**
 * The composer's o8 choice, sent the way the composer and ws-server send it. With a turn id the
 * turn also carries its receipt context and is persisted to the thread the way ws-server persists it.
 */
async function composerO8Turn(repo: string, text: string, threadId: string, turnId?: string) {
  const option = COMPOSER_MODEL_GROUPS.flatMap(group => group.options).find(entry => entry.label === 'o8');
  if (!option || option.backend === 'auto') throw new Error('The composer offers no o8 choice');
  const turn = prepareOrchestratorTurn(text, { backend: option.backend, model: option.model, thinkingEffort: 'low' });
  const wire = JSON.parse(buildOrchestratorSendPayload({
    repoPath: repo, threadId, clientMessageId: `${threadId}-client`, wireMessage: turn.wireMessage,
    displayMessage: turn.displayMessage, permissionMode: turn.permissionMode, orchestrationMode: turn.orchestrationMode,
    thinkingEffort: turn.thinkingEffort, model: turn.model, backend: turn.backend,
  })) as Record<string, unknown>;
  // ws-server's resolveMsgBackendId: an explicit, known `backend` picks the registered backend.
  if (!isOrchestratorBackendId(wire.backend)) throw new Error('The o8 choice sent no backend');
  const backend = getOrchestratorBackend(wire.backend);
  const events: OrchestratorEvent[] = [];
  const message = turnId ? withOrchestratorTurnReceiptContext({ message: String(wire.message), threadId, turnId }) : String(wire.message);
  if (turnId) appendMobileOrchestratorUserMessage({ tabId: threadId, repoPath: repo, message: text, backend: backend.id });
  await sendOrchestratorBackendTurn(backend, String(wire.repoPath), message, event => events.push(event), {
    permissionMode: wire.permissionMode as 'full', thinkingEffort: wire.thinkingEffort as 'low',
    model: String(wire.model), threadId,
  }, wire.orchestrationMode);
  const receipt = events.find((event): event is Extract<OrchestratorEvent, { type: 'turn_receipt' }> => event.type === 'turn_receipt');
  if (turnId && receipt) {
    upsertMobileOrchestratorAssistantMessage({ tabId: threadId, repoPath: repo, messageId: turnId, backend: backend.id,
      model: String(wire.model), content: events.filter(event => event.type === 'text').map(event => (event as { text: string }).text).join(''),
      receipt: { leadModel: receipt.leadModel, effort: receipt.effort, mode: resolveTurnReceiptMode(backend.id, wire.orchestrationMode) } });
  }
  return { backend, events };
}

/** The operator at the approval inbox: reads pending approvals and resolves each through the real route. */
function inbox(decide: (approval: { toolName?: string; command?: string }) => 'approve' | 'reject') {
  const seen: Array<{ toolName?: string; command?: string; runtime?: string; action: 'approve' | 'reject' }> = [];
  const headers = { Authorization: `Bearer ${getOrCreateWsToken()}`, 'Content-Type': 'application/json' };
  let running = true;
  const loop = (async () => {
    while (running) {
      const listed = await (await networkFetch(`${origin}/api/panel/approvals`, { headers })).json() as {
        approvals: Array<{ id: string; toolName?: string; command?: string; runtime?: string }>;
      };
      for (const approval of listed.approvals.filter(entry => entry.runtime === 'pi')) {
        const action = decide(approval);
        seen.push({ toolName: approval.toolName, command: approval.command, runtime: approval.runtime, action });
        const resolved = await networkFetch(`${origin}/api/panel/approvals`, { method: 'POST', headers,
          body: JSON.stringify({ action, id: approval.id }) });
        expect(resolved.ok).toBe(true);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  })();
  return { seen, stop: async () => { running = false; await loop; } };
}

describe('the composer o8 model on the built-in Pi orchestrator (#3408)', () => {
  it('runs an o8 Full access turn on Pi without redundant command or edit approvals', async () => {
    const repo = join(root, 'repo');
    await mkdir(repo);
    relay.requests.length = 0;
    relay.answers.push(
      callTool('c1', 'o8_run', { name: 'o8_list_repos', arguments: '{}' }),
      callTool('c2', 'run_command', { command: 'touch ran-by-command.txt' }),
      callTool('c3', 'write_file', { path: 'notes.md', content: 'from the o8 model' }),
      say('Listed the repos, ran the command, and wrote notes.md.'),
    );
    const operator = inbox(() => 'reject');
    const { backend, events } = await composerO8Turn(repo, 'List the repos, run the setup command, then write notes.md',
      'thoughts-o8-model-pi');
    await operator.stop();

    expect(backend.id).toBe('o8');
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    // The turn reached Pi: its receipt, its o8 command catalogue, and the managed model on the paid token.
    expect(events[0]).toMatchObject({ type: 'turn_receipt', leadModel: 'o8-free' });
    expect(relay.requests).toHaveLength(4);
    for (const request of relay.requests) {
      expect(request.auth).toBe(`Bearer ${paidToken}`);
      expect(request.body.model).toBe(O8_MANAGED_PI_MODEL.id);
    }
    const offered = (relay.requests[0].body.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name);
    expect(offered).toEqual(expect.arrayContaining(['run_command', 'write_file', 'o8_commands', 'o8_command_help', 'o8_run']));
    const results = events.filter((event): event is Extract<OrchestratorEvent, { type: 'tool_result' }> => event.type === 'tool_result');
    expect(results.map(result => result.name)).toEqual(['o8_run', 'run_command', 'write_file']);
    // The o8 command ran through the operator server over /api/mcp.
    expect(JSON.parse(results[0].output)).toMatchObject({ count: expect.any(Number), repos: expect.any(Array) });
    // Full access authorizes routine tools without a second Inbox decision.
    // Gated approval and rejection are exercised by pi-sdk-worker-real-path.
    expect(operator.seen).toEqual([]);
    expect(results[1].isError).not.toBe(true);
    expect(existsSync(join(repo, 'ran-by-command.txt'))).toBe(true);
    // The approved edit landed.
    expect(results[2].output).toBe('Wrote notes.md');
    expect(await readFile(join(repo, 'notes.md'), 'utf8')).toBe('from the o8 model');
    expect(events.filter(event => event.type === 'text').map(event => (event as { text: string }).text).join(''))
      .toBe('Listed the repos, ran the command, and wrote notes.md.');
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  }, 300_000);

  it('carries an existing o8 thread\'s earlier turns into its first Pi turn, once', async () => {
    const repo = join(root, 'repo-existing-thread');
    await mkdir(repo);
    const threadId = 'thoughts-o8-model-existing';
    // A thread from the text-only rail, as ws-server persists it: the new message is already on disk.
    const history = [
      { id: 'u1', role: 'user', content: 'Remember that the release codename is BLUE-HERON.', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'Noted: the release codename is BLUE-HERON.', backend: 'o8', model: 'o8-free', timestamp: 2 },
      { id: 'u2', role: 'user', content: 'What is the release codename?', timestamp: 3 },
    ];
    const historyPath = safeOrchestratorHistoryPath(threadId);
    await mkdir(dirname(historyPath), { recursive: true });
    await writeFile(historyPath, JSON.stringify({ repoPath: repo, model: 'o8-free', backend: 'o8', savedAt: new Date().toISOString(), messages: history }));
    relay.requests.length = 0;
    relay.answers.push(say('It is BLUE-HERON.'));
    const first = await composerO8Turn(repo, 'What is the release codename?', threadId);
    expect(first.events.filter(event => event.type === 'error')).toEqual([]);
    expect(first.events[0]).toMatchObject({ type: 'turn_receipt', leadModel: 'o8-free' });
    const prompt = (request: { body: Record<string, unknown> }) => JSON.stringify(
      (request.body.messages as Array<{ role: string; content: unknown }>).filter(entry => entry.role === 'user').at(-1)?.content);
    const carried = prompt(relay.requests[0]);
    expect(carried).toContain('<o8_handoff_packet>');
    expect(carried).toContain('Remember that the release codename is BLUE-HERON.');
    expect(carried).toContain('Noted: the release codename is BLUE-HERON.');
    // The new message is the turn itself, not part of the carried history.
    expect(carried.split('What is the release codename?')).toHaveLength(2);

    // The next turn resumes the Pi session, so nothing is carried twice.
    history.push({ id: 'a2', role: 'assistant', content: 'It is BLUE-HERON.', backend: 'o8', model: 'o8-free', timestamp: 4 },
      { id: 'u3', role: 'user', content: 'Thanks.', timestamp: 5 });
    await writeFile(historyPath, JSON.stringify({ repoPath: repo, model: 'o8-free', backend: 'o8', savedAt: new Date().toISOString(), messages: history }));
    relay.answers.push(say('You are welcome.'));
    const second = await composerO8Turn(repo, 'Thanks.', threadId);
    expect(second.events.filter(event => event.type === 'error')).toEqual([]);
    expect(relay.requests).toHaveLength(2);
    expect(prompt(relay.requests[1])).not.toContain('<o8_handoff_packet>');
    expect(JSON.stringify(relay.requests[1].body.messages).split('<o8_handoff_packet>')).toHaveLength(2);
  }, 180_000);

  it('continues a mission dispatched from an o8 thread in that thread when it reaches review (#3410)', async () => {
    const repo = join(root, 'repo-review');
    await mkdir(repo);
    for (const args of [['init', '-q', '-b', 'main'], ['commit', '-q', '--allow-empty', '-m', 'fixture']]) {
      execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=test@o8.test', ...args], { cwd: repo });
    }
    const threadId = 'thoughts-o8-model-review';
    const turnId = 'assistant-o8-dispatch';
    // The o8 turn prepares a mission from this thread through the o8 command set, carrying its turn ids.
    relay.requests.length = 0;
    relay.answers.push(
      callTool('d1', 'o8_run', { name: 'create_mission', arguments: JSON.stringify({ repoPath: repo, runtime: 'pi-builtin', dispatch: false,
        issues_inline: [{ title: 'Review fixture', body: 'Prepared only.' }], orchestratorThreadId: threadId, orchestratorTurnId: turnId }) }),
      say('Prepared the mission.'),
    );
    const dispatcher = inbox(() => 'approve');
    const dispatched = await composerO8Turn(repo, 'Prepare a mission for the review fixture', threadId, turnId);
    await dispatcher.stop();
    expect(dispatched.events.filter(event => event.type === 'error')).toEqual([]);
    expect(JSON.stringify(relay.requests[0].body.messages)).toContain(`orchestratorTurnId: \\"${turnId}\\"`);
    const created = dispatched.events.find((event): event is Extract<OrchestratorEvent, { type: 'tool_result' }> =>
      event.type === 'tool_result' && event.name === 'o8_run');
    expect(created?.isError).not.toBe(true);
    expect(created?.output).toMatch(/^\{/);
    const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    const packetId = readMissionRegistryEntry(JSON.parse(created!.output).missionId)!.mission.packets[0].id;

    // No worker runs here, so the packet's lane reaches review through the lane store.
    const row = createLane({ repoPath: repo, branch: 'o8/review-fixture', runtime: 'codex', packetId, label: 'Review fixture' });
    setLaneStatus(row.id, 'reviewing');
    const lane = { id: row.id, label: row.label, repoPath: repo, packetId };
    const resolution = resolveReviewChatOrigin(lane);
    expect(resolution).toEqual({ kind: 'bound', origin: { threadId, turnId, backend: 'o8', model: 'o8-free', effort: 'low', mode: 'fleet' } });
    if (resolution.kind !== 'bound') return;

    relay.answers.push(callTool('r1', 'write_file', { path: 'review.md', content: 'reviewed' }), say('Reviewed the packet.'));
    const reviewer = inbox(() => 'approve');
    await runReviewChatContinuation(lane, resolution.origin, '[FLEET] Lane reached review-ready', {
      registerAbort: () => () => {}, publish: () => {},
    });
    await reviewer.stop();
    // Review continuation uses Full access, matching the originating composer turn.
    expect(reviewer.seen).toEqual([]);
    expect(await readFile(join(repo, 'review.md'), 'utf8')).toBe('reviewed');
    const messages = readPersistedLlmChat(threadId)!.history.messages;
    expect(messages.at(-2)).toMatchObject({ role: 'user', content: '[FLEET] Lane reached review-ready' });
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', backend: 'o8', model: 'o8-free', content: 'Reviewed the packet.',
      receipt: { leadModel: 'o8-free', effort: 'low', mode: 'multitask' } });
    expect(getLaneEvents(lane.id).filter(event => event.payload.event === 'chat_review_continuation_claimed')).toHaveLength(1);
    // The thread stays bound for the packet's next review transition.
    expect(resolveReviewChatOrigin(lane)).toEqual(resolution);
  }, 300_000);

  it('falls back to an honest text-only reply where Pi cannot start', async () => {
    const repo = join(root, 'repo-windows');
    await mkdir(repo);
    relay.requests.length = 0;
    relay.answers.push(say('Here is a plan in text.'));
    platform.override = 'win32';
    try {
      const { backend, events } = await composerO8Turn(repo, 'Write notes.md', 'thoughts-o8-model-windows');
      expect(backend.id).toBe('o8');
      expect(events.filter(event => event.type === 'error')).toEqual([]);
      expect(events[0]).toMatchObject({ type: 'turn_receipt', leadModel: 'o8-free' });
      const text = events.filter(event => event.type === 'text').map(event => (event as { text: string }).text).join('');
      expect(text).toBe('o8\'s built-in agent runs on macOS and Linux, and Windows support is not available yet, so this reply '
        + 'is text only, without o8 commands, file edits or tools.\n\nHere is a plan in text.');
      expect(events.some(event => event.type === 'tool_use' || event.type === 'tool_result')).toBe(false);
      // One text-only model call through the operator rail on the managed route: no tools offered.
      expect(relay.requests).toHaveLength(1);
      expect(relay.requests[0].auth).toBe(`Bearer ${paidToken}`);
      expect(relay.requests[0].body).not.toHaveProperty('tools');
      expect(existsSync(join(repo, 'notes.md'))).toBe(false);
    } finally {
      platform.override = null;
    }
  }, 120_000);
});
