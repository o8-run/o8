/**
 * #743 — Dispatch context injection.
 *
 * Builds a `<context>...</context>` block to prepend to every packet body
 * we hand to a runtime adapter (Codex / Gemini / opencode). The block is
 * the same data the Recall Card (#742) shows the operator — directives,
 * recent outcomes and corrections — formatted for an
 * agent rather than a human eye.
 *
 * Format:
 *   <context>
 *   ## Project Directives
 *   - [title] [scope]: [body, single-line]
 *
 *   ## Recent Outcomes (last N)
 *   - [PASS] feat: ... (codex, 8m)
 *
 *   </context>
 *
 *   [original packet body follows]
 *
 * Failure policy:
 *   - Drizzle DB unavailable → skip Recent Outcomes.
 *   - Directive dir missing → skip Project Directives.
 *   - Helper never throws. If everything resolves empty, returns the
 *     original body unchanged so callers can drop in safely.
 *
 * Token budget — issue #743 caps the injected block at 4000 chars and
 * truncates outcomes first (the most variable / least operator-
 * authored section).
 */

import 'server-only';

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';

import { formatCorrectionLine, readOperatorCorrections, type OperatorCorrection } from '@/lib/cortex/operator-corrections';
import { getDb, sessionOutcomes } from '@/lib/db';
import { getDataDir } from '@/lib/data-dir-migration';
import { liveOutcomeFilter } from '@/lib/cortex/decay';
import { readRepoPathRegistry } from '@/lib/repos/repo-path-registry';
import { parseDirectiveFile, type ParsedDirective } from '@/lib/cortex/directives/parse';
import {
  directiveAppliesToRepo,
  resolveActiveDirectiveProjectScope,
} from '@/lib/cortex/directives/filter';
import { getProjectContext, PROJECT_REPO_POLICY, type ProjectContext } from '@/lib/projects/context';
import { extractRoughdraftReviewIndex } from '@/lib/o8md/rfm';
import type { CloseUnmergedDisposition } from '@/lib/orchestrator/close-unmerged';

import { reviewOutcomesSection } from '@/lib/cortex/review-outcomes';

const MAX_BLOCK_CHARS = 4000;
const MAX_DIRECTIVES = 5;
const MAX_OUTCOMES = 5;
const MAX_CORRECTIONS = 3;
const DIRECTIVE_BODY_CHARS = 240;
const OUTCOME_SUMMARY_CHARS = 160;

type DirectiveEntry = ParsedDirective;

interface OutcomeRow {
  outcome: 'succeeded' | 'failed' | 'partial' | 'interrupted' | CloseUnmergedDisposition;
  summary: string;
  runtime: string;
  branch: string | null;
  durationMs: number | null;
  reviewApproved: boolean | null;
}

interface BuildContextBlockInput {
  /** Repo root the packet targets — used to scope outcomes + directives. */
  repoPath: string;
  /** The packet body / summary, matched against review outcomes. */
  packetBody: string;
  /** Active project id. Falls back to ~/.o8/projects.json when omitted. */
  projectId?: string | null;
  /** #2219 — packet whose own corrections are rendered separately in its prompt. */
  excludeCorrectionsForPacketId?: string;
}

function readDirectives(): DirectiveEntry[] {
  try {
    const dir = join(getDataDir(), 'directives');
    if (!existsSync(dir)) return [];

    const entries = readdirSync(dir).filter((name) => name.endsWith('.md'));
    const directives: DirectiveEntry[] = [];
    for (const name of entries) {
      try {
        const raw = readFileSync(join(dir, name), 'utf-8');
        const parsed = parseDirectiveFile(raw, name.replace(/\.md$/, ''));
        if (parsed) directives.push(parsed);
      } catch {
        // Skip unreadable files — never block dispatch on a directive parse error.
      }
    }
    return directives;
  } catch {
    return [];
  }
}

/**
 * #849 — guard against global-directive leakage into unrelated repo packets.
 *
 * Global directives are by definition broad, but the semantic contract is
 * "speak about a known repo". When the caller hands us a repoPath we don't
 * recognize (typo, fixture path, fake `/tmp/...`), we shouldn't speak for it.
 * Returns true when the path matches a registered repo OR equals the
 * orchestrator's own `process.cwd()` (the canonical self-host case).
 *
 * Falls back to "trust it" if the registry is unreadable, so registry I/O
 * errors don't silently kill the directives leg for legitimate repos.
 */
async function isKnownRepoPath(repoPath: string): Promise<boolean> {
  const normalized = resolve(repoPath.trim());
  if (!normalized) return false;

  // Self-host case: o8 dispatching against its own checkout.
  try {
    if (resolve(process.cwd()) === normalized) return true;
  } catch {
    // resolve() never throws in practice, but keep the helper non-throwing.
  }

  const registry = await readRepoPathRegistry();
  if (!registry.ok) {
    // Registry unreadable — don't penalize legitimate dispatches.
    return true;
  }
  return registry.repos.some((entry) => entry.path === normalized);
}

/**
 * Filter directives for a target repo, sort by priority desc / title, and cap
 * at MAX_DIRECTIVES — the dispatch context block keeps the operator-curated
 * top N to stay within the token budget. Membership rules live in
 * `lib/cortex/directives/filter.ts` so the Recall Card UI applies the same
 * tiers (global / project / repo).
 */
async function filterDirectivesForRepo(
  directives: DirectiveEntry[],
  repoPath: string,
): Promise<DirectiveEntry[]> {
  const projectScope = await resolveActiveDirectiveProjectScope(repoPath);

  return directives
    .filter((d) => directiveAppliesToRepo(d, repoPath, projectScope))
    .sort((a, b) => {
      const ap = a.priority ?? 0;
      const bp = b.priority ?? 0;
      if (ap !== bp) return bp - ap;
      return a.title.localeCompare(b.title);
    })
    .slice(0, MAX_DIRECTIVES);
}

async function readRecentOutcomes(repoPath: string, projectId: string | null): Promise<OutcomeRow[]> {
  try {
    const db = getDb();
    if (!db) return [];
    if (!projectId) return [];
    const rows = await db
      .select({
        outcome: sessionOutcomes.outcome,
        summary: sessionOutcomes.summary,
        runtime: sessionOutcomes.runtime,
        branch: sessionOutcomes.branch,
        durationMs: sessionOutcomes.durationMs,
        reviewApproved: sessionOutcomes.reviewApproved,
      })
      .from(sessionOutcomes)
      .where(and(
        eq(sessionOutcomes.repoPath, repoPath),
        eq(sessionOutcomes.projectId, projectId),
        liveOutcomeFilter(),
      ))
      .orderBy(desc(sessionOutcomes.completedAt))
      .limit(MAX_OUTCOMES);
    return rows;
  } catch {
    return [];
  }
}

function formatDuration(ms: number | null): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hours}h${rem}m` : `${hours}h`;
}

function outcomeBadge(row: OutcomeRow): string {
  switch (row.outcome) {
    case 'succeeded':
      return row.reviewApproved === false ? '[REJECTED]' : '[PASS]';
    case 'failed':
      return '[FAIL]';
    case 'partial':
      return '[PARTIAL]';
    case 'interrupted':
      return '[INTERRUPTED]';
    case 'adopted_elsewhere':
    case 'superseded':
    case 'spec_changed':
    case 'wontfix':
      return '[CLOSED]';
    default:
      return '[?]';
  }
}

function clampLine(text: string, maxLen: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLen) return flat;
  return `${flat.slice(0, maxLen - 1)}…`;
}

function renderDirectivesSection(rows: DirectiveEntry[]): string[] {
  if (rows.length === 0) return [];
  const lines = ['## Project Directives'];
  for (const d of rows) {
    const scopeTag = d.scope ? `[${d.scope}]` : '';
    const title = d.title.trim() || d.id;
    const body = clampLine(d.body || '(no body)', DIRECTIVE_BODY_CHARS);
    lines.push(`- ${title} ${scopeTag}: ${body}`);
  }
  return lines;
}

function renderOutcomesSection(rows: OutcomeRow[]): string[] {
  if (rows.length === 0) return [];
  const lines = [`## Recent Outcomes (last ${rows.length})`];
  for (const row of rows) {
    const badge = outcomeBadge(row);
    const summary = clampLine(row.summary, OUTCOME_SUMMARY_CHARS);
    const dur = formatDuration(row.durationMs);
    const tail = [row.runtime, dur].filter(Boolean).join(', ');
    lines.push(`- ${badge} ${summary}${tail ? ` (${tail})` : ''}`);
  }
  return lines;
}

function renderCorrectionsSection(rows: OperatorCorrection[]): string[] {
  const operator = rows.filter((row) => row.standing === 'operator');
  const machine = rows.filter((row) => row.standing === 'machine');
  const lines: string[] = [];
  if (operator.length > 0) {
    lines.push(
      `## Recent Operator Corrections (last ${operator.length})`,
      ...operator.map((row) => formatCorrectionLine(row, OUTCOME_SUMMARY_CHARS)),
    );
  }
  if (machine.length > 0) {
    lines.push(
      `## Recent Machine Steering (last ${machine.length}; not operator rulings)`,
      ...machine.map((row) => formatCorrectionLine(row, OUTCOME_SUMMARY_CHARS)),
    );
  }
  return lines;
}

function renderProjectScopeSection(context: ProjectContext): string[] {
  if (context.repos.length === 0) return [];
  const siblingRepos = context.relatedRepos.filter((repo) => repo.id !== context.currentRepo?.id);
  const lines = ['## Project Scope'];
  lines.push(`- Project: ${context.name} (${context.repos.length} repo${context.repos.length === 1 ? '' : 's'})`);
  if (context.primaryRepo) {
    lines.push(`- Main repo: ${context.primaryRepo.name}${context.primaryRepo.role ? ` [${context.primaryRepo.role}]` : ''}`);
  }
  if (context.currentRepo && context.currentRepo.id !== context.primaryRepo?.id) {
    lines.push(`- Current repo: ${context.currentRepo.name}${context.currentRepo.role ? ` [${context.currentRepo.role}]` : ''}`);
  }
  if (siblingRepos.length > 0) {
    lines.push(`- Sibling repos: ${siblingRepos.map((repo) => `${repo.name}${repo.role ? ` [${repo.role}]` : ''}`).join(', ')}`);
  }
  if (context.instructions) {
    lines.push(`- Project instructions: ${clampLine(context.instructions, 360)}`);
  }
  lines.push(`- ${PROJECT_REPO_POLICY}`);
  return lines;
}

/**
 * Surface the operator's UNRESOLVED o8.md review threads so a dispatched agent
 * answers them in-file (the roughdraft-inversion loop: operator authors o8.md,
 * agent annotates). Best-effort + synchronous read of `<repoPath>/o8.md`; never
 * throws and returns [] when there's no file or nothing open.
 */
function renderPendingSpecSection(repoPath: string): string[] {
  let content: string;
  try {
    const specPath = join(repoPath, 'o8.md');
    if (!existsSync(specPath)) return [];
    content = readFileSync(specPath, 'utf-8');
  } catch {
    return [];
  }

  let open: { id: string; kind: string; anchorText?: string; text: string }[];
  try {
    open = extractRoughdraftReviewIndex(content).items
      // Operator/human-authored open threads only — `AI` is the format's magic
      // agent-author value, so the agent never sees its own (or peers') marks
      // surfaced back as "operator notes". status!=resolved = still open.
      .filter((item) =>
        (item.kind === 'comment' || item.kind === 'suggestion')
        && item.status !== 'resolved'
        && item.author !== 'AI')
      .map((item) => ({ id: item.id, kind: item.kind, anchorText: item.anchorText, text: item.text }));
  } catch {
    return [];
  }
  if (open.length === 0) return [];

  const lines = ['## Operator notes (o8.md)'];
  lines.push(
    '- The operator left these open review threads in this repo\'s o8.md. Address them in your work. Never edit the operator\'s prose or these notes.',
  );
  for (const item of open.slice(0, 12)) {
    const anchor = item.anchorText ? ` @"${clampLine(item.anchorText, 60)}"` : '';
    const kindTag = item.kind === 'suggestion' ? ' (suggestion)' : '';
    lines.push(`- [${item.id}]${kindTag}${anchor}: ${clampLine(item.text, 200)}`);
  }
  if (open.length > 12) {
    lines.push(`- …and ${open.length - 12} more in o8.md.`);
  }
  return lines;
}

/**
 * Truncate the rendered block from the bottom (Outcomes first, then
 * Corrections, then Directives) until it fits inside MAX_BLOCK_CHARS. The
 * `<context>` wrapper is included in the budget. Operator o8.md notes are the
 * highest priority — dropped last.
 */
function fitWithinBudget(sections: { heading: 'spec' | 'project' | 'directives' | 'corrections' | 'reviews' | 'outcomes'; lines: string[] }[]): string {
  const order: typeof sections[number]['heading'][] = ['outcomes', 'corrections', 'reviews', 'directives', 'project', 'spec'];
  const drop: Set<typeof sections[number]['heading']> = new Set();

  const render = () => {
    const inner = sections
      .filter((s) => !drop.has(s.heading))
      .map((s) => s.lines.join('\n'))
      .filter(Boolean)
      .join('\n\n');
    return inner ? `<context>\n${inner}\n</context>` : '';
  };

  let rendered = render();
  if (rendered.length <= MAX_BLOCK_CHARS) return rendered;

  // Drop sections in priority order until we fit.
  for (const heading of order) {
    drop.add(heading);
    rendered = render();
    if (rendered.length <= MAX_BLOCK_CHARS) return rendered;
  }
  return '';
}

/**
 * Build the `<context>` block. Returns an empty string when nothing useful
 * resolved (no directives, corrections or outcomes) so callers
 * can prepend unconditionally without inserting empty wrappers.
 */
export async function buildContextBlock({
  repoPath,
  packetBody,
  projectId,
  excludeCorrectionsForPacketId,
}: BuildContextBlockInput): Promise<string> {
  if (!repoPath?.trim()) return '';
  const projectContext = await getProjectContext({ repoPath, projectId });
  const activeProjectId = projectContext.runtimeProjectId;

  // #849 — when the path doesn't match a registered repo (and isn't our own
  // checkout), drop the directives leg. Global directives are intentionally
  // global, but injecting them into a packet for an unknown repo claims
  // authority we don't have. Outcomes still resolve naturally to
  // empty for unknown paths since they key off repoPath in the DB.
  const repoIsKnown = await isKnownRepoPath(repoPath);
  const directives = repoIsKnown
    ? await filterDirectivesForRepo(readDirectives(), repoPath)
    : [];
  const outcomes = await readRecentOutcomes(repoPath, activeProjectId);
  const corrections = readOperatorCorrections({
    repoPaths: [repoPath],
    projectId: activeProjectId,
    excludePacketId: excludeCorrectionsForPacketId,
    limit: MAX_CORRECTIONS,
  });

  return fitWithinBudget([
    { heading: 'spec', lines: renderPendingSpecSection(repoPath) },
    { heading: 'project', lines: renderProjectScopeSection(projectContext) },
    { heading: 'directives', lines: renderDirectivesSection(directives) },
    { heading: 'corrections', lines: renderCorrectionsSection(corrections) },
    { heading: 'reviews', lines: projectContext.repoInProject ? reviewOutcomesSection({
      repoPath, projectId: activeProjectId, packetBody, excludePacketId: excludeCorrectionsForPacketId,
    }) : [] },
    { heading: 'outcomes', lines: renderOutcomesSection(outcomes) },
  ]);
}

/**
 * Convenience helper: prepend the `<context>` block to a packet body,
 * collapsing to the original body when the helper resolves empty. Never throws.
 */
export async function prependContextBlock(input: BuildContextBlockInput): Promise<string> {
  try {
    const block = await buildContextBlock(input);
    if (!block) return input.packetBody;
    return `${block}\n\n${input.packetBody}`;
  } catch (error) {
    console.warn('[context-injection] prepend failed:', error);
    return input.packetBody;
  }
}
