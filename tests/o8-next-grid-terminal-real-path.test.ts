import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import WebSocket from 'ws';

it('projects exact per-worker terminal bindings and attaches independent PTYs through production entry points', async () => {
  const child = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/grid-dev-server.ts', '--terminals'], {
    env: { ...process.env, O8_NEXT_API_TOKEN: 'fixture-grid-bearer' }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const sockets: WebSocket[] = [];
  try {
    let origin = '';
    for await (const line of createInterface({ input: child.stdout })) {
      try { origin = (JSON.parse(line) as { origin?: string }).origin ?? ''; } catch { /* startup log */ }
      if (origin) break;
    }
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const headers = { Authorization: 'Bearer fixture-grid-bearer' };
    const inventory = await (await fetch(`${origin}/api/runtime/inventory?fresh=1`, { headers })).json() as {
      agents: Array<{ sessionKey: string; tmuxSession?: string }>;
    };
    const workers = inventory.agents.filter(agent => agent.sessionKey.startsWith('pi-owned:grid-terminal-'));
    expect(workers, 'six runtime workers must expose exact terminal bindings').toHaveLength(6);
    expect(new Set(workers.map(worker => worker.tmuxSession)).size).toBe(6);
    const info = await (await fetch(`${origin}/api/panel/ws-info`, { headers })).json() as { wsPort: number; wsToken: string };
    await Promise.all(workers.map(async worker => {
      const history = await (await fetch(`${origin}/api/mobile/history?${new URLSearchParams({ sessionKey: worker.sessionKey })}`, { headers })).json() as {
        sessionKey: string; transcript: Array<{ text: string }>;
      };
      expect(history.sessionKey).toBe(worker.sessionKey);
      expect(history.transcript.some(entry => entry.text.includes(worker.sessionKey))).toBe(true);
      const ws = new WebSocket(`ws://127.0.0.1:${info.wsPort}/ws?token=${encodeURIComponent(info.wsToken)}`);
      sockets.push(ws);
      const checkpoint = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Missing production terminal resync')), 8000);
        let output = '';
        let ready = false;
        ws.on('message', bytes => {
          const frame = JSON.parse(String(bytes)) as { channel: string; event: string; data: { sessionName?: string; data?: string; epoch?: number } };
          if (frame.channel !== 'terminal' || frame.data.sessionName !== worker.tmuxSession) return;
          if (frame.event === 'data' || frame.event === 'resync') {
            output += Buffer.from(frame.data.data ?? '', 'base64').toString('utf8');
            // An initial replay may precede the child's first write. Observe
            // READY before asserting the contents of a fresh replay barrier.
            if (!ready && output.includes('READY')) {
              ready = true;
              ws.send(JSON.stringify({ type: 'terminal-visibility', sessionName: worker.tmuxSession, visible: true, epoch: 2, needsResync: true }));
            }
          }
          if (frame.event === 'resync' && frame.data.epoch === 2) {
            clearTimeout(timer); resolve(Buffer.from(frame.data.data ?? '', 'base64').toString('utf8'));
          }
        });
        ws.once('error', reject);
      });
      await once(ws, 'open');
      ws.send(JSON.stringify({ type: 'terminal-attach', sessionName: worker.tmuxSession, cols: 80, rows: 24 }));
      ws.send(JSON.stringify({ type: 'terminal-visibility', sessionName: worker.tmuxSession, visible: true, epoch: 1, needsResync: true }));
      expect(await checkpoint).toContain('READY');
    }));
  } finally {
    for (const ws of sockets) ws.terminate();
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  }
}, 40_000);
