import { childDiagnostic } from '@/lib/providers/child-diagnostics';
import { assertMcpServers } from '@/lib/providers/mcp-config-policy';
import { withProviderStoreLock } from '@/lib/providers/store-lock';
import { childEnvironment } from '@/lib/providers/spawn-environment';
/**
 * Codex app-server bridge (#3573). Runs one orchestrator turn through
 * `codex app-server` in the operator's own Codex home and prints the same JSON
 * lines `codex exec --json` prints, so the orchestrator session parses, records
 * and recovers the turn exactly as it does for exec. A thread started this way
 * is recorded with an interactive source, so it appears in the Codex app.
 *
 * Usage: app-server-exec-bridge <spec.json>. The spec is deleted once read.
 * Exit 0 completed, 1 failed, 130 interrupted.
 */

import { spawn } from '@/lib/providers/child-process';
import { readFileSync, rmSync } from 'node:fs';
import type { CodexAppBridgeSpec } from './app-bridge-spec';

type Json = Record<string, unknown>;
class RpcRefusal extends Error {}
interface Usage { input_tokens: number; cached_input_tokens: number; output_tokens: number }

const STOP_GRACE_MS = 1_500;

function out(line: Json): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`${childDiagnostic(message)}\n`);
  process.exit(1);
}

function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toolOutput(item: Json): string {
  const error = asObject(item.error);
  if (error) return `Error: ${text(error.message)}`;
  const parts = Array.isArray(asObject(item.result)?.content) ? asObject(item.result)!.content as unknown[]
    : Array.isArray(item.contentItems) ? item.contentItems as unknown[] : [];
  return parts.map((part) => text(asObject(part)?.text)).filter(Boolean).join('\n');
}

/** Map one app-server item to the exec lines the orchestrator already parses. */
function emitItem(phase: 'started' | 'completed', item: Json): void {
  const id = text(item.id) || null;
  const type = text(item.type);
  if (type === 'userMessage' || type === 'hookPrompt') return;
  if (phase === 'started') {
    out({ type: 'item.started', item: { type, id } });
    return;
  }
  if (type === 'agentMessage') {
    out({ type: 'item.completed', item: { type: 'agent_message', id, text: text(item.text) } });
  } else if (type === 'reasoning') {
    const summary = Array.isArray(item.summary) ? (item.summary as unknown[]).map(text).filter(Boolean).join('\n') : '';
    if (summary) out({ type: 'response_item', payload: { type: 'reasoning', summary } });
  } else if (type === 'commandExecution') {
    out({ type: 'item.completed', item: { type: 'command_execution', id, command: text(item.command), output: text(item.aggregatedOutput) } });
  } else if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
    const name = text(item.tool) || 'tool';
    out({ type: 'item.completed', item: { type: 'tool_use', id, name, arguments: item.arguments ?? {} } });
    out({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, name, output: toolOutput(item) } });
  } else if (type === 'fileChange') {
    const files = Array.isArray(item.changes) ? (item.changes as unknown[]).map((change) => text(asObject(change)?.path)) : [];
    out({ type: 'item.completed', item: { type: 'tool_use', id, name: 'apply_patch', arguments: { files } } });
  } else if (type === 'webSearch') {
    out({ type: 'item.completed', item: { type: 'tool_use', id, name: 'web_search', arguments: { query: text(item.query) } } });
  } else {
    out({ type: 'item.completed', item: { type, id } });
  }
}

async function main(): Promise<void> {
  const specPath = process.argv[2];
  if (!specPath) fail('Codex app bridge: missing spec path');
  let raw = '';
  try {
    raw = readFileSync(specPath, 'utf8');
  } catch (error) {
    fail(`Codex app bridge: unreadable spec (${error instanceof Error ? error.message : String(error)})`);
  }
  rmSync(specPath, { force: true });
  let spec: CodexAppBridgeSpec;
  try {
    spec = JSON.parse(raw) as CodexAppBridgeSpec;
  } catch {
    fail('Codex app bridge: malformed spec');
  }

  withProviderStoreLock(() => assertMcpServers(spec.config?.mcp_servers));
  const child = spawn(spec.codexBin, ['app-server'], { cwd: spec.cwd, env: childEnvironment({ runtimeId: 'codex' }), stdio: ['pipe', 'pipe', 'pipe'] });
  let childStderr = '';
  child.stderr.on('data', (chunk: Buffer) => { childStderr = (childStderr + chunk.toString('utf8')).slice(-2_000); });

  const pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let finish: (code: number) => void = () => {};
  const finished = new Promise<number>((resolve) => { finish = resolve; });
  const usage: Usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };

  const send = (message: Json) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const call = (method: string, params: Json) => new Promise<Json>((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });

  // The parent owns durable admission. This bridge owns the native turn fence.
  process.on('message', (value: unknown) => {
    const message = asObject(value);
    if (message?.type !== 'codex.bridge.steer' || typeof message.id !== 'string') return;
    const reply = (result: Json) => process.send?.({ type: 'codex.bridge.steer.result', id: message.id, ...result });
    if (stopping || !threadId || !turnId || message.threadId !== threadId || message.expectedTurnId !== turnId) {
      reply({ accepted: false });
      return;
    }
    const expectedTurnId = turnId;
    void call('turn/steer', { threadId, expectedTurnId, input: message.input, clientUserMessageId: message.clientUserMessageId })
      .then(result => reply(text(result.turnId) === expectedTurnId ? { accepted: true } : { unconfirmed: true }))
      .catch((error: unknown) => reply(error instanceof RpcRefusal ? { accepted: false } : { unconfirmed: true }));
  });

  const onMessage = (message: Json) => {
    const method = text(message.method);
    if (typeof message.id === 'number' && !method) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      const error = asObject(message.error);
      if (error) waiter.reject(new RpcRefusal(text(error.message) || 'request failed'));
      else waiter.resolve(asObject(message.result) ?? {});
      return;
    }
    if (message.id !== undefined && method) {
      // The turn runs with approvals off. Anything that still asks is declined.
      send(method.endsWith('requestApproval')
        ? { id: message.id, result: { decision: 'decline' } }
        : { id: message.id, error: { code: -32601, message: 'o8 does not answer this request' } });
      return;
    }
    const params = asObject(message.params) ?? {};
    if (params.threadId !== undefined && params.threadId !== threadId) return;
    if (method === 'item/started' || method === 'item/completed') {
      const item = asObject(params.item);
      if (item) emitItem(method === 'item/started' ? 'started' : 'completed', item);
    } else if (method === 'turn/plan/updated') {
      out({ type: 'event_msg', payload: { type: 'plan_update', explanation: params.explanation ?? null, plan: params.plan ?? [] } });
    } else if (method === 'thread/tokenUsage/updated') {
      const tokenUsage = asObject(params.tokenUsage);
      const last = asObject(tokenUsage?.last);
      usage.input_tokens += Number(last?.inputTokens) || 0;
      usage.cached_input_tokens += Number(last?.cachedInputTokens) || 0;
      usage.output_tokens += Number(last?.outputTokens) || 0;
      // Preserve the latest request beside the billing rollup. App-server's
      // `last.inputTokens` includes cached input; `total` is cumulative usage.
      const toUsage = (value: Json | null) => value ? {
        input_tokens: value.inputTokens,
        cached_input_tokens: value.cachedInputTokens,
        output_tokens: value.outputTokens,
        total_tokens: value.totalTokens,
      } : null;
      out({ type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: toUsage(last),
        total_token_usage: toUsage(asObject(tokenUsage?.total)),
        model_context_window: tokenUsage?.modelContextWindow,
      } } });
    } else if (method === 'error') {
      if (params.willRetry !== true) out({ type: 'error', message: text(asObject(params.error)?.message) || 'Codex turn error' });
    } else if (method === 'turn/completed') {
      turnId = null;
      process.send?.({ type: 'codex.bridge.turn', threadId, turnId });
      const turn = asObject(params.turn) ?? {};
      const status = text(turn.status);
      if (status === 'completed') {
        out({ type: 'turn.completed', usage });
        finish(0);
      } else if (status === 'interrupted') {
        finish(130);
      } else {
        const message = childDiagnostic(text(asObject(turn.error)?.message) || `Codex turn ${status || 'failed'}`);
        out({ type: 'turn.failed', error: { message } });
        process.stderr.write(`${childDiagnostic(message)}\n`);
        finish(1);
      }
    }
  };

  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try { onMessage(JSON.parse(line) as Json); } catch { /* app-server prints only JSON-RPC on stdout */ }
    }
  });
  child.on('exit', (code, signal) => {
    for (const waiter of pending.values()) waiter.reject(new Error('codex app-server exited'));
    pending.clear();
    const tail = childDiagnostic(childStderr.trim().split(/\r?\n/).slice(-3).join('\n'));
    process.stderr.write(`codex app-server exited (${signal ?? code})${tail ? `: ${tail}` : ''}\n`);
    finish(1);
  });
  child.on('error', (error) => {
    process.stderr.write(`codex app-server failed to start: ${error.message}\n`);
    finish(1);
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (threadId && turnId) send({ id: ++nextId, method: 'turn/interrupt', params: { threadId, turnId } });
    setTimeout(() => finish(130), STOP_GRACE_MS).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  const run = async () => {
    await call('initialize', { clientInfo: { name: 'o8', title: 'o8', version: '1' } });
    send({ method: 'initialized' });
    const threadParams: Json = {
      cwd: spec.cwd,
      model: spec.model,
      sandbox: spec.sandbox,
      approvalPolicy: 'never',
      config: spec.config,
      ...(spec.developerInstructions ? { developerInstructions: spec.developerInstructions } : {}),
    };
    let started: Json;
    if (spec.threadId) {
      try {
        started = await withProviderStoreLock(() => { assertMcpServers(spec.config?.mcp_servers); return call('thread/resume', { threadId: spec.threadId, excludeTurns: true, ...threadParams }); });
      } catch (error) {
        throw new Error(`thread/resume: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      started = await withProviderStoreLock(() => { assertMcpServers(spec.config?.mcp_servers); return call('thread/start', threadParams); });
    }
    threadId = text(asObject(started.thread)?.id) || null;
    if (!threadId) throw new Error('codex app-server did not return a thread id');
    out({ type: 'thread.started', thread_id: threadId });
    if (stopping) return finish(130);
    const input: Json[] = [
      { type: 'text', text: spec.message, text_elements: [] },
      ...spec.imagePaths.map((path) => ({ type: 'localImage', path })),
    ];
    const turn = await call('turn/start', {
      threadId,
      input,
      effort: spec.effort,
      ...(spec.serviceTier ? { serviceTier: spec.serviceTier } : {}),
    });
    turnId = text(asObject(turn.turn)?.id) || null;
    process.send?.({ type: 'codex.bridge.turn', threadId, turnId });
    // Lets o8 tell its own turns from turns added in the Codex app.
    if (turnId) out({ type: 'turn.started', thread_id: threadId, turn_id: turnId });
    if (stopping && turnId) send({ id: ++nextId, method: 'turn/interrupt', params: { threadId, turnId } });
  };
  run().catch((error: unknown) => {
    const message = childDiagnostic(error instanceof Error ? error.message : String(error));
    out({ type: 'error', message });
    process.stderr.write(`${childDiagnostic(message)}\n`);
    finish(1);
  });

  const code = await finished;
  child.removeAllListeners('exit');
  child.kill('SIGTERM');
  process.exit(code);
}

void main();
