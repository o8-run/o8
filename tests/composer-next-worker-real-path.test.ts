import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';
import type { MobileHistoryResponse } from '@/lib/mobile/types';

const token = 'fixture-next-worker-bearer';
const threadId = 'thoughts-composer-first';
let child: ChildProcessWithoutNullStreams;
let origin = '';
let repoPath = '';
let runtimeLog = '';
let socket: WebSocket;
const snapshots: string[] = [];
const payload = (text: string): ComposerQueuePayload => ({ text, wireMessage: text, images: [], routing: {
  backend: 'pi', model: 'pi', effort: 'adaptive', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false,
} });
async function api(path: string, method = 'GET', body?: unknown) {
  return fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function mutate(method: string, body: Record<string, unknown>) {
  const response = await api('/api/orchestrator/composer-queue', method, { repoPath, threadId, ...body });
  expect(response.status).toBe(200);
  return response.json();
}
async function history(): Promise<MobileHistoryResponse> {
  return (await api(`/api/mobile/history?sessionKey=llm-chat:${threadId}&limit=100`)).json();
}
async function queue() {
  return (await api(`/api/orchestrator/composer-queue?repoPath=${encodeURIComponent(repoPath)}&threadId=${threadId}&backend=pi`)).json();
}
beforeAll(async () => {
  child = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/dev-server.ts', '--composer', '--worker'], { stdio: 'pipe', env: { ...process.env, O8_NEXT_API_TOKEN: token } });
  // Keep fixture diagnostics private: they can contain disposable storage paths.
  child.stderr.resume();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Fixture worker host did not start')), 60_000);
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('Fixture worker host exited before readiness')); });
    let pending = '';
    child.stdout.on('data', bytes => {
      pending += String(bytes);
      const lines = pending.split('\n'); pending = lines.pop()!;
      for (const line of lines) {
        try { const ready = JSON.parse(line); if (ready.origin) { origin = ready.origin; runtimeLog = ready.runtimeLog; clearTimeout(timeout); resolve(); } } catch { /* server diagnostics */ }
      }
    });
  });
  const sessions = await (await api('/api/mobile/orchestrator/threads?limit=500')).json();
  const inventory = await (await api('/api/runtime/inventory?fresh=1')).json();
  expect(inventory.agents, 'the fixture must never discover installed provider sessions').toEqual([]);
  repoPath = sessions.threads.find((row: { id: string }) => row.id === threadId).repoPath;
  const context = await (await api(`/api/v2/chat-history?tabId=${threadId}`)).json();
  expect(context.messages.at(-1).receipt).toMatchObject({ effort: 'adaptive', effortSource: 'runtime-default' });
  const ws = await (await api('/api/panel/ws-info')).json();
  socket = new WebSocket(`ws://127.0.0.1:${ws.wsPort}/ws?token=${encodeURIComponent(ws.wsToken)}`);
  socket.on('error', () => {});
  socket.on('message', bytes => { snapshots.push(String(bytes)); });
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions: [{ stream: `session:llm-chat:${threadId}` }] }));
}, 70_000);
afterAll(async () => {
  socket?.terminate();
  if (child?.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  }
});

it('sends, steers, queues, promotes and removes through production session APIs and a running worker', async () => {
  child.stdin.write('queue-hold\n');
  await mutate('POST', { id: 'native-start', intent: 'steer-now', payload: payload('Start streaming') });
  await vi.waitFor(async () => {
    expect((await history()).transcript.some(row => row.role === 'assistant' && row.text.includes('Worker streaming')),
      'an idle send must start a real fixture worker and persist its streamed reply').toBe(true);
  }, { timeout: 15_000, interval: 50 });
  const executing = await api('/api/orchestrator/composer-queue', 'DELETE', { repoPath, threadId, id: 'native-start' });
  expect(executing.status, 'removal cannot stop work already admitted to the worker').toBe(409);
  await mutate('POST', { id: 'native-steer', intent: 'steer-now', payload: payload('Steered instruction') });
  await vi.waitFor(async () => expect((await queue()).items.find((row: { id: string }) => row.id === 'native-steer')?.status).toBe('applied'), { timeout: 15_000 });
  expect((await history()).transcript.filter(row => row.text === 'Steered instruction')).toHaveLength(1);
  await mutate('POST', { id: 'native-promote', intent: 'send-next', payload: payload('Promoted instruction') });
  await mutate('PATCH', { id: 'native-promote' });
  await vi.waitFor(async () => expect((await queue()).items.find((row: { id: string }) => row.id === 'native-promote')?.status).toBe('applied'), { timeout: 15_000 });
  await mutate('POST', { id: 'native-remove', intent: 'send-next', payload: payload('Removed instruction') });
  await mutate('DELETE', { id: 'native-remove' });
  await mutate('POST', { id: 'native-next', intent: 'send-next', payload: payload('Queued instruction') });
  expect((await queue()).items.find((row: { id: string }) => row.id === 'native-next')).toMatchObject({ status: 'queued', admittedAt: null });
  expect((await history()).transcript.some(row => row.text === 'Queued instruction')).toBe(false);
  // Fixture model release, outside the application protocol. No new server route.
  child.stdin.write('release\n');
  await vi.waitFor(() => expect(snapshots.some(frame => frame.includes('history.snapshot') && frame.includes('Queued worker pending.'))).toBe(true), { timeout: 15_000 });
  child.stdin.write('sync-hold\n');
  await vi.waitFor(() => expect(readFileSync(runtimeLog, 'utf8')).toContain('[fixture-history-read-held]'), { timeout: 10_000 });
  child.stdin.write('queue-complete\n');
  await vi.waitFor(async () => {
    const rows = (await history()).transcript;
    expect(rows.some(row => row.role === 'assistant' && row.text.includes('Worker received: Queued instruction'))).toBe(true);
    expect(rows.some(row => row.role === 'assistant' && row.text.includes('Steered instruction') && row.text.includes('Promoted instruction'))).toBe(true);
    expect(rows.some(row => row.text.includes('Removed instruction'))).toBe(false);
  }, { timeout: 30_000, interval: 100 });
  // Let the production terminal debounce run while the older HTTP read is held.
  await new Promise(resolve => setTimeout(resolve, 150));
  child.stdin.write('sync-release\n');
  await vi.waitFor(() => expect(snapshots.some(frame => frame.includes('history.snapshot') && frame.includes('Worker received: Queued instruction'))).toBe(true), { timeout: 10_000 });
  // Retry the exact saved identity after completion: no second worker turn or echo.
  const retries = await Promise.all(Array.from({ length: 3 }, () => mutate('POST', {
    id: 'native-next', intent: 'send-next', payload: payload('Queued instruction'),
  })));
  expect(retries.map(receipt => receipt.item)).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ id: 'native-next', status: 'applied' })));
  expect((await history()).transcript.filter(row => row.role === 'user' && row.text === 'Queued instruction')).toHaveLength(1);
  expect(readFileSync(runtimeLog, 'utf8').match(/\[fixture-queued-model-turn\]/g)).toHaveLength(1);
}, 70_000);

it('retains the real refusal for an unsupported concrete effort pin', async () => {
  const requested = payload('Unsupported effort fixture');
  requested.routing.effort = 'medium';
  await mutate('POST', { id: 'unsupported-effort', intent: 'send-next', payload: requested });
  await vi.waitFor(async () => {
    const item = (await queue()).items.find((row: { id: string }) => row.id === 'unsupported-effort');
    expect(item).toMatchObject({ status: 'held', payload: { routing: { effort: 'medium' } } });
    expect(item.reason).toContain('no verified mapping');
  }, { timeout: 15_000 });
  expect((await history()).transcript.find(row => row.id === 'assistant-queued-unsupported-effort')?.text ?? '').toBe('');
}, 20_000);
