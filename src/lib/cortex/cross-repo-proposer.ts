/**
 * #748 / #899 — Cross-repo learning.
 *
 * Default path (#899): when a `scope: repo` directive lands in repo A,
 * resolve A's project memberships, then propose the directive to every other
 * repo in those projects. Project membership is the explicit, operator-curated
 * grouping that replaced the production-inert Jaccard candidate-selection
 * step.
 *
 * Legacy path (#748, gated): set `O8_LEGACY_JACCARD_PROPOSER=1` to fall back
 * to the original behavior — Jaccard overlap of stack signatures with a
 * `repos.length < 3` floor and `SIMILARITY_THRESHOLD ≥ 0.4`. This existed for
 * one version after the project rewrite so any regression in the new path can
 * be reverted by env flag.
 *
 * Either way, the operator accepts (duplicates the directive scoped to the
 * target) or dismisses (snoozes the (target, directive) pair for 30 days).
 * Always human-gated. The proposer never writes a directive itself — Accept
 * text drives the orchestrator chat composer; the orchestrator's existing
 * memory tools handle the actual markdown write — this matches #746's flow.
 *
 * Storage:
 *   ~/.o8/cross-repo-snooze.json — append-only ledger of dismissed (target, directive) pairs
 *   ~/.o8/directive-origins.json — circular-propagation guard (#855)
 *   ~/.o8/stack-signatures.json — only read on the legacy Jaccard path
 *
 * Proposal id: sha1(`${targetRepoId}::${directiveId}`).slice(0,16) — stable
 * across ticks so dismiss survives recomputes.
 */

import 'server-only';

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { getDataDir } from '@/lib/data-dir-migration';
import { listRepos } from '@/lib/repos/registry';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { readOrComputeSignatures } from '@/lib/cortex/stack-signature';
import { listProjectsByRepoId } from '@/lib/projects/store';

// #853 / #899 — Jaccard constants live behind the legacy gate. The empirical
// 0.4 floor and ≥ 3-repos minimum mathematically excluded asymmetric stacks
// (cortex-ide 52 deps vs o8-site 7 deps caps at Jaccard ≈ 0.135), which is
// why #748 was production-inert. The default path (project membership) needs
// neither constant.
const SIMILARITY_THRESHOLD = 0.4;
const MIN_SIMILAR_REPOS = 2;
const SNOOZE_DAYS = 30;
const MAX_CANDIDATES = 12;
const SNOOZE_FILE = 'cross-repo-snooze.json';
const ORIGIN_FILE = 'directive-origins.json';

/**
 * #899 — fixed similarity score for project-membership matches. Project
 * grouping is binary ("in this project" or not), so we render the badge as
 * 100% to signal "explicit operator-curated link" rather than a fuzzy stack
 * overlap. The UI tooltip distinguishes the two via the `source` discriminator.
 */
const PROJECT_MEMBERSHIP_SCORE = 1.0;

/**
 * #899 — emergency fallback. Set `O8_LEGACY_JACCARD_PROPOSER=1` to revert to
 * the pre-Project Jaccard candidate selection for one version. Default OFF.
 */
function isLegacyJaccardEnabled(): boolean {
  const raw = process.env.O8_LEGACY_JACCARD_PROPOSER;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

// ── directive read (same parser shape as cortex/directives/route.ts) ──────

const FRONT_MATTER_BOUNDARY = /^---\s*$/m;

interface DirectiveSummary {
  id: string;
  title: string;
  scope: string;
  repoName: string | null;
  priority: number | null;
  body: string;
}

function parseDirectiveFile(raw: string, fallbackId: string): DirectiveSummary | null {
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!text.startsWith('---')) return null;

  const afterFirst = text.slice(3).trimStart();
  const closingIndex = afterFirst.search(FRONT_MATTER_BOUNDARY);
  if (closingIndex < 0) return null;

  const front = afterFirst.slice(0, closingIndex);
  const rawBody = afterFirst.slice(closingIndex).replace(FRONT_MATTER_BOUNDARY, '').trim();
  const body = rawBody.replace(/\n*##\s+Recent Merges\b[\s\S]*$/, '').trim();

  const meta: Record<string, string> = {};
  for (const line of front.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  }

  const priorityRaw = meta.priority;
  const priorityNum = priorityRaw ? Number.parseInt(priorityRaw, 10) : NaN;

  return {
    id: meta.id?.trim() || fallbackId,
    title: meta.title?.trim() || fallbackId,
    scope: meta.scope?.trim() || 'global',
    repoName: meta.repoName?.trim() || null,
    priority: Number.isFinite(priorityNum) ? priorityNum : null,
    body,
  };
}

function listDirectiveFiles(): { name: string; path: string }[] {
  try {
    const dir = join(getDataDir(), 'directives');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => ({ name, path: join(dir, name) }));
  } catch {
    return [];
  }
}

function readAllDirectives(): DirectiveSummary[] {
  const files = listDirectiveFiles();
  const out: DirectiveSummary[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(file.path, 'utf-8');
      const fallbackId = file.name.replace(/\.md$/, '');
      const parsed = parseDirectiveFile(raw, fallbackId);
      if (parsed) out.push(parsed);
    } catch {
      // skip unreadable
    }
  }
  return out;
}

// ── snooze ledger ─────────────────────────────────────────────────────────

interface SnoozeEntry {
  /** Composite proposal id — `sha1(targetRepoId::directiveId).slice(0,16)`. */
  id: string;
  targetRepoId: string;
  directiveId: string;
  snoozedUntil: string; // ISO-8601
}

interface SnoozeLedger {
  version: 1;
  entries: SnoozeEntry[];
}

function snoozeFilePath(): string {
  return join(getDataDir(), SNOOZE_FILE);
}

function readSnoozeLedger(): SnoozeLedger {
  const path = snoozeFilePath();
  if (!existsSync(path)) return { version: 1, entries: [] };
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SnoozeLedger>;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return { version: 1, entries: [] };
    }
    const entries = parsed.entries.filter(
      (e): e is SnoozeEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof e.id === 'string' &&
        typeof e.targetRepoId === 'string' &&
        typeof e.directiveId === 'string' &&
        typeof e.snoozedUntil === 'string',
    );
    return { version: 1, entries };
  } catch (err) {
    console.warn('[cross-repo-proposer] Failed to parse snooze ledger:', err instanceof Error ? err.message : err);
    return { version: 1, entries: [] };
  }
}

function writeSnoozeLedger(ledger: SnoozeLedger): void {
  try {
    writeFileSync(snoozeFilePath(), JSON.stringify(ledger, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[cross-repo-proposer] Failed to write snooze ledger:', err instanceof Error ? err.message : err);
  }
}

function activeSnoozedIds(now: Date): Set<string> {
  const ledger = readSnoozeLedger();
  const out = new Set<string>();
  for (const entry of ledger.entries) {
    const until = Date.parse(entry.snoozedUntil);
    if (Number.isFinite(until) && until > now.getTime()) {
      out.add(entry.id);
    }
  }
  return out;
}

/**
 * Snooze a cross-repo proposal. Stale entries are filtered at read time.
 *
 * #838 — write-side dedup. If an entry with this `(targetRepoId,
 * directiveId)` pair (i.e. same composite id) already exists, update its
 * `snoozedUntil` rather than appending. Same rationale as `snoozeProposal`
 * in `proposer.ts`: a rapid double-click on Dismiss used to leave two rows.
 */
export function snoozeCrossRepoProposal(input: {
  targetRepoId: string;
  directiveId: string;
}): SnoozeEntry {
  const id = makeProposalId(input.targetRepoId, input.directiveId);
  const snoozedUntil = new Date(Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const entry: SnoozeEntry = {
    id,
    targetRepoId: input.targetRepoId,
    directiveId: input.directiveId,
    snoozedUntil,
  };
  const ledger = readSnoozeLedger();
  const existingIdx = ledger.entries.findIndex((e) => e.id === id);
  if (existingIdx >= 0) {
    ledger.entries[existingIdx] = entry;
  } else {
    ledger.entries.push(entry);
  }
  writeSnoozeLedger(ledger);
  return entry;
}

// ── directive origin map (#855 circular guard) ───────────────────────────
//
// When the operator accepts a cross-repo proposal, the new directive in the
// target repo is structurally identical to the source's directive — same
// title and body, scoped to the target. The next 30-min tick will then see
// "target has a directive that source doesn't [yet]" and propose source ←
// target, which is the same rule bouncing back. To break the cycle we keep
// a sidecar map that records the origin repo of every accepted proposal.
//
// File: ~/.o8/directive-origins.json
//   { version: 1, entries: [ { directiveId, originRepoId, recordedAt } ] }
//
// Rules:
//   - When `proposeAcrossRepos` is evaluating "should we propose D from B
//     to A", look up D's origin. If origin is A, skip.
//   - This naturally handles transitive chains too: if D was originally
//     C → A → B, B's directive has origin C; proposer will skip B → C and
//     also won't propose B → A because once the operator accepted C → A, we
//     also recorded A's directive with origin C, which means the proposer
//     never proposed A → B (origin would be C, target B is fine to propose
//     to, but… see below). The minimal correctness guarantee here is "never
//     propose D back to its immediate origin"; a deeper provenance chain is
//     left for a follow-up if dogfooding shows it's needed.
//   - Locally-edited directives (origin == null) are not recorded — absence
//     means "this repo authored the directive itself". The check is "skip
//     if origin matches target", so missing entries never block a proposal.

interface OriginEntry {
  directiveId: string;
  originRepoId: string;
  recordedAt: string; // ISO-8601
}

interface OriginLedger {
  version: 1;
  entries: OriginEntry[];
}

function originFilePath(): string {
  return join(getDataDir(), ORIGIN_FILE);
}

function readOriginLedger(): OriginLedger {
  const path = originFilePath();
  if (!existsSync(path)) return { version: 1, entries: [] };
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<OriginLedger>;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return { version: 1, entries: [] };
    }
    const entries = parsed.entries.filter(
      (e): e is OriginEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof e.directiveId === 'string' &&
        typeof e.originRepoId === 'string' &&
        typeof e.recordedAt === 'string',
    );
    return { version: 1, entries };
  } catch (err) {
    console.warn('[cross-repo-proposer] Failed to parse origin ledger:', err instanceof Error ? err.message : err);
    return { version: 1, entries: [] };
  }
}

function writeOriginLedger(ledger: OriginLedger): void {
  try {
    writeFileSync(originFilePath(), JSON.stringify(ledger, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[cross-repo-proposer] Failed to write origin ledger:', err instanceof Error ? err.message : err);
  }
}

function originRepoIdFor(directiveId: string): string | null {
  const ledger = readOriginLedger();
  for (const entry of ledger.entries) {
    if (entry.directiveId === directiveId) return entry.originRepoId;
  }
  return null;
}

/**
 * Record that `directiveId` originated in `originRepoId`. Called by the
 * cross-repo proposals POST route on `action: 'accept'`. Idempotent — if an
 * entry with this directiveId already exists, the originRepoId is updated
 * (last-writer-wins, matches snooze dedup behavior in #838).
 */
export function recordDirectiveOrigin(input: {
  directiveId: string;
  originRepoId: string;
}): OriginEntry {
  const entry: OriginEntry = {
    directiveId: input.directiveId,
    originRepoId: input.originRepoId,
    recordedAt: new Date().toISOString(),
  };
  const ledger = readOriginLedger();
  const existingIdx = ledger.entries.findIndex((e) => e.directiveId === input.directiveId);
  if (existingIdx >= 0) {
    ledger.entries[existingIdx] = entry;
  } else {
    ledger.entries.push(entry);
  }
  writeOriginLedger(ledger);
  return entry;
}

// ── proposal id + similarity ──────────────────────────────────────────────

function makeProposalId(targetRepoId: string, directiveId: string): string {
  return createHash('sha1')
    .update(`${targetRepoId}::${directiveId}`, 'utf-8')
    .digest('hex')
    .slice(0, 16);
}

function jaccard(aDeps: string[], bDeps: string[]): number {
  if (aDeps.length === 0 && bDeps.length === 0) return 0;
  const setA = new Set(aDeps);
  const setB = new Set(bDeps);
  let intersect = 0;
  for (const dep of setA) {
    if (setB.has(dep)) intersect += 1;
  }
  const union = setA.size + setB.size - intersect;
  if (union === 0) return 0;
  return intersect / union;
}

// ── source-repo resolution for a directive ───────────────────────────────

function findSourceRepo(
  directive: DirectiveSummary,
  repos: RepoRegistryEntry[],
): RepoRegistryEntry | null {
  // #899 — `scope: project` directives already span every member repo of the
  // listed Projects. They're the explicit cross-repo solution, so the proposer
  // never fans them out further. Skip before scope/repoName resolution.
  if (directive.scope?.toLowerCase() === 'project') return null;

  // Repo-scoped directive: front matter `repoName: <name>` or `scope: <name>`.
  const declared = (directive.repoName || directive.scope || '').toLowerCase();
  if (declared && declared !== 'global' && declared !== 'repo') {
    const match = repos.find((r) => r.name.toLowerCase() === declared);
    if (match) return match;
  }
  // Some directives use `scope: repo` + `repoName:` — handled by the branch above.
  // `scope: global` directives never propose cross-repo (they already apply
  // everywhere); return null so the caller skips them.
  return null;
}

// ── public surface ────────────────────────────────────────────────────────

export interface CrossRepoProposalCandidate {
  /**
   * Discriminator so `DirectiveProposalRow` can render both auto rows and
   * cross-repo rows from a shared list. Always `'cross-repo'` here.
   */
  source: 'cross-repo';
  id: string;
  /** Repo the operator will see this proposal in. */
  targetRepoId: string;
  targetRepoName: string;
  /** Repo the directive originated from. */
  sourceRepoId: string;
  sourceRepoName: string;
  /** Directive payload. */
  directiveId: string;
  directiveTitle: string;
  directiveBody: string;
  directivePriority: number | null;
  /**
   * Match score in [0..1].
   *   - Default path (#899): always 1.0 — the link is an explicit Project
   *     membership, not a fuzzy stack overlap.
   *   - Legacy path (Jaccard, gated by O8_LEGACY_JACCARD_PROPOSER): Jaccard
   *     similarity over stack signatures, ≥ SIMILARITY_THRESHOLD.
   */
  similarity: number;
  /** Pre-rendered draft text the chat composer fills with on Accept. */
  draftDirective: string;
}

export interface ProposeAcrossReposOutput {
  /**
   * Map of directive id → list of target repo IDs that meet the similarity
   * threshold (and aren't snoozed). Useful for callers that just need to
   * know "who to fan this out to".
   */
  byDirective: Record<string, string[]>;
  /** Flat list — what the API surface returns. */
  candidates: CrossRepoProposalCandidate[];
}

interface ProposeOptions {
  /** Override "now" for tests. */
  now?: Date;
  /** Cap on candidates returned. */
  limit?: number;
}

function buildDraft(directive: DirectiveSummary, target: RepoRegistryEntry): string {
  // Re-emit the directive body with target repo metadata patched in. The
  // operator edits before saving — this is a starting point, not a final
  // form. Keeping the existing body verbatim avoids "lossy translation"
  // surprises.
  return [
    `# ${directive.title}`,
    '',
    `Imported from \`${directive.repoName ?? '(source repo)'}\` for \`${target.name}\`.`,
    '',
    'Original rule:',
    '',
    directive.body || '_(empty body — the source directive has no description)_',
  ].join('\n');
}

/**
 * #899 — collect every peer repo id for a source repo via its project
 * memberships. "Peer" = "in any of the same Projects as the source", excluding
 * the source itself. Empty Set when the source has no project links or the
 * Projects DB is unavailable.
 */
function collectProjectPeers(sourceRepoId: string): Set<string> {
  const peers = new Set<string>();
  let projects: Array<{ id: string; repos: Array<{ repoId: string }> }> = [];
  try {
    projects = listProjectsByRepoId(sourceRepoId);
  } catch {
    return peers;
  }
  for (const project of projects) {
    for (const link of project.repos) {
      if (link.repoId !== sourceRepoId) peers.add(link.repoId);
    }
  }
  return peers;
}

/**
 * Compute proposals for every registered repo.
 *
 * #899 default path: for each `scope: repo` directive, find its source repo,
 * then propose to every peer repo that shares at least one Project with the
 * source. The Jaccard candidate-selection step that gated #748 production-inert
 * has been replaced by this explicit-membership lookup.
 *
 * Returns an empty result when:
 *   - the registry is unreadable
 *   - no repo-scoped directives exist
 *   - no Projects link the source repo to any other repo (and legacy gate off)
 *
 * Set `O8_LEGACY_JACCARD_PROPOSER=1` to fall back to the pre-#899 behavior.
 */
export async function proposeAcrossRepos(
  options: ProposeOptions = {},
): Promise<ProposeAcrossReposOutput> {
  const limit = options.limit ?? MAX_CANDIDATES;
  const now = options.now ?? new Date();
  const useLegacy = isLegacyJaccardEnabled();

  let repos: RepoRegistryEntry[] = [];
  try {
    repos = await listRepos();
  } catch {
    return { byDirective: {}, candidates: [] };
  }

  // #899 — the legacy floor of `repos.length < 3` was a Jaccard-era guard
  // ("≥ 3 sharing a stack"). With explicit Projects, two repos in one Project
  // is a perfectly valid fan-out target, so we drop that gate on the default
  // path and keep it only when the legacy flag is on.
  if (useLegacy && repos.length < 3) return { byDirective: {}, candidates: [] };

  // Legacy path also needs stack signatures. The default path doesn't load
  // them — saves the I/O when the operator has opted into Projects.
  let sigByRepoId: Map<string, string[]> | null = null;
  if (useLegacy) {
    const signatureStore = await readOrComputeSignatures();
    sigByRepoId = new Map<string, string[]>();
    for (const sig of signatureStore.signatures) {
      sigByRepoId.set(sig.repoId, sig.deps);
    }
  }

  const directives = readAllDirectives();
  if (directives.length === 0) return { byDirective: {}, candidates: [] };

  const snoozed = activeSnoozedIds(now);
  const candidates: CrossRepoProposalCandidate[] = [];
  const byDirective: Record<string, string[]> = {};

  for (const directive of directives) {
    const sourceRepo = findSourceRepo(directive, repos);
    if (!sourceRepo) continue;

    // #855 — circular propagation guard. If this directive was previously
    // accepted from another repo, its origin is recorded in the sidecar
    // ledger. Never propose it back to that origin. Applied uniformly on
    // both paths so the guard survives env-flag toggles.
    const directiveOrigin = originRepoIdFor(directive.id);

    const similarRepos: { repo: RepoRegistryEntry; similarity: number }[] = [];

    if (useLegacy && sigByRepoId) {
      // ── Legacy Jaccard path (gated; preserves pre-#899 behavior) ─────────
      const sourceDeps = sigByRepoId.get(sourceRepo.id);
      // No signature recorded yet — skip (boot tick will fix it on next pass).
      if (!sourceDeps || sourceDeps.length === 0) continue;

      for (const target of repos) {
        if (target.id === sourceRepo.id) continue;
        if (directiveOrigin && target.id === directiveOrigin) continue;
        const targetDeps = sigByRepoId.get(target.id);
        if (!targetDeps || targetDeps.length === 0) continue;
        const sim = jaccard(sourceDeps, targetDeps);
        if (sim >= SIMILARITY_THRESHOLD) {
          similarRepos.push({ repo: target, similarity: sim });
        }
      }

      // Legacy spec: only fire when ≥ 2 similar repos exist (3 total counting
      // source). One similar peer isn't a "stack" worth fanning out to.
      if (similarRepos.length < MIN_SIMILAR_REPOS) continue;
    } else {
      // ── #899 Project-membership path (default) ───────────────────────────
      // Look up the source repo's project peers. Empty set when the source
      // isn't in any Project (operator hasn't grouped it yet) or the Projects
      // DB is unavailable; either way, no proposals fire — which is the
      // correct behavior. Operators opt into cross-repo by grouping repos.
      const peerIds = collectProjectPeers(sourceRepo.id);
      if (peerIds.size === 0) continue;

      for (const target of repos) {
        if (target.id === sourceRepo.id) continue;
        // Origin guard — same rule as the Jaccard path.
        if (directiveOrigin && target.id === directiveOrigin) continue;
        if (!peerIds.has(target.id)) continue;
        similarRepos.push({ repo: target, similarity: PROJECT_MEMBERSHIP_SCORE });
      }

      // No floor on peer count — a 2-repo Project is a valid fan-out target.
      if (similarRepos.length === 0) continue;
    }

    byDirective[directive.id] = similarRepos.map((s) => s.repo.id);
    for (const { repo: target, similarity } of similarRepos) {
      const id = makeProposalId(target.id, directive.id);
      if (snoozed.has(id)) continue;
      candidates.push({
        source: 'cross-repo',
        id,
        targetRepoId: target.id,
        targetRepoName: target.name,
        sourceRepoId: sourceRepo.id,
        sourceRepoName: sourceRepo.name,
        directiveId: directive.id,
        directiveTitle: directive.title,
        directiveBody: directive.body,
        directivePriority: directive.priority,
        similarity,
        draftDirective: buildDraft(directive, target),
      });
    }
  }

  // Sort by similarity (highest match first), then alphabetically by target
  // name so output stays stable across recomputes. Project-membership matches
  // all share PROJECT_MEMBERSHIP_SCORE, so the alphabetic tiebreak does the
  // real ordering work on the default path.
  candidates.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity;
    if (a.targetRepoName !== b.targetRepoName) return a.targetRepoName.localeCompare(b.targetRepoName);
    return a.directiveTitle.localeCompare(b.directiveTitle);
  });

  return {
    byDirective,
    candidates: candidates.slice(0, limit),
  };
}

// ── boot tick wiring ──────────────────────────────────────────────────────

let bootTickFired = false;
// #851 — a directive add/edit, repo add/remove or new outcome row should
// surface within five minutes. Reads refresh a snapshot older than this in the
// background instead of a timer recomputing it for nobody; registry changes
// clear it outright, and `?force=1` recomputes inline.
const STALE_AFTER_MS = 5 * 60 * 1000;

let cachedCandidates: CrossRepoProposalCandidate[] = [];
let cachedAt = 0;
let inFlight: Promise<void> | null = null;

function runTick(): Promise<void> {
  inFlight ??= (async () => {
    try {
      const result = await proposeAcrossRepos();
      cachedCandidates = result.candidates;
      cachedAt = Date.now();
    } catch (err) {
      console.warn('[cross-repo-proposer] tick threw:', err instanceof Error ? err.message : err);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Idempotent boot hook: one computation at boot so the first read is warm. */
export function ensureCrossRepoProposerBootTick(): void {
  if (bootTickFired) return;
  bootTickFired = true;
  setImmediate(() => {
    void runTick();
  });
}

/**
 * #851 — `force` bypasses the cache and recomputes inline so a fresh repo
 * add, directive edit, or outcome row surfaces immediately. A snapshot older
 * than five minutes is returned as is and refreshed for the next read.
 */
export async function readCachedCrossRepoProposals(
  options: { force?: boolean; now?: number } = {},
): Promise<{
  candidates: CrossRepoProposalCandidate[];
  computedAt: number;
}> {
  if (options.force || cachedAt === 0) {
    await runTick();
  } else if ((options.now ?? Date.now()) - cachedAt >= STALE_AFTER_MS) {
    void runTick();
  }
  return { candidates: cachedCandidates, computedAt: cachedAt };
}

/**
 * #851 — Drop the cached payload so the next read recomputes from scratch.
 * Call sites: any registry mutation (repo add/remove), any directive write,
 * any new outcome row that shifts the candidate set. Cheap — no I/O, just
 * zeroes the in-memory state so the next read falls through to `runTick()`.
 */
export function invalidateCrossRepoProposerCache(): void {
  cachedCandidates = [];
  cachedAt = 0;
}
