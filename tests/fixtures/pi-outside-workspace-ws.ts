/** Test-only model transport; the WS server, Pi process, tools and persistence are real. */
import { Server } from 'node:net';
import { join } from 'node:path';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';

async function main() {
  const root = process.env.O8_TEST_PI_PERMISSION_ROOT;
  if (process.env.NODE_ENV !== 'test' || !root) throw new Error('This fixture requires an isolated test root.');
  // Bind the fixture's server to loopback, as the existing WS integration harness does.
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (this: Server, ...args: unknown[]) {
    if (typeof args[0] === 'number' && typeof args[1] !== 'string') args.splice(1, 0, '127.0.0.1');
    return Reflect.apply(listen, this, args);
  } as typeof listen;
  const { createPiOrchestratorBackend, piBackend } = await import('@/lib/lane/orchestrator-backends/pi');
  let step = 0;
  const backend = createPiOrchestratorBackend({ stateRoot: () => join(root, 'sdk'),
    openServers: async () => ({ servers: [], close: async () => {} }),
    transport: async function* () {
      const content: AssistantMessage['content'] = step++ % 2 === 0
        ? [{ type: 'toolCall', id: `write-${step}`, name: 'run_command',
          arguments: { command: `printf changed > '${join(root, 'outside.txt').replace(/'/g, "'\\''")}'` } }]
        : [{ type: 'text', text: 'Command inspected.' }];
      const message: AssistantMessage = { role: 'assistant', content,
        stopReason: content[0].type === 'toolCall' ? 'toolUse' : 'stop',
        model: 'fixture-model', provider: 'fixture', api: 'openai-completions', timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      yield { type: 'start', partial: message } as AssistantMessageEvent;
      yield { type: 'done', reason: message.stopReason, message } as AssistantMessageEvent;
    } });
  // Copy descriptors: liveSteer is a getter, which plain assignment cannot replace.
  Object.defineProperties(piBackend, Object.getOwnPropertyDescriptors(backend));
  await import('../../src/ws-server');
}

void main();
