import net from 'node:net';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

export async function until(probe, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await sleep(100);
  }
  throw new Error('step timed out');
}

export function nativeEval(socketPath, code, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => finish(new Error('window timed out')), timeout);
    let buffer = '';
    const finish = (error, data) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(data);
    };
    socket.once('error', finish);
    socket.once('connect', () => {
      try {
        const authToken = readFileSync(`${socketPath}.token`, 'utf8').trim();
        socket.write(`${JSON.stringify({ id: randomUUID(), command: 'execute_js', authToken, payload: { window_label: 'main', code } })}\n`);
      } catch (error) { finish(error); }
    });
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
        if (!response.success) throw new Error('window unavailable');
        let data = response.data;
        if (data && typeof data === 'object' && 'result' in data) data = data.result;
        if (typeof data === 'string') data = JSON.parse(data);
        if (typeof data === 'string') data = JSON.parse(data);
        finish(null, data);
      } catch (error) { finish(error); }
    });
  });
}

export async function chatTurn({ port, token, repoPath, backend, timeout }) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  const threadId = `thoughts-smoke-${randomUUID()}`;
  const sentinel = `o8_smoke_${randomUUID()}`;
  const events = [];
  let failed = false;
  socket.on('error', () => { failed = true; });
  socket.on('message', raw => {
    try { const event = JSON.parse(String(raw)); if (event.channel === 'orchestrator' && event.data?.threadId === threadId) events.push(event); }
    catch { failed = true; }
  });
  try {
    await until(() => { if (failed) throw new Error('chat transport failed'); return socket.readyState === WebSocket.OPEN; }, timeout);
    socket.send(JSON.stringify({ type: 'orchestrator-subscribe', repoPath, threadId, backend }));
    await until(() => events.some(event => event.event === 'status' && event.data.snapshot), timeout);
    const start = events.length;
    const message = `Reply with exactly ${sentinel}. Do not use tools or change files.`;
    socket.send(JSON.stringify({ type: 'orchestrator-send', repoPath, threadId, backend, pinBackend: true,
      clientMessageId: randomUUID(), message, displayMessage: message, permissionMode: 'plan', orchestrationMode: 'fleet' }));
    await until(() => {
      const turn = events.slice(start);
      if (failed || turn.some(event => event.event === 'error')) throw new Error('chat failed');
      const output = turn.filter(event => event.event === 'output' && !event.data.thinking).map(event => event.data.text ?? '').join('');
      return output.trim() === sentinel && turn.some(event => event.event === 'status' && !event.data.snapshot
        && event.data.status === 'ready' && event.data.voiceTerminal?.outcome === 'completed');
    }, timeout);
  } finally { socket.terminate(); }
}

export async function workerDispatch({ apiPort, token, repoPath, runtime = 'codex', timeout }) {
  async function api(route, body) {
    const response = await fetch(`http://127.0.0.1:${apiPort}${route}`, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(timeout),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error('worker route failed');
    return response.json();
  }
  const sentinel = `o8_smoke_${randomUUID()}`;
  const launch = await api('/api/runtime/launch', { runtime, cwd: repoPath, repoPath,
    prompt: `Reply with exactly ${sentinel}. Do not use tools or change files.`,
    clientMutationId: randomUUID(), isolate: false, skipSetup: true, workMode: 'edit' });
  if (!launch.ok || !launch.surfaceId || launch.outcomeUnknown) throw new Error('worker launch unconfirmed');
  await until(async () => {
    const transcript = await api(`/api/runtime/transcript?sessionKey=${encodeURIComponent(launch.surfaceId)}&limit=20`);
    const inventory = await api('/api/runtime/inventory?fresh=1');
    const worker = inventory.agents?.find(agent => agent.sessionKey === launch.surfaceId);
    if (worker?.status === 'failed' || worker?.status === 'blocked') throw new Error('worker failed');
    return ['idle', 'completed', 'reviewing'].includes(worker?.status)
      && transcript.transcript?.some(entry => entry.role === 'assistant' && entry.text?.trim() === sentinel);
  }, timeout);
}
