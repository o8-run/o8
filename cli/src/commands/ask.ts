/**
 * `o8 ask "<question>"` — query the Engineering Brain from anywhere.
 *
 * The worker-facing Brain surface (2026-06-11): a dispatched agent inside a
 * packet worktree asks plain-English questions about the repo (conventions,
 * directives, past fixes, PRs) and gets an answer + titled citations back in
 * seconds — instead of spending its own context on greps. Outside a worktree
 * it works as an operator command scoped to the current repo (or --repo).
 *
 * When asked from a worktree, the packet id rides along so the server scopes
 * retrieval to the packet's real repo (worktree dir names don't match repo
 * slugs) and records a `brain_consulted` lane event for the packet UI.
 */

import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import {
  printHumanHeading,
  printJson,
  type OutputMode,
} from '../output.js';
import { resolveLaneFromCwd } from './packet/worktree-resolve.js';

export const ASK_API_TIMEOUT_MS = 150_000;

interface AskArgs {
  question: string | null;
  repo: string | null;
  terse: boolean;
}

interface AskCitation {
  kind?: string;
  rowId?: string;
  title?: string;
  excerpt?: string;
}

interface AskAnswerResponse {
  code?: string;
  ok?: boolean;
  answer?: string;
  citations?: AskCitation[];
  class?: string;
  cacheHit?: string | null;
  sourcesConsidered?: number;
  error?: string;
}

function parseAskArgs(rest: string[]): AskArgs {
  let repo: string | null = null;
  let terse = false;
  const questionParts: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--repo') {
      repo = rest[++i] ?? null;
    } else if (tok.startsWith('--repo=')) {
      repo = tok.slice('--repo='.length);
    } else if (tok === '--terse') {
      terse = true;
    } else if (!tok.startsWith('--')) {
      questionParts.push(tok);
    }
  }

  return {
    question: questionParts.join(' ').trim() || null,
    repo: repo?.trim() || null,
    terse,
  };
}

export async function runAsk(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parseAskArgs(rest);
  if (!args.question) {
    throw new CliError(
      'invalid_args',
      'o8 ask requires a question, e.g. `o8 ask "What is the theming rule for surface colors?"`.',
      EXIT.INVALID_ARGS,
    );
  }

  // Best-effort packet attribution: inside a worktree the lane gives us the
  // real packet id (server resolves the repo from it + records the audit
  // event). Failure here is never fatal — fall through to repo scoping.
  let packetId: string | null = null;
  try {
    const resolved = await resolveLaneFromCwd();
    if (resolved) packetId = resolved.packetId ?? resolved.match.packetSlug;
  } catch {
    packetId = null;
  }

  const repoPath = args.repo ?? (packetId ? null : process.cwd());

  const cfg = resolveConfig();
  const res = await apiFetch<AskAnswerResponse>(cfg, '/api/cortex/ask/answer', {
    method: 'POST',
    timeoutMs: ASK_API_TIMEOUT_MS,
    allowUnavailable: true,
    body: {
      question: args.question,
      ...(args.terse ? { terse: true } : {}),
      ...(repoPath ? { repoPath } : {}),
      ...(packetId ? { packetId } : {}),
    },
  });

  const data = res.data;
  if (!data?.ok || typeof data.answer !== 'string') {
    throw new CliError(data?.code === 'managed_brain_unavailable' ? data.code : 'ask_failed', data?.error ?? 'The Engineering Brain did not return an answer.', EXIT.CONFLICT);
  }

  const citations = (data.citations ?? []).map((citation) => ({
    kind: citation.kind ?? 'source',
    title: citation.title ?? citation.excerpt?.slice(0, 80) ?? citation.rowId ?? 'source',
    rowId: citation.rowId ?? null,
  }));

  const payload = {
    schema: 'o8/cli/ask/v1',
    question: args.question,
    answer: data.answer,
    citations,
    class: data.class ?? null,
    cacheHit: data.cacheHit ?? null,
    sourcesConsidered: data.sourcesConsidered ?? null,
    terse: args.terse,
    packetId,
  };

  if (mode.human) {
    printHumanHeading('brain answer');
    process.stdout.write(`\n${data.answer}\n`);
    if (citations.length > 0) {
      process.stdout.write('\nsources:\n');
      for (const citation of citations) {
        process.stdout.write(`  [${citation.kind}] ${citation.title}\n`);
      }
    }
  } else {
    printJson(payload);
  }
  return 0;
}
