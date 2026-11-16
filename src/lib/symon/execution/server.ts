import { createPhoneToolCallRegistry, type PhoneToolCall, type PhoneToolDecision } from './calls';
import { phoneToolHandler, PHONE_TOOL_REVIEW_BUILDERS, PHONE_DEFERRED_TOOLS } from './dispatcher';
import { PHONE_TOOL_CATALOG } from './catalog';
import { toolSafetyClass } from './policy';
import { getSymonMcpCatalog } from '@/lib/mcp/symon-tools';
import { SYMON_REPLAY_TTL_MS, toolErrorResult, type SymonToolRelayResult, type SymonConfirmationResolution } from '@/lib/mobile/symon-tool-relay';
import { redactThreadText } from '@/lib/threads/redaction';

function createServer() {
  const calls = createPhoneToolCallRegistry(phoneToolHandler);
  const preparing = new Map<string, Promise<SymonToolRelayResult>>();
  const decisions = new Map<string, { at: number; resolution: SymonConfirmationResolution }>();
  return {
    calls,
    async start(input: PhoneToolCall): Promise<SymonToolRelayResult> {
      const attached = calls.attach(input.sessionId, input.callId, input.tool);
      if (attached) return attached;
      const key = JSON.stringify([input.sessionId, input.callId]);
      const pending = preparing.get(key);
      if (pending) {
        await pending;
        return calls.attach(input.sessionId, input.callId, input.tool) ?? toolErrorResult('tool_failed');
      }
      const preparation = Promise.resolve().then(async () => {
        const known = PHONE_TOOL_CATALOG.some(schema => schema.name === input.tool);
        if (!known && !input.tool.startsWith('mcp__')) return toolErrorResult('unknown_tool');
        if (PHONE_DEFERRED_TOOLS.has(input.tool)) return toolErrorResult('desktop_unavailable');
        const signal = AbortSignal.timeout(20_000);
        try {
          let review;
          if (toolSafetyClass(input.tool) !== 'read-only') {
            if (input.tool.startsWith('mcp__')) {
              const schema = (await getSymonMcpCatalog()).tools.find(tool => tool.name === input.tool);
              if (!schema) return toolErrorResult('unknown_tool');
              review = { summary: redactThreadText(`Run connected tool ${schema.name} with ${JSON.stringify(Object.fromEntries(Object.entries(input.args).filter(([key]) => !key.startsWith('__symon'))))}`), target: {} };
            } else {
              const builder = PHONE_TOOL_REVIEW_BUILDERS[input.tool];
              if (!builder) return toolErrorResult('confirmation_mismatch');
              review = await builder(input.args, { signal });
            }
          }
          signal.throwIfAborted();
          return calls.start({ ...input, review });
        } catch {
          return toolErrorResult('tool_failed', 'The server could not prepare this action for review.');
        }
      }).finally(() => preparing.delete(key));
      preparing.set(key, preparation);
      return preparation;
    },
    decide(input: PhoneToolDecision) {
      for (const [key, entry] of decisions) {
        if (Date.now() - entry.at >= SYMON_REPLAY_TTL_MS) decisions.delete(key);
      }
      const key = JSON.stringify([input.sessionId, input.callId, input.confirmationId]);
      const prior = decisions.get(key);
      if (prior) {
        const resolution = prior.resolution;
        return { ok: true, resolution: resolution.status === 'resolved'
          ? { status: 'already_resolved', allow: resolution.allow } : resolution };
      }
      const result = calls.decide(input);
      if (!result.ok) {
        const error = (result.result as { error: string }).error;
        if (error !== 'confirmation_declined' && error !== 'already_resolved') return { ok: false, error };
        return { ok: true, resolution: { status: 'expired' } };
      }
      const resolution = result.result as SymonConfirmationResolution;
      decisions.set(key, { at: Date.now(), resolution });
      while (decisions.size > 1_000) decisions.delete(decisions.keys().next().value!);
      return { ok: true, resolution };
    },
  };
}

// Next route bundles may each evaluate this module. The process owns one store.
const processStore = globalThis as typeof globalThis & { __o8PhoneToolServer?: ReturnType<typeof createServer> };
export const phoneToolServer = processStore.__o8PhoneToolServer ??= createServer();

export const phoneToolCalls = phoneToolServer.calls;
