// Deliberately .ts under the root CommonJS package, like src/ws-server.ts.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createPiOrchestratorBackend } from '@/lib/lane/orchestrator-backends/pi';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { createManagedPiTransport } from '@/lib/pi/sdk/transport';
import { createOpenRouterPiTransport, openRouterPiModel, OpenRouterSpendCeiling } from '@/lib/pi/sdk/openrouter-transport';

async function main() {
  const pricing = { inputPerMillion: 0, outputPerMillion: 0 };
  const model = openRouterPiModel('fixture', pricing);
  let transportCalls = 0;
  const transport = createOpenRouterPiTransport({ model, pricing, ceiling: new OpenRouterSpendCeiling(1),
    resolveKey: async () => 'synthetic-fixture', fetch: async () => {
      transportCalls++;
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"Transport answer."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    } });
  const workspace = join(process.argv[2], 'workspace');
  await mkdir(workspace);
  const backend = createPiOrchestratorBackend({
    transport, resolveRoute: async () => ({ carrier: 'managed', model, label: 'Fixture' }),
    stateRoot: () => join(process.argv[2], 'lead'),
    openServers: async () => ({ servers: [], close: async () => {} }),
  });
  const events: OrchestratorEvent[] = [];
  try {
    await backend.sendTurn(workspace, 'Hello', event => events.push(event), { threadId: 'fixture', permissionMode: 'plan' });
    assert(!events.some(event => event.type === 'error'), JSON.stringify(events));
    assert(events.some(event => event.type === 'text' && event.text === 'Transport answer.'));
    assert.equal(events.at(-1)?.type, 'done');
  } finally { await backend.closeAll(); }
  assert.equal(typeof createManagedPiTransport, 'function');

  console.log(JSON.stringify({ transportCalls }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
