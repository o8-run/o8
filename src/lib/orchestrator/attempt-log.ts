import type { OutcomeMemoryProvenance } from '@/lib/cortex/memory-provenance';
import { isOutcomeForgotten } from '@/lib/cortex/outcome-exclusion';
import { readMemoryRevision } from '@/lib/cortex/memory-revision';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import type { PacketSelfReview } from '@/lib/orchestrator/types';
import { truncateText } from '@/lib/util/text';

const ATTEMPT_LEARNINGS_RELATIVE_PATH = path.join('.o8', 'attempt-learnings.md');
const ATTEMPT_LEARNING_JSON_BLOCK_PATTERN = /```json\s*([\s\S]*?)\s*```/g;
const MAX_ATTEMPT_LEARNINGS = 3;
const MAX_TYPECHECK_OUTPUT_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 500;
const MAX_FILES_CHANGED = 12;
const MAX_ERROR_LINES = 3;
const MAX_ERROR_LINE_CHARS = 240;
const FILE_REFERENCE_PATTERN = /([A-Za-z0-9_./-]+\.(?:tsx|ts|jsx|js|mjs|cjs|mts|cts|json|css|scss|md))(?:\(\d+,\d+\)|:\d+(?::\d+)?)?/g;

export interface AttemptLearning extends OutcomeMemoryProvenance {
  attempt: number;
  timestamp: string;
  typecheckOutput?: string;
  selfReviewSummary?: string;
  filesChanged: string[];
  summary: string;
}

export type AttemptLearningDraft = Omit<AttemptLearning, 'attempt' | 'timestamp'>;

interface StoredAttemptLearning extends AttemptLearning {
  packetId?: string;
}

function getAttemptLearningsPath(worktreePath: string) {
  return path.join(worktreePath, ATTEMPT_LEARNINGS_RELATIVE_PATH);
}

// #1500 — learnings must survive worktree churn. A verification-failed respawn
// often mints a FRESH worktree (clone from main), so a worktree-local learnings
// file evaporates exactly when the next attempt needs it. The packet-keyed copy
// in the data dir is the canonical store; the worktree copy remains for the
// worker's own visibility mid-attempt.
function getPacketLearningsPath(packetId: string) {
  return path.join(getDataDir(), 'attempt-learnings', `${packetId}.md`);
}

function normalizeStringList(value: unknown, maxItems = MAX_FILES_CHANGED): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const items: string[] = [];
  for (const entry of value) {
    const normalized = typeof entry === 'string' ? entry.trim() : '';
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    items.push(normalized);
    if (items.length >= maxItems) {
      break;
    }
  }
  return items;
}

function normalizeAttemptLearning(value: unknown): StoredAttemptLearning | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const learning = value as Partial<StoredAttemptLearning>;
  const attempt = typeof learning.attempt === 'number' && Number.isFinite(learning.attempt) && learning.attempt >= 0
    ? Math.floor(learning.attempt)
    : null;
  const timestamp = typeof learning.timestamp === 'string' && learning.timestamp.trim()
    ? learning.timestamp
    : '';
  const summary = truncateText(
    typeof learning.summary === 'string' ? learning.summary : '',
    MAX_SUMMARY_CHARS,
    { normalizeWhitespace: true },
  );

  if (attempt === null || !timestamp || !summary) {
    return null;
  }

  const typecheckOutput = truncateText(learning.typecheckOutput, MAX_TYPECHECK_OUTPUT_CHARS);
  const selfReviewSummary = truncateText(learning.selfReviewSummary, MAX_SUMMARY_CHARS, {
    normalizeWhitespace: true,
  });

  return {
    sourceOutcomeId: typeof learning.sourceOutcomeId === 'string' ? learning.sourceOutcomeId : undefined,
    sourceOutcomeFingerprint: typeof learning.sourceOutcomeFingerprint === 'string' ? learning.sourceOutcomeFingerprint : undefined,
    memoryRevision: typeof learning.memoryRevision === 'string' ? learning.memoryRevision : undefined,
    packetId: typeof learning.packetId === 'string' && learning.packetId.trim() ? learning.packetId.trim() : undefined,
    attempt,
    timestamp,
    typecheckOutput: typecheckOutput || undefined,
    selfReviewSummary: selfReviewSummary || undefined,
    filesChanged: normalizeStringList(learning.filesChanged),
    summary,
  };
}

function serializeAttemptLearning(learning: StoredAttemptLearning) {
  return JSON.stringify({
    packetId: learning.packetId,
    sourceOutcomeId: learning.sourceOutcomeId,
    sourceOutcomeFingerprint: learning.sourceOutcomeFingerprint,
    memoryRevision: learning.memoryRevision,
    attempt: learning.attempt,
    timestamp: learning.timestamp,
    typecheckOutput: learning.typecheckOutput,
    selfReviewSummary: learning.selfReviewSummary,
    filesChanged: learning.filesChanged,
    summary: learning.summary,
  }, null, 2);
}

function renderAttemptLearnings(entries: StoredAttemptLearning[]) {
  const lines = [
    '# Attempt Learnings',
    '',
    'Latest bounded learnings captured from failed retry attempts.',
  ];

  for (const learning of entries) {
    lines.push(
      '',
      `## Packet ${learning.packetId ?? 'unknown'} attempt ${learning.attempt}`,
      '',
      '```json',
      serializeAttemptLearning(learning),
      '```',
    );
  }

  return `${lines.join('\n')}\n`;
}

async function parseLearningsFile(filePath: string): Promise<StoredAttemptLearning[]> {
  const raw = await readFile(filePath, 'utf8').catch(() => '');
  if (!raw.trim()) {
    return [];
  }

  const entries: StoredAttemptLearning[] = [];
  for (const match of raw.matchAll(ATTEMPT_LEARNING_JSON_BLOCK_PATTERN)) {
    const jsonBlock = match[1]?.trim();
    if (!jsonBlock) {
      continue;
    }

    try {
      const parsed = JSON.parse(jsonBlock) as unknown;
      const normalized = normalizeAttemptLearning(parsed);
      if (normalized) {
        entries.push(normalized);
      }
    } catch {
      // Ignore malformed entries so one bad block does not poison the file.
    }
  }

  return entries.slice(-MAX_ATTEMPT_LEARNINGS);
}

async function readStoredAttemptLearnings(worktreePath: string): Promise<StoredAttemptLearning[]> {
  const normalizedWorktreePath = worktreePath.trim();
  if (!normalizedWorktreePath) {
    return [];
  }
  return parseLearningsFile(getAttemptLearningsPath(normalizedWorktreePath));
}

async function readStoredPacketLearnings(packetId: string): Promise<StoredAttemptLearning[]> {
  const normalizedPacketId = packetId.trim();
  if (!normalizedPacketId) {
    return [];
  }
  return parseLearningsFile(getPacketLearningsPath(normalizedPacketId));
}

function mergeLearningEntries(
  primary: StoredAttemptLearning[],
  secondary: StoredAttemptLearning[],
): StoredAttemptLearning[] {
  const byAttempt = new Map<number, StoredAttemptLearning>();
  for (const entry of [...secondary, ...primary]) {
    byAttempt.set(entry.attempt, entry);
  }
  return [...byAttempt.values()]
    .sort((left, right) => left.attempt - right.attempt)
    .slice(-MAX_ATTEMPT_LEARNINGS);
}

function extractTypecheckErrorLines(typecheckOutput?: string): string[] {
  if (!typecheckOutput?.trim()) {
    return [];
  }

  const seen = new Set<string>();
  const allLines = typecheckOutput
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const errorLines = allLines.filter((line) => /error\b/i.test(line));
  // #1500 — rule-check violations ("file grew past the 800-line ceiling…")
  // rarely contain the word "error". An empty extraction here collapsed the
  // learning summary to a generic retry note, so the next attempt learned
  // nothing. Fall back to the head of the output when no error-lines match.
  const lines = errorLines.length > 0 ? errorLines : allLines;

  return lines.reduce<string[]>((current, line) => {
    if (current.length >= MAX_ERROR_LINES) {
      return current;
    }

    const normalized = truncateText(line, MAX_ERROR_LINE_CHARS, { normalizeWhitespace: true });
    if (!normalized || seen.has(normalized)) {
      return current;
    }

    seen.add(normalized);
    current.push(normalized);
    return current;
  }, []);
}

function extractReferencedFiles(input: string): string[] {
  const seen = new Set<string>();
  const matches = input.matchAll(FILE_REFERENCE_PATTERN);
  const files: string[] = [];

  for (const match of matches) {
    const candidate = match[1]?.trim();
    if (!candidate || seen.has(candidate)) {
      continue;
    }

    seen.add(candidate);
    files.push(candidate);
    if (files.length >= MAX_FILES_CHANGED) {
      break;
    }
  }

  return files;
}

function buildSelfReviewSummary(selfReview?: PacketSelfReview): string | undefined {
  if (!selfReview) {
    return undefined;
  }

  const issues = Array.isArray(selfReview.issuesFound) && selfReview.issuesFound.length > 0
    ? `Issues: ${selfReview.issuesFound.map((issue) => issue.trim()).filter(Boolean).join('; ')}`
    : '';
  const evidence = Array.isArray(selfReview.evidence) && selfReview.evidence.length > 0
    ? `Evidence: ${truncateText(selfReview.evidence.map((entry) => entry.trim()).filter(Boolean).join('; '), 80, { normalizeWhitespace: true })}`
    : '';
  const summary = truncateText(
    [
      selfReview.decision ? `Decision: ${selfReview.decision}` : '',
      selfReview.residual
        ? `Residual: ${truncateText(selfReview.residual, 100, { normalizeWhitespace: true })}`
        : '',
      selfReview.recurrenceProtection
        ? `Recurrence protection: ${truncateText(selfReview.recurrenceProtection, 90, { normalizeWhitespace: true })}`
        : '',
      selfReview.outcome
        ? `Outcome: ${truncateText(selfReview.outcome, 100, { normalizeWhitespace: true })}`
        : '',
      evidence,
      `Summary: ${truncateText(selfReview.summary, 80, { normalizeWhitespace: true })}`,
      issues,
    ].filter(Boolean).join(' | '),
    MAX_SUMMARY_CHARS,
    { normalizeWhitespace: true },
  );

  return summary || undefined;
}

export function buildAttemptLearningFromFailure(
  typecheckOutput?: string,
  selfReview?: PacketSelfReview,
): AttemptLearningDraft {
  const normalizedTypecheckOutput = truncateText(typecheckOutput, MAX_TYPECHECK_OUTPUT_CHARS);
  const selfReviewSummary = buildSelfReviewSummary(selfReview);
  const keyErrors = extractTypecheckErrorLines(normalizedTypecheckOutput);
  const filesChanged = extractReferencedFiles([
    normalizedTypecheckOutput,
    selfReviewSummary,
    ...(selfReview?.issuesFound ?? []),
  ].filter(Boolean).join('\n'));
  const summary = truncateText(
    [
      keyErrors.length > 0 ? `Key errors: ${keyErrors.join(' | ')}` : '',
      selfReviewSummary ? `Self-review: ${selfReviewSummary}` : '',
    ].filter(Boolean).join(' | ') || 'Retry required after a failed attempt with limited diagnostics.',
    MAX_SUMMARY_CHARS,
    { normalizeWhitespace: true },
  );

  return {
    typecheckOutput: normalizedTypecheckOutput || undefined,
    selfReviewSummary,
    filesChanged,
    summary,
  };
}

function retainedLearning(entry: StoredAttemptLearning): boolean {
  // Legacy flattened content cannot be traced after a forget; never replay it from disk.
  return (entry.memoryRevision ?? '0') === readMemoryRevision()
    && (!entry.sourceOutcomeId || !isOutcomeForgotten(entry.sourceOutcomeId, entry.sourceOutcomeFingerprint));
}

function toPublicLearning(entry: StoredAttemptLearning): AttemptLearning {
  return {
    sourceOutcomeId: entry.sourceOutcomeId,
    sourceOutcomeFingerprint: entry.sourceOutcomeFingerprint,
    memoryRevision: entry.memoryRevision,
    attempt: entry.attempt,
    timestamp: entry.timestamp,
    typecheckOutput: entry.typecheckOutput,
    selfReviewSummary: entry.selfReviewSummary,
    filesChanged: entry.filesChanged,
    summary: entry.summary,
  };
}

export async function readAttemptLearnings(worktreePath: string): Promise<AttemptLearning[]> {
  const entries = await readStoredAttemptLearnings(worktreePath);
  return entries.filter(retainedLearning).map(toPublicLearning);
}

/**
 * #1500 — canonical read for respawn prompts: union of the packet-keyed store
 * (survives worktree churn) and the worktree-local file (covers mid-attempt
 * writes). Packet-store entries win on attempt-number collisions.
 */
export async function readPacketAttemptLearnings(
  packetId: string,
  worktreePath?: string | null,
): Promise<AttemptLearning[]> {
  const [packetEntries, worktreeEntries] = await Promise.all([
    readStoredPacketLearnings(packetId),
    worktreePath?.trim() ? readStoredAttemptLearnings(worktreePath) : Promise.resolve([]),
  ]);
  return mergeLearningEntries(packetEntries, worktreeEntries).filter(retainedLearning).map(toPublicLearning);
}

export async function persistAttemptLearnings(
  worktreePath: string,
  packetId: string,
  attempt: number,
  learning: AttemptLearningDraft,
): Promise<void> {
  const normalizedWorktreePath = worktreePath.trim();
  const normalizedPacketId = packetId.trim();

  const nextEntry = normalizeAttemptLearning({
    packetId: normalizedPacketId || undefined,
    attempt,
    timestamp: new Date().toISOString(),
    memoryRevision: readMemoryRevision(),
    ...learning,
  });
  if (!nextEntry) {
    return;
  }

  if (normalizedWorktreePath) {
    const filePath = getAttemptLearningsPath(normalizedWorktreePath);
    const currentEntries = await readStoredAttemptLearnings(normalizedWorktreePath);
    const nextEntries = mergeLearningEntries([nextEntry], currentEntries);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, renderAttemptLearnings(nextEntries), 'utf8');
  }

  // Packet-keyed copy — the one a fresh-worktree respawn actually reads.
  if (normalizedPacketId) {
    try {
      const packetPath = getPacketLearningsPath(normalizedPacketId);
      const currentEntries = await readStoredPacketLearnings(normalizedPacketId);
      const nextEntries = mergeLearningEntries([nextEntry], currentEntries);
      await mkdir(path.dirname(packetPath), { recursive: true });
      await writeFile(packetPath, renderAttemptLearnings(nextEntries), 'utf8');
    } catch (error) {
      console.warn(`[attempt-log] Failed to persist packet-keyed learnings for ${normalizedPacketId}:`, error);
    }
  }
}
