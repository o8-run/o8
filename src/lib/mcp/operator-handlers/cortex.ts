import { KNOWLEDGE_SOURCE_TOOLS, handleKnowledgeSources } from './knowledge-sources';
import { McpInputError } from '@/lib/mcp/api-error';
import {
  apiFetch,
  errorText,
  jsonResult,
  optionalString,
  requiredString,
  type McpTool,
  type McpToolResult,
} from '@/lib/mcp/operator-handlers/shared';

const OBSERVATION_KINDS = new Set(['regression', 'pattern', 'gotcha', 'preference']);
const OBSERVATION_SCOPES = new Set(['packet', 'repo', 'global']);

export const CORTEX_TOOLS: McpTool[] = [
  ...KNOWLEDGE_SOURCE_TOOLS,
  {
    name: 'cortex_propose_observation',
    description: 'Propose a worker observation for the orchestrator proposal queue. The worker does not write memory directly; the orchestrator reviews and promotes the useful observations.',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'Packet ID that produced the observation.',
        },
        kind: {
          type: 'string',
          enum: ['regression', 'pattern', 'gotcha', 'preference'],
          description: 'Observation category.',
        },
        text: {
          type: 'string',
          description: 'Concise observation text for the orchestrator to review.',
        },
        scope: {
          type: 'string',
          enum: ['packet', 'repo', 'global'],
          description: 'Where the observation may apply. Defaults to packet.',
        },
      },
      required: ['packetId', 'kind', 'text'],
    },
  },
  {
    name: 'cortex_ask',
    description:
      'Ask the Engineering Brain a natural-language question. Joins session_outcomes + directives + symbol_graph + GitHub PRs across the operator\'s projects, classifies the question (Class A factual / Class B narrative), retrieves via SQL + FTS5 + graph, and composes an answer with citations back to source rows. Non-streaming JSON result. Each citation carries a human-readable `title` (directive title, PR title, outcome summary) — name your sources when relaying the answer (e.g. "per the CLAUDE.md critical-rules directive"). `sourcesConsidered` is how many rows retrieval examined; citations are the subset the answer actually used. Use for: "who owns X", "how does Y get reviewed", "what changed in Z this week", "have we tried this before".',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The natural-language question. Plain English, complete sentence.',
        },
        repoPath: {
          type: 'string',
          description: 'Absolute path to the repo whose context to bias toward. Optional.',
        },
        projectId: {
          type: 'string',
          description: 'Project id to scope the answer to. Optional — defaults to the active project for repoPath.',
        },
        bypassCache: {
          type: 'boolean',
          description: 'Skip the 30s in-process answer cache. Default false.',
        },
        terse: {
          type: 'boolean',
          description: 'Return a compact answer: <=150 tokens and at most 2 citations. Default false.',
        },
      },
      required: ['question'],
    },
  },
];

function parseKind(value: string): string {
  if (OBSERVATION_KINDS.has(value)) return value;
  throw new McpInputError('kind must be one of regression, pattern, gotcha, preference');
}

function parseScope(value: string): string {
  if (!value) return 'packet';
  if (OBSERVATION_SCOPES.has(value)) return value;
  throw new McpInputError('scope must be one of packet, repo, global');
}

export async function handleAsk(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const question = requiredString(args, 'question');
    const body: Record<string, unknown> = { question };
    const repoPath = optionalString(args, 'repoPath');
    if (repoPath) body.repoPath = repoPath;
    const projectId = optionalString(args, 'projectId');
    if (projectId) body.projectId = projectId;
    if (args.bypassCache === true) body.bypassCache = true;
    if (args.terse === true) body.terse = true;

    const result = await apiFetch('/api/cortex/ask/answer', {
      method: 'POST',
      body: JSON.stringify(body),
      // 90s ceiling. The composer's own tier ceilings stack well past 30s
      // (Class B Sonnet CLI alone is allowed 300s; a measured heavy Class B
      // ran 26.9s end-to-end on the WARM path, 2026-06-11). At 30s an agent
      // got a timeout error while the server kept composing — and the natural
      // retry doubled the spend before single-flight coalescing existed. 90s
      // covers every realistic chain; truly wedged calls still fail.
      timeoutMs: 90_000,
    }) as {
      ok?: boolean;
      answer?: string;
      citations?: unknown[];
      class?: string;
      retrievalMs?: number;
      classifyMs?: number;
      sourcesConsidered?: number;
      consideredChars?: number | null;
      cacheHit?: string | null;
      classifier?: string;
      classificationReceiptId?: string | null;
      error?: string;
    };

    if (!result?.ok) {
      return jsonResult({ ok: false, error: errorText(result) }, true);
    }

    return jsonResult({
      ok: true,
      answer: result.answer ?? '',
      citations: result.citations ?? [],
      class: result.class ?? null,
      retrievalMs: result.retrievalMs ?? null,
      classifyMs: result.classifyMs ?? null,
      sourcesConsidered: result.sourcesConsidered ?? null,
      consideredChars: result.consideredChars ?? null,
      cacheHit: result.cacheHit ?? null,
      ...(result.classifier ? { classifier: result.classifier, classificationReceiptId: result.classificationReceiptId ?? null } : {}),
    });
  } catch (error) {
    return jsonResult({ ok: false, error: errorText(error) }, true);
  }
}

export async function handleProposeObservation(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const packetId = requiredString(args, 'packetId');
    const kind = parseKind(requiredString(args, 'kind'));
    const text = requiredString(args, 'text');
    const scope = parseScope(optionalString(args, 'scope'));
    const result = await apiFetch('/api/cortex/proposals', {
      method: 'POST',
      body: JSON.stringify({
        action: 'propose_observation',
        packetId,
        kind,
        text,
        scope,
        proposed_by: packetId,
      }),
    }) as Record<string, unknown>;

    if (result.ok) return jsonResult(result);
    return jsonResult({ ok: false, error: errorText(result) }, true);
  } catch (error) {
    return jsonResult({ ok: false, error: errorText(error) }, true);
  }
}

export const CORTEX_HANDLERS = { cortex_ask: handleAsk, cortex_propose_observation: handleProposeObservation, cortex_knowledge_sources: handleKnowledgeSources };
