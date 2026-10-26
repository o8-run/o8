import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { atomicWriteTaskState, findTaskDraft } from '@/lib/mcp/task-draft-store';
import { withTaskDraftAccountAdmission } from '@/lib/mcp/task-draft-account';
import { canonical } from '@/lib/mcp/task-draft-contract';
import { operatorAccount, readExecutionSession } from '@/lib/mcp/task-execution-admission';
import { readTaskExecution, taskBinding } from '@/lib/mcp/task-execution-store';
import { verifyTaskExecutionWorkspace } from '@/lib/mcp/task-execution-workspace';
import { CONTROLLED_OPENROUTER_MODEL, controlledProviderPins, providerFromConfig,
  type ControlledOpenRouterPolicy } from '@/lib/runtimes/shared/owned-session/controlled-provider';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

export const CONTROLLED_GATEWAY_RECEIPT = 'controlled-provider-usage.json';
const UPSTREAM = 'https://openrouter.ai/api/v1/messages';
const MAX_RESPONSE = 1_048_576;
interface Usage {
  version: 1;
  task: NonNullable<OwnedSessionRecord['controlledTask']>;
  carrier: 'openrouter'; model: string; policy: ControlledOpenRouterPolicy;
  requests: number; costUsd: number | null; inputTokens: number; outputTokens: number;
  generationIds: string[]; pending: boolean; blockedReason: string | null;
}
interface Registration {
  session: OwnedSessionRecord; policy: ControlledOpenRouterPolicy;
  token: string; key: string; usage: Usage; controller: AbortController;
  expiresAt: number; queue: Promise<void>; timer?: ReturnType<typeof setTimeout>;
}
const registrations = new Map<string, Registration>();
let serverPromise: Promise<number> | undefined;

function save(registration: Registration): void {
  atomicWriteTaskState(join(registration.session.sessionDir, CONTROLLED_GATEWAY_RECEIPT), registration.usage);
}
function close(registration: Registration, reason: string): void {
  registration.usage.blockedReason ??= reason;
  if (registration.timer) clearTimeout(registration.timer);
  registration.controller.abort();
  registrations.delete(registration.token);
  registration.key = '';
}
export function revokeControlledGateway(surfaceId: string): void {
  for (const registration of registrations.values()) {
    if (registration.session.surfaceId === surfaceId) close(registration, 'attempt_closed');
  }
}
function reply(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'content-type': 'application/json' })
    .end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'Controlled task request refused. No fallback.' } }));
}
async function bytes(source: AsyncIterable<Uint8Array>, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of source) {
    size += chunk.length;
    if (size > max) throw new Error('Body limit reached');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function validToken(value: unknown, expected: string): boolean {
  return typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(expected)
    && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
function bodyFor(raw: Buffer, policy: ControlledOpenRouterPolicy): Record<string, unknown> {
  const value = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  const allowed = ['model', 'messages', 'system', 'max_tokens', 'stream', 'tools', 'tool_choice',
    'temperature', 'top_p', 'top_k', 'stop_sequences', 'metadata', 'thinking', 'output_config', 'context_management'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key))
    || value.model !== CONTROLLED_OPENROUTER_MODEL || !Array.isArray(value.messages) || !value.messages.length
    || (value.tools !== undefined && (!Array.isArray(value.tools)
      || value.tools.some((tool) => !tool || typeof tool !== 'object' || tool.name !== 'Read' || tool.type !== undefined)))
    || (value.tool_choice !== undefined && (!value.tool_choice || typeof value.tool_choice !== 'object'
      || !['auto', 'any', 'none', 'tool'].includes((value.tool_choice as Record<string, string>).type)
      || ((value.tool_choice as Record<string, string>).type === 'tool'
        && (value.tool_choice as Record<string, string>).name !== 'Read')))) throw new Error('Invalid pins or tools');
  value.max_tokens = policy.maxOutputTokens;
  // Provider default reasoning; do not ask the carrier for vendor-managed compaction.
  delete value.thinking; delete value.output_config; delete value.context_management;
  return value;
}
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function usageIn(raw: string, generation = false) {
  let cost: number | null = null; let input = 0; let output = 0;
  const ids = new Set<string>(); const models = new Set<string>();
  function record(envelope: Record<string, unknown>): void {
    const usage = envelope.usage && typeof envelope.usage === 'object' && !Array.isArray(envelope.usage)
      ? envelope.usage as Record<string, unknown> : {};
    const amount = finite(usage.cost) ?? finite(usage.total_cost);
    if (amount !== null) cost = Math.max(cost ?? 0, amount);
    input = Math.max(input, finite(usage.input_tokens) ?? finite(usage.prompt_tokens) ?? 0);
    output = Math.max(output, finite(usage.output_tokens) ?? finite(usage.completion_tokens) ?? 0);
    if (typeof envelope.id === 'string' && /^gen-[A-Za-z0-9_-]{1,200}$/.test(envelope.id)) ids.add(envelope.id);
    if (typeof envelope.model === 'string') models.add(envelope.model);
  }
  for (const line of raw.split('\n')) {
    try {
      const envelope = JSON.parse(line.startsWith('data:') ? line.slice(5).trim() : line);
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) continue;
      if (generation) { // Only the authenticated generation endpoint's documented data record.
        if (envelope.data && typeof envelope.data === 'object') cost = finite(envelope.data.total_cost);
      } else if (envelope.type === 'message' || envelope.type === 'message_delta') record(envelope);
      else if (envelope.type === 'message_start' && envelope.message?.type === 'message') record(envelope.message);
    } catch { /* SSE framing. Never interpret assistant/tool content as usage. */ }
  }
  return { cost, input, output, ids: [...ids], models: [...models] };
}
async function upstreamBytes(response: Response): Promise<Buffer> {
  if (!response.body) throw new Error('Missing response');
  // Web streams implement AsyncIterable in the supported Node runtime.
  return bytes(response.body as unknown as AsyncIterable<Uint8Array>, MAX_RESPONSE);
}
async function current(registration: Registration): Promise<void> {
  if (registration.controller.signal.aborted || Date.now() >= registration.expiresAt) throw new Error('Attempt closed');
  const binding = registration.session.controlledTask!;
  const draft = findTaskDraft(binding.taskId, operatorAccount().accountId);
  const record = readTaskExecution(draft);
  if (!record || record.state !== 'running' || record.stopRequestedAt
    || canonical(taskBinding(record)) !== canonical(binding)
    || canonical(record.provider) !== canonical(registration.policy)
    || record.surfaceId !== registration.session.surfaceId || !record.runId) throw new Error('Binding changed');
  const session = readExecutionSession(record);
  if (!session?.activeRun || session.activeRun.id !== record.runId) throw new Error('Attempt exited');
}
async function forward(registration: Registration, body: Record<string, unknown>): Promise<Response> {
  const binding = registration.session.controlledTask!;
  const draft = findTaskDraft(binding.taskId, operatorAccount().accountId);
  const admitted = await withTaskDraftAccountAdmission(operatorAccount(), draft.account, async () => {
    await current(registration);
    const record = readTaskExecution(draft)!;
    await verifyTaskExecutionWorkspace(draft, record);
    if (registration.usage.pending || registration.usage.blockedReason
      || registration.usage.requests >= registration.policy.maxRequests
      || (registration.usage.costUsd ?? Infinity) >= registration.policy.costUsd) throw new Error('Limit reached');
    registration.usage.requests++; registration.usage.pending = true;
    save(registration); // Consume and sync before dispatch, including uncertain outcomes.
    return { pending: fetch(UPSTREAM, { method: 'POST',
      signal: AbortSignal.any([registration.controller.signal, AbortSignal.timeout(45_000)]),
      headers: { authorization: `Bearer ${registration.key}`, 'content-type': 'application/json',
        'anthropic-version': '2023-06-01', 'x-openrouter-metadata': 'enabled' }, body: JSON.stringify(body) }) };
  });
  return admitted.pending;
}
async function processRequest(registration: Registration, request: IncomingMessage, response: ServerResponse): Promise<void> {
  let poll: ReturnType<typeof setInterval> | undefined;
  try {
    const raw = await bytes(request, registration.policy.maxRequestBytes);
    const body = bodyFor(raw, registration.policy);
    poll = setInterval(() => {
      void Promise.resolve().then(() => {
        const draft = findTaskDraft(registration.session.controlledTask!.taskId, operatorAccount().accountId);
        return withTaskDraftAccountAdmission(operatorAccount(), draft.account, () => current(registration));
      })
        .catch(() => close(registration, 'account_or_attempt_changed'));
    }, 1000); poll.unref();
    const upstream = await forward(registration, body);
    const result = await upstreamBytes(upstream);
    const usage = usageIn(result.toString('utf8'));
    if (usage.cost === null && usage.ids.length === 1 && !registration.controller.signal.aborted) {
      const url = new URL('https://openrouter.ai/api/v1/generation'); url.searchParams.set('id', usage.ids[0]!);
      const receipt = await fetch(url, { headers: { authorization: `Bearer ${registration.key}` },
        signal: AbortSignal.any([registration.controller.signal, AbortSignal.timeout(10_000)]) });
      if (receipt.ok) usage.cost = usageIn((await upstreamBytes(receipt)).toString('utf8'), true).cost;
    }
    registration.usage.pending = false;
    registration.usage.costUsd = usage.cost === null ? null : (registration.usage.costUsd ?? 0) + usage.cost;
    registration.usage.inputTokens += usage.input; registration.usage.outputTokens += usage.output;
    registration.usage.generationIds.push(...usage.ids);
    const mismatched = usage.models.some((model) => model !== CONTROLLED_OPENROUTER_MODEL && !model.startsWith(`${CONTROLLED_OPENROUTER_MODEL}-`));
    if (!upstream.ok || usage.cost === null || mismatched || registration.usage.costUsd! >= registration.policy.costUsd) {
      registration.usage.blockedReason = mismatched ? 'provider_model_changed' : usage.cost === null ? 'cost_unavailable' : 'provider_or_cost_limit';
    }
    save(registration);
    const draft = findTaskDraft(registration.session.controlledTask!.taskId, operatorAccount().accountId);
    await withTaskDraftAccountAdmission(operatorAccount(), draft.account, async () => {
      await current(registration);
      if (registration.usage.blockedReason) { close(registration, registration.usage.blockedReason); reply(response, 429); return; }
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' }).end(result);
    });
  } catch {
    close(registration, 'request_refused_or_uncertain');
    try { save(registration); } catch { /* Memory stays revoked when persistence fails. */ }
    if (!response.headersSent) reply(response, 403); else response.end();
  } finally { if (poll) clearInterval(poll); }
}

async function modelCatalog(registration: Registration, response: ServerResponse): Promise<void> {
  try {
    const draft = findTaskDraft(registration.session.controlledTask!.taskId, operatorAccount().accountId);
    await withTaskDraftAccountAdmission(operatorAccount(), draft.account, async () => {
      await current(registration);
      // This gateway can serve only the sealed model. Discovery is metadata,
      // so it neither forwards a provider request nor consumes inference limits.
      const model = { id: CONTROLLED_OPENROUTER_MODEL, type: 'model',
        display_name: CONTROLLED_OPENROUTER_MODEL, created_at: registration.session.createdAt };
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify({ data: [model], has_more: false, first_id: model.id, last_id: model.id }));
    });
  } catch {
    close(registration, 'model_catalog_refused');
    if (!response.headersSent) reply(response, 403); else response.end();
  }
}

async function ensureServer(): Promise<number> {
  serverPromise ??= new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const [, token, ...suffix] = url.pathname.split('/');
      const registration = registrations.get(token);
      if (!registration
        || (!validToken(request.headers['x-api-key'], token) && !validToken(request.headers.authorization, `Bearer ${token}`))) {
        reply(response, 403); return;
      }
      if (request.method === 'GET' && suffix.join('/') === 'v1/models'
        && [...url.searchParams].every(([key, value]) => key === 'limit' && /^[1-9]\d{0,3}$/.test(value) && Number(value) <= 1000)) {
        registration.queue = registration.queue.then(() => modelCatalog(registration, response));
        return;
      }
      if (request.method !== 'POST' || suffix.join('/') !== 'v1/messages'
        || [...url.searchParams].some(([key, value]) => key !== 'beta' || value !== 'true')) {
        reply(response, 403); return;
      }
      const previous = registration.queue;
      registration.queue = previous.then(() => processRequest(registration, request, response));
    });
    server.requestTimeout = 10_000; server.headersTimeout = 10_000;
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.unref(); const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('Controlled gateway unavailable'));
      else resolve(address.port);
    });
  });
  return serverPromise;
}
export async function prepareControlledGateway(session: OwnedSessionRecord, key: string): Promise<{ baseUrl: string; token: string }> {
  const policy = providerFromConfig(session.runtimeConfig);
  if (!key || !session.controlledTask || session.executionPolicy?.mode !== 'single-attempt'
    || !policy || !controlledProviderPins(session.model, session.effort, session.runtimeConfig)) throw new Error('Invalid controlled provider');
  const token = randomBytes(32).toString('hex');
  const registration: Registration = { session, policy, token, key, controller: new AbortController(),
    expiresAt: Date.now() + 90_000, queue: Promise.resolve(), usage: { version: 1, task: { ...session.controlledTask },
      carrier: 'openrouter', model: session.model!, policy, requests: 0, costUsd: 0, inputTokens: 0, outputTokens: 0,
      generationIds: [], pending: false, blockedReason: null } };
  save(registration);
  const port = await ensureServer(); registrations.set(token, registration);
  registration.timer = setTimeout(() => {
    close(registration, 'attempt_expired');
    try { save(registration); } catch { /* Revocation remains effective. */ }
    void import('@/lib/runtime/interrupt-escalation').then(({ escalateInterruptOwnedSurface }) =>
      escalateInterruptOwnedSurface(session.surfaceId)).catch(() => { /* Process remains bound; gateway is revoked. */ });
  }, 90_000); registration.timer.unref();
  return { baseUrl: `http://127.0.0.1:${port}/${token}`, token };
}
