/**
 * Scripted transport evidence only: real composer payload, WebSocket server,
 * Claude/Codex adapters, Git, history and governance stores. The CLI endpoints
 * speak deterministic stdio protocols; no hosted model or worker is dispatched.
 * A carried obligation/freshness observation is not ACT enforcement or proof
 * that a live model understood the packet. Intent admission is outside scope.
 */
import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HandoffPacket } from '@/lib/orchestrator/handoff-packet';

const root = mkdtempSync(join(tmpdir(), 'o8-handoff-transport-'));
const dataDir = join(root, 'data');
const repoPath = join(root, 'repo');
const capturePath = join(root, 'transport.jsonl');
const fakeCli = join(root, 'scripted-provider.mjs');
const loopbackOnly = join(root, 'loopback-listener.mjs');
const token = 'scripted-handoff-transport-token';
const sourceReply = 'Measured work is ready. Independent review remains pending; do not merge or reset retry counters.';
const receiverReply = 'Scripted receiver completed.';
const followupReply = 'Scripted same-backend continuation completed.';
mkdirSync(dataDir);
for (const [key, value] of Object.entries({
  O8_DATA_DIR: dataDir,
  CORTEX_IDE_DATA_DIR: dataDir,
  CORTEX_IDE_DB_PATH: join(dataDir, 'cortex-ide.db'),
})) vi.stubEnv(key, value);

const { buildOrchestratorSendPayload } = await import('@/components/desktop/thoughts/use-orchestrator-stream/send-payload');
const { mapHistoryMessagesToTranscript } = await import('@/components/desktop/thoughts/history-transcript');
const { readPersistedLlmChat } = await import('@/lib/llm/chat-history-store');
const { createLane, updateLane, getLane, getLaneEvents } = await import('@/lib/lane/registry');
const { createApproval, getApproval } = await import('@/lib/approvals/store');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { writeOrchestratorControlPlaneState, readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { readLaneCreationBaseCommit } = await import('@/lib/lane/creation-base');
const { inspectHandoffWorkspaceFreshness } = await import('@/lib/orchestrator/handoff-packet');
const { GET: historyGet } = await import('@/app/api/orchestrator/history/route');

interface WireEvent {
  event?: string;
  data?: Record<string, unknown>;
}
interface Capture { backend: 'claude' | 'codex'; prompt: string }
const sockets = new Set<WebSocket>();
let apiServer: Server;
let wsProcess: ChildProcess;
let wsPort = 0;
let serverOutput = '';
let childEnv: NodeJS.ProcessEnv;

function git(...args: string[]) {
  return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function waitFor(predicate: () => boolean, description: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (wsProcess && (wsProcess.exitCode !== null || wsProcess.signalCode !== null)) throw new Error(`WebSocket server exited: ${serverOutput.slice(-3_000)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}: ${serverOutput.slice(-1_000)}\n${serverOutput.split('\n').filter((line) => /handoff|orchestrator|[Ee]rror|codex/.test(line)).slice(-50).join('\n')}`);
}

function captures(): Capture[] {
  return existsSync(capturePath)
    ? readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
}

async function connect(threadId: string, backend: 'claude' | 'codex') {
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
  sockets.add(socket);
  const events: WireEvent[] = [];
  socket.on('message', (chunk) => events.push(JSON.parse(String(chunk))));
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'orchestrator-subscribe', repoPath, threadId, backend }));
  await waitFor(() => events.some((event) => event.event === 'status'), 'thread subscription');
  return { socket, events };
}

function send(socket: WebSocket, threadId: string, id: string, backend: 'claude' | 'codex', message: string, handoff = false) {
  socket.send(buildOrchestratorSendPayload({
    repoPath, threadId, clientMessageId: id,
    wireMessage: message, displayMessage: message,
    permissionMode: 'plan', orchestrationMode: 'fleet', pickedMode: 'multitask',
    model: backend === 'claude' ? 'claude-sonnet-4-6' : 'gpt-6.1-sol',
    backend, ...(handoff ? { handoffMode: 'handoff' as const } : {}),
  }));
}

async function expectReply(threadId: string, content: string) {
  try {
    await waitFor(() => readPersistedLlmChat(threadId)?.history.messages.some((message) => (
      message.role === 'assistant' && message.content === content
    )) ?? false, `persisted ${content}`);
  } catch (error) {
    throw new Error(`${String(error)}\nMessages: ${JSON.stringify(readPersistedLlmChat(threadId)?.history.messages.map(({ role, content }) => ({ role, content })))}\nCaptures: ${JSON.stringify(captures().map(({ backend, prompt }) => ({ backend, handoff: prompt.includes('<o8_handoff_packet>'), length: prompt.length })))}`);
  }
}

async function stopServer() {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  if (wsProcess && wsProcess.exitCode === null && wsProcess.signalCode === null) {
    const exited = once(wsProcess, 'exit');
    wsProcess.kill('SIGTERM');
    const stopped = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000))]);
    if (!stopped) { wsProcess.kill('SIGKILL'); await exited; }
  }
}

beforeAll(async () => {
  mkdirSync(repoPath);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Transport Fixture');
  git('config', 'user.email', 'transport@example.test');
  writeFileSync(join(repoPath, 'notes.txt'), 'base\n');
  git('add', 'notes.txt');
  git('commit', '-qm', 'fixture');
  writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, { mode: 0o600 });
  writeFileSync(join(dataDir, 'repos.json'), JSON.stringify({ version: 1, repos: [
    { id: 'transport-repo', name: 'repo', localPath: repoPath, addedAt: new Date().toISOString() },
  ] }));
  // The production adapters launch these real subprocesses. Only the provider
  // protocol is scripted; the handoff builder/send/store methods are not mocked.
  // Bake the fixture-owned capture path into the script: provider children
  // inherit only allowlisted environment names (#4585).
  writeFileSync(fakeCli, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-cli 0.130.0'); process.exit(0); }
const emit = (value) => console.log(JSON.stringify(value));
const capture = (backend, prompt) => appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ backend, prompt }) + '\\n');
if (process.argv.includes('--input-format')) {
  createInterface({ input: process.stdin }).on('line', (line) => {
    const content = JSON.parse(line).message?.content;
    const prompt = typeof content === 'string' ? content : JSON.stringify(content);
    capture('claude', prompt);
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: ${JSON.stringify(sourceReply)} }] } });
    emit({ type: 'result', subtype: 'success', result: ${JSON.stringify(sourceReply)}, is_error: false, usage: { input_tokens: 1, output_tokens: 1 } });
  });
} else if (process.argv.includes('--output-format')) {
  emit({ type: 'result', subtype: 'success', result: 'Scripted context.', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } });
} else {
  const prompt = process.argv.join('\\n');
  capture('codex', prompt);
  emit({ type: 'thread.started', thread_id: 'scripted-codex-transport' });
  const text = prompt.includes('<o8_handoff_packet>') ? ${JSON.stringify(receiverReply)} : ${JSON.stringify(followupReply)};
  emit({ type: 'item.completed', item: { type: 'agent_message', text } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
}
`);
  chmodSync(fakeCli, 0o755);
  // The app normally accepts LAN clients. This fixture changes only the bind
  // address, keeping the real server/auth/turn handlers on an ephemeral loopback port.
  writeFileSync(loopbackOnly, `import { Server } from 'node:net';
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  if (args[1] === '0.0.0.0') args[1] = '127.0.0.1';
  return listen.apply(this, args);
};
`);
  apiServer = createServer(async (request, response) => {
    if (request.url?.startsWith('/api/orchestrator/history?')) {
      const result = await historyGet(new NextRequest(`http://127.0.0.1${request.url}`, {
        headers: { Authorization: `Bearer ${token}` },
      }));
      response.writeHead(result.status, { 'Content-Type': 'application/json' });
      response.end(await result.text());
      return;
    }
    const status = request.url === '/api/setup/identity' ? { configured: false } : { ready: true };
    response.writeHead(['/api/setup/identity', '/api/setup/status', '/api/panel/health'].includes(request.url ?? '') ? 200 : 404,
      { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(status));
  });
  apiServer.listen(0, '127.0.0.1');
  await once(apiServer, 'listening');
  const address = apiServer.address();
  if (!address || typeof address === 'string') throw new Error('Missing API port');
  const portProbe = createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const wsAddress = portProbe.address();
  if (!wsAddress || typeof wsAddress === 'string') throw new Error('Missing WebSocket port');
  wsPort = wsAddress.port;
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  const home = join(root, 'home');
  mkdirSync(home);
  // Allowlist, rather than inherit provider credentials or the operator's home.
  childEnv = {
    NODE_ENV: 'test', PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir,
    CORTEX_IDE_DB_PATH: join(dataDir, 'cortex-ide.db'),
    CORTEX_IDE_OWNED_CODEX_ROOT: join(root, 'owned-codex'),
    CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT: join(root, 'owned-claude'),
    O8_CODEX_BIN: fakeCli, O8_CLAUDE_CODE_BIN: fakeCli,
    O8_SUBSCRIPTION_PROFILE: 'both',
    ...(process.env.O8_TEST_FILE_MARKER ? { O8_TEST_FILE_MARKER: process.env.O8_TEST_FILE_MARKER } : {}),
    O8_API_PORT: String(address.port), O8_WS_PORT: String(wsPort),
    NEXT_ORIGIN: `http://127.0.0.1:${address.port}`,
  };
  writeFileSync(join(dataDir, 'api-port'), String(address.port));
  writeFileSync(join(dataDir, 'ws-port'), String(wsPort));
  wsProcess = execFile(process.execPath, ['--import', loopbackOnly, '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'src/ws-server.ts'], {
    cwd: process.cwd(), env: childEnv,
  });
  wsProcess.stdout?.on('data', (chunk) => { serverOutput += String(chunk); });
  wsProcess.stderr?.on('data', (chunk) => { serverOutput += String(chunk); });
  await waitFor(() => serverOutput.includes('WebSocket server listening'), 'WebSocket startup', 60_000);
}, 90_000);

afterAll(async () => {
  await stopServer();
  if (apiServer?.listening) {
    apiServer.closeAllConnections();
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  }
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('scripted cross-backend handoff through the production transport', () => {
  it('requires explicit handoff, delivers measured state once, and reloads the same unresolved obligations', async () => {
    const threadId = `thoughts-scripted-handoff-${Date.now()}`;
    const source = await connect(threadId, 'claude');
    send(source.socket, threadId, 'source-turn', 'claude', 'Measure this work and leave independent review pending.');
    await expectReply(threadId, sourceReply);

    const packetId = 'pkt-scripted-transport';
    const lane = createLane({ repoPath, worktreePath: repoPath, branch: 'main', runtime: 'codex', packetId,
      projectId: null });
    updateLane(lane.id, { status: 'awaiting_input' }, 'orchestrator', { reason: 'Independent review remains pending.' });
    const approval = createApproval({ projectId: null, source: 'runtime', runtime: 'codex', agent: 'fixture',
      sessionKey: 'scripted-governance-session', title: 'Independent review', risk: 'medium',
      description: 'Do not merge until independent review is complete.', summary: 'Unresolved review obligation.',
      metadata: { Lane: lane.id, Packet: packetId },
      continuation: { kind: 'lane', laneId: lane.id, verb: 'resume' } });
    const state = createEmptyOrchestratorMissionState();
    state.missionId = 'mission-scripted-transport';
    state.repoPath = repoPath;
    state.packets = [{ id: packetId, referenceLabel: 'P1', title: 'Preserve review', summary: 'Await review.',
      workspaceTargetPath: repoPath, branchTarget: 'main', runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [],
      queueState: 'held', releaseState: 'pending', status: 'running', attemptCount: 2, maxAttempts: 4,
      recoveryCount: 1, typecheckAutoRetries: 1, orchestratorThreadId: threadId }];
    writeOrchestratorControlPlaneState(state);
    writeFileSync(join(repoPath, 'notes.txt'), 'staged bytes\n');
    git('add', 'notes.txt');
    writeFileSync(join(repoPath, 'notes.txt'), 'unstaged bytes A\n');
    writeFileSync(join(repoPath, 'untracked.txt'), 'untracked bytes A\n');
    const indexBefore = readFileSync(join(repoPath, '.git', 'index'));
    const sourceHead = git('rev-parse', 'HEAD');
    expect(readLaneCreationBaseCommit(lane.id)).toBe(sourceHead);
    const beforeMessages = readPersistedLlmChat(threadId)!.history.messages;
    const receiver = await connect(threadId, 'codex');

    send(receiver.socket, threadId, 'unconfirmed-switch', 'codex', 'Continue after the switch.');
    await waitFor(() => receiver.events.some((event) => event.event === 'error'
      && event.data?.clientMessageId === 'unconfirmed-switch'), 'explicit handoff refusal');
    expect(receiver.events.find((event) => event.event === 'error')?.data?.error).toContain('Hand off');
    expect(receiver.events.some((event) => event.event === 'send-ack' && event.data?.clientMessageId === 'unconfirmed-switch')).toBe(false);
    expect(readPersistedLlmChat(threadId)!.history.messages).toEqual(beforeMessages);
    expect(captures().filter((entry) => entry.backend === 'codex')).toHaveLength(0);
    expect(getLaneEvents(lane.id, 100).filter((event) => event.verb === 'handoff')).toHaveLength(0);

    const operatorMessage = 'Continue the measured work, preserving the review obligation.';
    send(receiver.socket, threadId, 'accepted-switch', 'codex', operatorMessage, true);
    await expectReply(threadId, receiverReply);
    const received = captures().filter((entry) => entry.backend === 'codex');
    expect(received).toHaveLength(1);
    const prompt = received[0].prompt;
    const envelope = prompt.split('<o8_handoff_packet>')[1]?.split('</o8_handoff_packet>')[0];
    expect(envelope).toBeDefined();
    const packet = JSON.parse(envelope!.slice(envelope!.indexOf('{'))) as HandoffPacket;
    expect(packet).toMatchObject({ schema: 'o8/handoff.packet/v1', threadId,
      from: { backend: 'claude', model: 'claude-sonnet-4-6' }, to: { backend: 'codex', model: 'gpt-6.1-sol' },
      carries: { narrative: 'full', intent: 'omitted', workspace: 'full', governance: 'summary', provenance: 'summary' },
      intent: null, narrative: { compaction: null, compactedBy: null } });
    expect(packet.narrative.messages.map((message) => message.content)).toContain(sourceReply);
    expect(packet.narrative.messages.map((message) => message.content)).not.toContain(operatorMessage);
    expect(prompt.indexOf(operatorMessage)).toBeGreaterThan(prompt.indexOf('</o8_handoff_packet>'));
    expect(prompt).toContain('cold cross-backend continuation');
    expect(prompt).toContain('Omitted layers: intent.');
    expect(packet.workspace).toMatchObject({ repoPath, worktreePath: repoPath, branch: 'main', dirty: true,
      evidence: { laneId: lane.id, headSha: sourceHead, against: sourceHead,
        snapshotTreeHash: expect.stringMatching(/^[a-f0-9]{40}$/), diffFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(packet.workspace?.touchedFiles).toEqual(expect.arrayContaining(['notes.txt', 'untracked.txt']));
    expect(packet.governance).toMatchObject({
      packets: [expect.objectContaining({ packetId, laneId: lane.id, status: 'awaiting_input', attemptCount: 2, maxAttempts: 4 })],
      approvals: [expect.objectContaining({ id: approval.id, status: 'pending' })],
      laneStates: [expect.objectContaining({ laneId: lane.id, status: 'awaiting_input' })],
      retryBudget: { executionFailuresConsumed: 2, limit: 4,
        byPacket: [expect.objectContaining({ packetId, recoveryCount: 1, typecheckAutoRetries: 1 })] },
    });
    expect(await inspectHandoffWorkspaceFreshness(packet)).toMatchObject({ status: 'fresh', reason: 'snapshot-matched' });
    expect(readFileSync(join(repoPath, '.git', 'index'))).toEqual(indexBefore);
    expect(git('rev-parse', 'HEAD')).toBe(sourceHead);

    const messages = readPersistedLlmChat(threadId)!.history.messages;
    const seamIndex = messages.findIndex((message) => message.type === 'handoff');
    expect(messages.filter((message) => message.type === 'handoff')).toHaveLength(1);
    expect(messages[seamIndex]).toMatchObject({ id: packet.handoffId, role: 'system',
      handoff: { handoffId: packet.handoffId, lossless: false, packet } });
    expect(messages[seamIndex + 1]).toMatchObject({ role: 'user', content: operatorMessage });
    expect(mapHistoryMessagesToTranscript(messages).find((entry) => entry.type === 'handoff')?.handoff?.packet).toEqual(packet);
    const liveSeams = receiver.events.filter((event) => event.event === 'handoff');
    expect(liveSeams).toHaveLength(1);
    expect(liveSeams[0].data).toMatchObject({ handoffId: packet.handoffId, lossless: false, packet });
    expect(getLaneEvents(lane.id, 100).filter((event) => event.verb === 'handoff')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ handoffId: packet.handoffId, threadId, lossless: false }) }),
    ]);
    expect(getApproval(approval.id)?.status).toBe('pending');
    expect(getLane(lane.id)?.status).toBe('awaiting_input');
    expect(readOrchestratorControlPlaneState().packets.find((row) => row.id === packetId)).toMatchObject({ attemptCount: 2, maxAttempts: 4 });

    send(receiver.socket, threadId, 'same-backend-turn', 'codex', 'Continue on the same backend.');
    await expectReply(threadId, followupReply);
    const secondPrompt = captures().filter((entry) => entry.backend === 'codex')[1].prompt;
    expect(secondPrompt).not.toContain('<o8_handoff_packet>');
    expect(readPersistedLlmChat(threadId)!.history.messages.filter((message) => message.type === 'handoff')).toHaveLength(1);
    expect(getLaneEvents(lane.id, 100).filter((event) => event.verb === 'handoff')).toHaveLength(1);

    // Close the sending process, then reload through production readers and the
    // authenticated history route in a new process with no in-memory stores.
    await stopServer();
    const reloadPath = join(root, 'reloaded.json');
    execFileSync(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--input-type=module', '--eval', `
      import { writeFileSync } from 'node:fs';
      const { NextRequest } = await import('next/server.js');
      const history = (await import('./src/lib/llm/chat-history-store.ts')).default;
      const route = (await import('./src/app/api/orchestrator/history/route.ts')).default;
      const approvals = (await import('./src/lib/approvals/store.ts')).default;
      const lanes = (await import('./src/lib/lane/registry.ts')).default;
      const state = (await import('./src/lib/orchestrator/control-plane.ts')).default;
      const response = await route.GET(new NextRequest('http://127.0.0.1/api/orchestrator/history?threadId=' + process.env.O8_TEST_THREAD,
        { headers: { Authorization: 'Bearer ' + process.env.O8_TEST_TOKEN } }));
      writeFileSync(process.env.O8_TEST_RELOAD, JSON.stringify({ status: response.status, body: await response.json(),
        messages: history.readPersistedLlmChat(process.env.O8_TEST_THREAD).history.messages,
        approval: approvals.getApproval(process.env.O8_TEST_APPROVAL), lane: lanes.getLane(process.env.O8_TEST_LANE),
        packet: state.readOrchestratorControlPlaneState().packets.find((row) => row.id === process.env.O8_TEST_PACKET) }));
    `], { cwd: process.cwd(), timeout: 30_000, env: { ...childEnv, O8_TEST_THREAD: threadId, O8_TEST_TOKEN: token,
      O8_TEST_RELOAD: reloadPath, O8_TEST_APPROVAL: approval.id, O8_TEST_LANE: lane.id, O8_TEST_PACKET: packetId } });
    const reloaded = JSON.parse(readFileSync(reloadPath, 'utf8'));
    expect(reloaded).toMatchObject({ status: 200, approval: { status: 'pending' }, lane: { status: 'awaiting_input' },
      packet: { attemptCount: 2, maxAttempts: 4, recoveryCount: 1, typecheckAutoRetries: 1 } });
    expect(reloaded.messages.filter((message: { type?: string }) => message.type === 'handoff')).toEqual([
      expect.objectContaining({ handoff: expect.objectContaining({ packet, lossless: false }) }),
    ]);
    expect(reloaded.body.timeline.filter((entry: { kind: string }) => entry.kind === 'handoff')).toEqual([
      expect.objectContaining({ handoff: expect.objectContaining({ packet }),
        audits: [expect.objectContaining({ handoffId: packet.handoffId, laneId: lane.id, packetId })] }),
    ]);
  }, 90_000);
});
