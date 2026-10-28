/** Fixture model seam only. The Pi SDK child, session APIs, WS entry point and
 * queue admission/persistence all run production code. Never uses an account. */
import { join } from 'node:path';
import { Server } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { AssistantMessage } from '@earendil-works/pi-ai';

async function main() {
  const root = process.env.O8_NEXT_WORKER_ROOT;
  if (process.env.NODE_ENV !== 'test' || !root) throw new Error('An isolated fixture root is required');
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (this: Server, ...args: unknown[]) {
    if (typeof args[0] === 'number') {
      if (typeof args[1] === 'string') args[1] = '127.0.0.1'; else args.splice(1, 0, '127.0.0.1');
    }
    return Reflect.apply(listen, this, args);
  } as typeof listen;
  let released = false;
  let holdQueued = false;
  let queuedReleased = false;
  let holdSync = false;
  let releaseSync: (() => void) | null = null;
  process.stdin.setEncoding('utf8');
  let commands = '';
  process.stdin.on('data', input => {
    commands += String(input);
    const lines = commands.split(/\r?\n/); commands = lines.pop()!;
    for (const command of lines) {
      if (command === 'release') released = true;
      if (command === 'queue-hold') holdQueued = true;
      if (command === 'queue-complete') queuedReleased = true;
      if (command === 'sync-hold') holdSync = true;
      if (command === 'sync-release') releaseSync?.();
    }
  });
  // Delay one real sync response after its route has captured the old state.
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    if (holdSync && String(input).includes('/api/mobile/sync')) {
      holdSync = false;
      await new Promise<void>(resolve => { releaseSync = resolve; console.log('[fixture-history-read-held]'); });
      releaseSync = null;
    }
    return response;
  };
  const { createPiOrchestratorBackend } = await import('../../src/lib/lane/orchestrator-backends/pi');
  const { getOrchestratorBackend, withOrchestrationMode } = await import('../../src/lib/lane/orchestrator-backends/registry');
  const { O8_MANAGED_PI_MODEL } = await import('../../src/lib/pi/sdk/live-contract');
  const model = { ...O8_MANAGED_PI_MODEL, id: 'fixture-model', name: 'Fixture', provider: 'fixture' };
  const fixture = createPiOrchestratorBackend({ stateRoot: () => join(root, 'sdk'),
    resolveRoute: async () => ({ carrier: 'managed', model, label: 'Fixture' }),
    openServers: async () => ({ servers: [], close: async () => {} }),
    transport: async function* (context, signal) {
      const lastAssistant = context.messages.findLastIndex(row => row.role === 'assistant');
      const text = JSON.stringify(context.messages.slice(lastAssistant + 1).filter(row => row.role === 'user'));
      const words = ['Start streaming', 'Steered instruction', 'Promoted instruction', 'Queued instruction', 'Removed instruction', 'Idle message']
        .filter(word => text.includes(word)).join('; ');
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: '' }], stopReason: 'stop',
        model: model.id, api: model.api, provider: model.provider, timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      yield { type: 'start', partial: message };
      const append = (delta: string) => {
        const content = message.content[0];
        if (content.type === 'text') content.text += delta;
        return { type: 'text_delta' as const, contentIndex: 0, delta, partial: structuredClone(message) };
      };
      if (words.includes('Start streaming') && !released) {
        yield append('Worker streaming');
        // The owner releases this turn explicitly. A wall-clock completion
        // changes queue semantics on loaded hosts; abort and host cleanup bound it.
        for (let tick = 1; !released; tick++) {
          await delay(50, undefined, { signal });
          yield append(` ${tick}`);
        }
      } else {
        if (words.includes('Queued instruction')) {
          console.log('[fixture-queued-model-turn]');
          if (holdQueued) {
            yield append('Queued worker pending. ');
            while (!queuedReleased) await delay(10, undefined, { signal });
          }
        }
        const issueContext = text.includes('Linked GitHub issue #7 in fixture/alpha') && text.includes('Issue fixture context.');
        yield append(issueContext ? 'Linked issue context received' : `Worker received: ${words}`);
      }
      yield { type: 'done', reason: 'stop', message };
    } });
  Object.assign(getOrchestratorBackend('pi'), withOrchestrationMode(fixture));
  await import('../../src/ws-server');
}
void main().catch(error => { console.error('[o8-next-worker] Fixture runtime failed', error); process.exitCode = 1; });
