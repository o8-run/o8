/** Browser verbs over the already-owned native child pipe. No listener or page IPC. */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { ChildProcess } from '@/lib/providers/child-process';

type Pending = { resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout> };
type Bridge = { child: ChildProcess; pending: Map<string, Pending>; failed: boolean };
const runtime = globalThis as typeof globalThis & { __o8NextBrowserPipe?: Bridge };
const PREFIX = 'o8-next-browser-result:';
export const NEXT_BROWSER_VERBS = new Set(['read', 'localize', 'rect', 'click', 'type', 'probe', 'grab']);

export function bindNextBrowserPipe(child: ChildProcess): void {
  const bridge: Bridge = { child, pending: new Map(), failed: false };
  runtime.__o8NextBrowserPipe = bridge;
  const lines = createInterface({ input: child.stdout! });
  lines.on('line', (line) => {
    if (!line.startsWith(PREFIX)) return;
    try {
      const reply = JSON.parse(line.slice(PREFIX.length)) as { id?: string; result?: unknown };
      const pending = reply.id && bridge.pending.get(reply.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      bridge.pending.delete(reply.id!);
      pending.resolve(reply.result);
    } catch { /* A malformed/unknown receipt never matches a request. */ }
  });
  const unavailable = () => {
    bridge.failed = true;
    for (const pending of bridge.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: 'The o8 next Browser action was not confirmed', actionDispatched: null, automaticReplay: false });
    }
    bridge.pending.clear();
  };
  child.stdin?.on('error', unavailable);
  const closed = () => {
    unavailable();
    lines.close();
    if (runtime.__o8NextBrowserPipe === bridge) delete runtime.__o8NextBrowserPipe;
  };
  child.once('exit', closed);
  child.once('error', closed);
}

/** null means no owned Next window. Once dispatched, never fall back or replay. */
export function requestNextBrowser(verb: string, args: Record<string, unknown>): Promise<unknown> | null {
  const bridge = runtime.__o8NextBrowserPipe;
  if (!bridge || bridge.child.exitCode !== null || bridge.child.signalCode !== null) return null;
  if (!NEXT_BROWSER_VERBS.has(verb)) return null;
  if (bridge.failed) return Promise.resolve({ ok: false, error: 'The o8 next Browser pipe is unavailable', actionDispatched: false });
  if (bridge.pending.size >= 32) return Promise.resolve({ ok: false, error: 'Browser action queue is full', actionDispatched: false });
  const id = randomUUID();
  const frame = JSON.stringify({ type: 'browser-agent', id, verb, args, expiresAt: Date.now() + 7000 }) + '\n';
  if (Buffer.byteLength(frame) > 1024 * 1024) return Promise.resolve({ ok: false, error: 'Browser request exceeds 1 MiB', actionDispatched: false });
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      bridge.pending.delete(id);
      resolve({ ok: false, error: 'o8 next Browser action timed out', timedOut: true, actionDispatched: null, automaticReplay: false });
    }, 8000);
    bridge.pending.set(id, { resolve, timer });
    bridge.child.stdin?.write(frame, error => {
      if (!error || !bridge.pending.delete(id)) return;
      clearTimeout(timer);
      resolve({ ok: false, error: 'Could not confirm the Browser action', actionDispatched: null, automaticReplay: false });
    });
  });
}
