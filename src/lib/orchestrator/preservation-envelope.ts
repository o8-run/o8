import {
  PRESERVATION_ADD_BUDGET_RATIO,
  PRESERVATION_DELETE_BUDGET_RATIO,
  PRESERVATION_MIN_DELETE_BUDGET,
} from '@/lib/lane/merge-gate';
import { readFileFacts, trackedFiles } from '@/lib/repo-files/lookup';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { truncateText } from '@/lib/util/text';

/**
 * Files explicitly allowed to exceed the 600-line threshold.
 * These are layout orchestrators, multiplexers, or other files whose
 * size is inherent to their role (wiring many hooks/components together).
 * Relative paths from repo root, forward-slash separated.
 */
export const FILE_SIZE_WAIVERS = new Set([
  'src/app/dashboard/page.tsx',   // Layout orchestrator — wires 10+ hooks, providers, JSX tree
  'src/ws-server.ts',             // WebSocket multiplexer — channel handlers are co-located by design
]);

export const FILE_SIZE_BLOCK_THRESHOLD_LINES = 800;

const FILE_SIZE_WARNING_BUFFER_LINES = 100;
const FILE_SIZE_WARNING_THRESHOLD_LINES = FILE_SIZE_BLOCK_THRESHOLD_LINES - FILE_SIZE_WARNING_BUFFER_LINES;
const MAX_THRESHOLD_GUIDANCE_FILES = 6;
const PATH_TEXT_CHAR_PATTERN = /[A-Za-z0-9._/-]/;
const PRESERVATION_MAX_EXPORTS = 12;

function buildPacketScopeText(packet: OrchestratorPacket): string {
  return [packet.title, packet.summary]
    .map((value) => value.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\\/g, '/')
    .toLowerCase();
}

function hasPathTokenBoundary(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) {
    return true;
  }
  return !PATH_TEXT_CHAR_PATTERN.test(text[index] ?? '');
}

function includesPathToken(text: string, candidate: string): boolean {
  let fromIndex = 0;

  while (fromIndex < text.length) {
    const matchIndex = text.indexOf(candidate, fromIndex);
    if (matchIndex === -1) {
      return false;
    }

    const beforeIndex = matchIndex - 1;
    const afterIndex = matchIndex + candidate.length;
    if (hasPathTokenBoundary(text, beforeIndex) && hasPathTokenBoundary(text, afterIndex)) {
      return true;
    }

    fromIndex = matchIndex + candidate.length;
  }

  return false;
}

interface NamedFile {
  relativePath: string;
  lineCount: number;
  exports: string[];
}

function formatThresholdFiles(files: NamedFile[]): string {
  if (files.length === 0) {
    return '';
  }

  const sorted = [...files].sort((left, right) => (
    right.lineCount - left.lineCount || left.relativePath.localeCompare(right.relativePath)
  ));

  if (sorted.length <= MAX_THRESHOLD_GUIDANCE_FILES) {
    return sorted.map((file) => `${file.relativePath} (${file.lineCount}L)`).join(', ');
  }

  return `${sorted.slice(0, MAX_THRESHOLD_GUIDANCE_FILES).map((file) => `${file.relativePath} (${file.lineCount}L)`).join(', ')} (+${sorted.length - MAX_THRESHOLD_GUIDANCE_FILES} more)`;
}

function formatExportList(exports: string[]): string {
  if (exports.length === 0) {
    return '';
  }

  const lines = exports
    .slice(0, PRESERVATION_MAX_EXPORTS)
    .map((signature) => `  - ${truncateText(signature, 120)}`);

  if (exports.length > PRESERVATION_MAX_EXPORTS) {
    lines.push(`  - (+${exports.length - PRESERVATION_MAX_EXPORTS} more exports)`);
  }

  return lines.join('\n');
}

// ── Pre-dispatch file overlap gate (#380) ──

/**
 * Predict which files a packet will touch: tracked paths its title or summary
 * names. File-level matches only — directory mentions would over-serialize.
 * Reads `git ls-files` (cached until HEAD or the index changes); an unreadable
 * repository predicts nothing.
 */
export async function computePredictedFiles(packet: OrchestratorPacket): Promise<string[]> {
  const repoPath = packet.workspaceTargetPath;
  if (!repoPath) return [];

  const scopeText = buildPacketScopeText(packet);
  if (!scopeText) return [];

  const tracked = await trackedFiles(repoPath);
  if (!tracked) return [];
  return tracked.files.filter((filePath) => includesPathToken(scopeText, filePath.toLowerCase()));
}

/** Facts for the existing files a packet names, read fresh from the checkout. */
async function namedFiles(packet: OrchestratorPacket): Promise<NamedFile[]> {
  const repoPath = packet.workspaceTargetPath;
  if (!repoPath) return [];
  const files = packet.predictedFiles ?? await computePredictedFiles(packet);
  if (files.length === 0) return [];
  const facts = await readFileFacts(repoPath, files);
  return files.flatMap((relativePath) => {
    const fact = facts.get(relativePath);
    return fact ? [{ relativePath, lineCount: fact.lineCount, exports: fact.exports }] : [];
  });
}

/**
 * Filter a list of dispatchable packets to avoid parallel dispatch of packets
 * that touch the same files. Returns one packet per overlapping cluster.
 * Non-overlapping packets all pass through. Reads `predictedFiles`, which the
 * dispatch tick fills from `computePredictedFiles` first.
 */
export function filterOverlappingPackets(
  packets: OrchestratorPacket[],
  activePackets: OrchestratorPacket[],
): OrchestratorPacket[] {
  if (packets.length === 0 || (packets.length === 1 && activePackets.length === 0)) return packets;

  // Compute predicted files for each candidate and active packet
  const predictions = new Map<string, Set<string>>();
  for (const p of [...packets, ...activePackets]) {
    predictions.set(p.id, new Set(p.predictedFiles ?? []));
  }

  // Files already claimed by active (running) packets
  const claimedFiles = new Set<string>();
  for (const p of activePackets) {
    const files = predictions.get(p.id);
    if (files) files.forEach((f) => claimedFiles.add(f));
  }

  const result: OrchestratorPacket[] = [];
  const newlyClaimed = new Set<string>();

  for (const packet of packets) {
    const files = predictions.get(packet.id) ?? new Set<string>();
    if (files.size === 0) {
      // No predicted files — safe to dispatch
      result.push(packet);
      continue;
    }

    // Check overlap with active packets and already-selected candidates
    let hasOverlap = false;
    for (const f of files) {
      if (claimedFiles.has(f) || newlyClaimed.has(f)) {
        hasOverlap = true;
        break;
      }
    }

    if (hasOverlap) {
      console.log(`[overlap-gate] Holding packet ${packet.id} — file overlap with active/queued work`);
      continue;
    }

    result.push(packet);
    files.forEach((f) => newlyClaimed.add(f));
  }

  return result;
}

export async function checkFileSizeThresholds(packet: OrchestratorPacket): Promise<string[]> {
  const matchedFiles = await namedFiles(packet);
  if (matchedFiles.length === 0) {
    return [];
  }

  // Filter out waived files — layout orchestrators and multiplexers that are
  // legitimately large due to their architectural role
  const nonWaivedFiles = matchedFiles.filter((file) => !FILE_SIZE_WAIVERS.has(file.relativePath));

  const blockFiles = nonWaivedFiles.filter((file) => file.lineCount > FILE_SIZE_BLOCK_THRESHOLD_LINES);
  const warningFiles = nonWaivedFiles.filter((file) => (
    file.lineCount > FILE_SIZE_WARNING_THRESHOLD_LINES
    && file.lineCount <= FILE_SIZE_BLOCK_THRESHOLD_LINES
  ));

  if (blockFiles.length === 0 && warningFiles.length === 0) {
    return [];
  }

  return [
    'File size governance:',
    blockFiles.length > 0
      ? `Block threshold hit (> ${FILE_SIZE_BLOCK_THRESHOLD_LINES} lines): ${formatThresholdFiles(blockFiles)}.`
      : null,
    warningFiles.length > 0
      ? `Warning threshold hit (> ${FILE_SIZE_WARNING_THRESHOLD_LINES} lines): ${formatThresholdFiles(warningFiles)}.`
      : null,
    'Decompose before implementing. Extract a helper, module, or split responsibility before adding significant new logic to flagged files.',
    'If a flagged file still needs edits, keep the diff surgical and surface any required follow-up refactor, review handoff, or operator decision explicitly.',
  ].filter((value): value is string => Boolean(value));
}

/**
 * Build a preservation envelope for existing files referenced by this packet.
 * Injects diff budgets + structural contracts so agents don't rewrite files.
 * (#482) — Proved effective in Round 2 dogfooding: P3 was a clean merge.
 */
export async function buildPreservationEnvelope(packet: OrchestratorPacket): Promise<string[]> {
  const matchedFiles = await namedFiles(packet);
  if (matchedFiles.length === 0) {
    return [];
  }

  // Only envelope files that actually exist and have content — new files get no envelope
  const existingFiles = matchedFiles.filter((file) => file.lineCount > 0);
  if (existingFiles.length === 0) {
    return [];
  }

  const sections: string[] = ['File preservation contracts (DO NOT REWRITE existing files):'];

  for (const file of existingFiles.slice(0, MAX_THRESHOLD_GUIDANCE_FILES)) {
    const addBudget = Math.ceil(file.lineCount * PRESERVATION_ADD_BUDGET_RATIO);
    const deleteBudget = Math.max(PRESERVATION_MIN_DELETE_BUDGET, Math.ceil(file.lineCount * PRESERVATION_DELETE_BUDGET_RATIO));
    const exportList = formatExportList(file.exports);

    sections.push(
      `${file.relativePath} (${file.lineCount} lines):`,
      `  DIFF BUDGET: add up to ${addBudget} lines, delete no more than ${deleteBudget} existing lines.`,
      '  Make surgical additions only — do not rewrite or reorganize existing code.',
    );

    if (exportList) {
      sections.push(
        '  STRUCTURAL CONTRACT — these exports MUST be preserved:',
        exportList,
      );
    }
  }

  sections.push('If your task cannot be completed within these budgets, surface it as a blocker to the operator.');

  return sections;
}
