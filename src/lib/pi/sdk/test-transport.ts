import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { ManagedPiTransportOptions, PiModelTransport } from './transport';
import { createManagedPiTransport } from './transport';
import { finishPiTestRequest, reservePiTestRequest, validatePiBillingContract, type ManagedPiBillingContract } from './test-budget';
import { MANAGED_INFERENCE_BODY_FIELDS } from './live-contract';

export interface BudgetedPiTestOptions extends Omit<ManagedPiTransportOptions, 'maxOutputTokens' | 'observeRawUsage'> {
  ledgerPath: string;
  workspace: string;
  /** Trusted host/test seam, never a model tool, HTTP field, env JSON or user flag. */
  resolveContract?: () => Promise<ManagedPiBillingContract | null>;
}

/** Managed paid testing is retired. Offline callers must supply a synthetic contract. */
export async function resolveLivePiTestContract(): Promise<ManagedPiBillingContract | null> {
  return null;
}

export function createBudgetedPiTestTransport(options: BudgetedPiTestOptions): PiModelTransport {
  return async function* (context, signal) {
    signal.throwIfAborted();
    const resolved = await (options.resolveContract ?? resolveLivePiTestContract)();
    if (!resolved) throw new Error('A trusted hosted billing contract is required before live testing');
    const [workspace, ledger] = await Promise.all([realpath(options.workspace), realpath(options.ledgerPath)]);
    const ledgerRelative = relative(workspace, ledger);
    if (!ledgerRelative || (!(ledgerRelative === '..' || ledgerRelative.startsWith(`..${sep}`)) && !isAbsolute(ledgerRelative))) {
      throw new Error('Test budget ledger must be outside the tool workspace');
    }
    const contract = structuredClone(resolved);
    validatePiBillingContract(contract);
    if (contract.modelId !== options.model.id || contract.contextWindow !== options.model.contextWindow) {
      throw new Error('Selected model does not match the trusted billing contract');
    }
    let reservation: string | undefined;
    let finalized = false;
    let rawUsage: { input: number; output: number; total: number } | undefined;
    let invalidUsage = false;
    const transport = createManagedPiTransport({ ...options,
      maxOutputTokens: contract.maxBillableOutputTokens,
      observeRawUsage: (value) => {
        if (!value || typeof value !== 'object') { invalidUsage = true; return; }
        const usage = value as Record<string, unknown>;
        const parts = [usage.prompt_tokens, usage.completion_tokens, usage.total_tokens];
        if (!parts.every(part => typeof part === 'number' && Number.isSafeInteger(part) && part >= 0)
          || Number(usage.total_tokens) !== Number(usage.prompt_tokens) + Number(usage.completion_tokens)) {
          invalidUsage = true; return;
        }
        rawUsage = { input: Number(usage.prompt_tokens), output: Number(usage.completion_tokens), total: Number(usage.total_tokens) };
      },
      fetch: async (url, init) => {
        signal.throwIfAborted();
        validatePiBillingContract(contract);
        if (String(url) !== contract.endpoint || init?.method !== 'POST' || init.redirect !== 'error'
          || typeof init.body !== 'string' || Buffer.byteLength(init.body, 'utf8') > contract.maxRequestBytes) {
          throw new Error('Request exceeds the trusted billing contract');
        }
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (Object.keys(body).some(key => !MANAGED_INFERENCE_BODY_FIELDS.has(key))) {
          throw new Error('Request field is outside the billing contract');
        }
        const outputLimit = body.max_completion_tokens ?? body.max_tokens;
        if (body.model !== contract.modelId || body.models !== undefined || (body.n !== undefined && body.n !== 1)
          || !Number.isSafeInteger(outputLimit) || Number(outputLimit) <= 0 || Number(outputLimit) > contract.maxBillableOutputTokens) {
          throw new Error('Model, fallback or output limit violates the billing contract');
        }
        // This seam receives the complete provider request, including system
        // messages, tools and history, not a chars/4 estimate of the user prompt.
        if (reservation) throw new Error('Automatic request retry is disabled');
        reservation = reservePiTestRequest(options.ledgerPath, contract);
        // Process cancellations that queued during a synchronous SQLite lock wait.
        await new Promise<void>(resolve => setImmediate(resolve));
        signal.throwIfAborted();
        init.signal?.throwIfAborted();
        validatePiBillingContract(contract);
        return (options.fetch ?? fetch)(url, init);
      },
    });
    try {
      for await (const event of transport(context, signal)) {
        if (event.type === 'done') {
          const usage = event.message.usage;
          const numbers = [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite];
          const input = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
          const total = input + (usage?.output ?? 0);
          if (invalidUsage || !rawUsage || rawUsage.total !== total
            || rawUsage.input !== input || rawUsage.output !== usage.output
            || !numbers.every(value => Number.isSafeInteger(value) && value >= 0)
            || !Number.isSafeInteger(usage?.totalTokens) || usage.totalTokens <= 0 || total !== usage.totalTokens
            || input > contract.maxBillableInputTokens || usage.output > contract.maxBillableOutputTokens
            || (event.message.responseModel && event.message.responseModel !== contract.modelId)) {
            if (reservation) { finishPiTestRequest(options.ledgerPath, reservation, false); finalized = true; }
            throw new Error('Usage cannot be verified against the test billing contract');
          }
        }
        if (event.type === 'done' || event.type === 'error') {
          if (reservation) {
            finishPiTestRequest(options.ledgerPath, reservation, event.type === 'done');
            finalized = true;
          }
        }
        yield event;
      }
    } finally {
      if (reservation && !finalized) finishPiTestRequest(options.ledgerPath, reservation, false);
    }
  };
}
