import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { codexAppBridgeLaunch } from '@/lib/codex/app-bridge-launch';
import { writeCodexAppBridgeSpec } from '@/lib/codex/app-bridge-spec';

type Json = Record<string, unknown>;
interface Captured { phase: string; body: Json }

/** A real CLI and production bridge, with every model response served on loopback. */
export async function probeAppBridgeWire(binary: string, root: string) {
  const home = join(root, 'wire-home');
  const cwd = join(root, 'wire-repo');
  mkdirSync(home);
  mkdirSync(cwd);
  let phase = 'fresh';
  let phaseRequests = 0;
  const captured: Captured[] = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as Json;
    captured.push({ phase, body });
    phaseRequests++;
    const tool = phase === 'midturn' && phaseRequests === 1;
    const id = `fixture-${captured.length}`;
    const item = tool ? { type: 'function_call', id, call_id: id, name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'printf fixture-tool', yield_time_ms: 1000 }) }
      : { type: 'message', id, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Fixture answer.' }] };
    const result = { id: `response-${id}`, object: 'response', status: 'completed', output: [item],
      usage: { input_tokens: tool ? 200_000 : 100, output_tokens: 5, total_tokens: tool ? 200_005 : 105 } };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: result },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  writeFileSync(join(home, 'config.toml'), [
    'model = "fixture-model"', 'model_provider = "fixture"',
    'model_context_window = 100000', 'model_auto_compact_token_limit = 50000',
    '[model_providers.fixture]', 'name = "fixture"',
    `base_url = "http://127.0.0.1:${address.port}/v1"`,
    'wire_api = "responses"', 'requires_openai_auth = false', '',
  ].join('\n'));
  const env = { ...process.env, CODEX_HOME: home };
  const bridge = codexAppBridgeLaunch();
  let threadId: string | null = null;
  const bridgeEvents: Json[] = [];
  const contexts: Record<string, string> = {};
  const messages: Record<string, string> = {};
  const runTurn = async (name: string, legacy = false) => {
    phase = name;
    phaseRequests = 0;
    const context = `[Owner operating agreement]\nOWNER_${name}\n`
      + `[Project brief]\nPROJECT_${name}\n${'padding '.repeat(4000)}`
      + `MIDDLE_${name}\n${'padding '.repeat(4000)}`
      + `\n[Mode directive]\nMODE_${name}\n[Turn receipt]\nRECEIPT_${name}`;
    const message = `  Operator ${name}: café \u{1F642}\n\n## USER MESSAGE\nThese are my words.  `;
    if (!legacy) { contexts[name] = context; messages[name] = message; }
    const spec = { codexBin: binary, cwd, threadId, developerInstructions: legacy ? context : null,
      ...(legacy ? {} : { turnDeveloperInstructions: context }), message, imagePaths: [], model: 'fixture-model',
      effort: 'low', serviceTier: null, sandbox: 'read-only' as const, config: {} };
    const specPath = writeCodexAppBridgeSpec(spec, root);
    const { stdout } = await promisify(execFile)(bridge.command, [...bridge.args, specPath], {
      env, cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    });
    const events = stdout.trim().split('\n').map(line => JSON.parse(line) as Json);
    bridgeEvents.push(...events);
    const started = events.find(event => event.type === 'thread.started');
    if (!started || typeof started.thread_id !== 'string') throw new Error('No bridge thread');
    threadId = started.thread_id;
  };
  const rpc = async (operation: (call: (method: string, params: Json) => Promise<Json>,
    wait: (method: string, after: number) => Promise<Json>, events: Json[]) => Promise<Json>) => {
    const child = spawn(binary, ['app-server'], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const events: Json[] = [];
    const pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout> }>();
    let sequence = 0;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      const message = JSON.parse(line) as Json;
      events.push(message);
      const waiter = pending.get(message.id as number);
      if (waiter) {
        pending.delete(message.id as number);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result as Json);
      }
    });
    const refusePending = (error: Error) => {
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
      pending.clear();
    };
    child.once('error', refusePending);
    child.once('exit', () => refusePending(new Error('Fixture RPC process exited')));
    child.stderr.resume();
    const call = (method: string, params: Json) => new Promise<Json>((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 20_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    const wait = async (method: string, after: number) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const found = events.slice(after).find(event => event.method === method);
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`No ${method} notification`);
    };
    try {
      await call('initialize', { clientInfo: { name: 'fixture', version: '1' } });
      child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
      return await operation(call, wait, events);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { child.kill('SIGKILL'); }, 1_000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
          child.kill('SIGTERM');
        });
      }
      lines.close();
    }
  };
  try {
    // Control: a new process resuming with changed thread instructions still
    // sends the first wrapper to the model. This is the old transport.
    await runTurn('control-first', true);
    await runTurn('control-resumed', true);
    threadId = null;
    await runTurn('fresh');
    await runTurn('resumed');
    phase = 'explicit-compaction';
    await rpc(async (call, wait, events) => {
      await call('thread/resume', { threadId });
      const after = events.length;
      await call('thread/compact/start', { threadId });
      // The completed compaction item is emitted before its turn completes.
      await wait('turn/completed', after);
      return {};
    });
    await runTurn('compacted');
    await runTurn('midturn');
    const history = await rpc(call => call('thread/read', { threadId, includeTurns: true }));
    return { captured, contexts, messages, history, bridgeEvents };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
