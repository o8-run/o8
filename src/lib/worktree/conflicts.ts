import { resolveGitBinary } from '@/lib/git/binary';
import { committedDiff } from '@/lib/worktree/committed-diff';
/**
 * Cross-Worktree Conflict Detection + Resolution
 *
 * File-level scanning runs every 5s when 2+ worktrees are active.
 * Line-level analysis runs on-demand when file overlap is detected.
 * Merge order recommendations calculated from change scope + completion order.
 *
 * @see https://github.com/o8-run/o8/issues/69
 */

import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import type { WorktreeInfo } from './types';

const execFileAsync = promisify(execFile);

// ── Types ──

export interface LineRange {
  start: number;
  count: number;
}

export interface FileConflictDetail {
  file: string;
  worktreeA: string;
  worktreeB: string;
  /** warning = same file different sections, conflict = overlapping lines */
  severity: 'warning' | 'conflict';
  /** Line ranges changed by worktree A */
  rangesA?: LineRange[];
  /** Line ranges changed by worktree B */
  rangesB?: LineRange[];
  /** Overlapping line ranges (only present for 'conflict' severity) */
  overlappingRanges?: Array<{ start: number; end: number }>;
}

export interface EnhancedConflictReport {
  /** All file-level overlaps with optional line detail */
  files: FileConflictDetail[];
  /** True if no overlapping files exist */
  safe: boolean;
  /** Total number of conflicting files */
  conflictCount: number;
  /** Total number of warning files (same file, different sections) */
  warningCount: number;
  /** Recommended merge order */
  mergeOrder: MergeOrderRecommendation[];
  /** When this report was generated */
  generatedAt: number;
}

export interface MergeOrderRecommendation {
  worktreeId: string;
  agentType: string;
  /** Position in recommended merge order (1 = merge first) */
  position: number;
  /** Why this position was recommended */
  reason: string;
  /** Total files changed by this worktree */
  fileCount: number;
  /** Total line changes (additions + deletions) */
  totalChanges: number;
}

// Critical files that should always flag for manual review
const CRITICAL_FILES = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  '.env',
  '.env.local',
  'next.config.ts',
  'next.config.js',
  'next.config.mjs',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'requirements.txt',
  'pyproject.toml',
]);

// ── File-Level Detection (Fast) ──

/**
 * Fast file-level conflict scan across all active worktrees.
 * Runs in <100ms — designed for 5s polling interval.
 */
export function detectFileOverlaps(worktrees: WorktreeInfo[]): FileConflictDetail[] {
  const active = worktrees.filter(
    (wt) => wt.dirtyFiles.length > 0,
  );

  const overlaps: FileConflictDetail[] = [];

  for (let i = 0; i < active.length; i++) {
    const filesA = new Set(active[i]!.dirtyFiles);
    for (let j = i + 1; j < active.length; j++) {
      for (const file of active[j]!.dirtyFiles) {
        if (filesA.has(file)) {
          const isCritical = CRITICAL_FILES.has(file.split('/').pop() ?? '');
          overlaps.push({
            file,
            worktreeA: active[i]!.id,
            worktreeB: active[j]!.id,
            // Critical files are always 'conflict', others start as 'warning' until line analysis
            severity: isCritical ? 'conflict' : 'warning',
          });
        }
      }
    }
  }

  return overlaps;
}

// ── Line-Level Detection (On-Demand) ──

/**
 * Parse git diff --unified=0 output to extract changed line ranges.
 *
 * Hunks look like: @@ -10,5 +10,8 @@ optional context
 * We extract the new side (+start,count).
 */
function parseHunkRanges(diffOutput: string): LineRange[] {
  const ranges: LineRange[] = [];
  const hunkPattern = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;

  let match: RegExpExecArray | null;
  while ((match = hunkPattern.exec(diffOutput)) !== null) {
    const start = parseInt(match[1]!, 10);
    const count = parseInt(match[2] ?? '1', 10);
    if (count > 0) {
      ranges.push({ start, count });
    }
  }

  return ranges;
}

/**
 * Check if two sets of line ranges overlap.
 */
function findOverlappingRanges(
  rangesA: LineRange[],
  rangesB: LineRange[],
): Array<{ start: number; end: number }> {
  const overlaps: Array<{ start: number; end: number }> = [];

  for (const a of rangesA) {
    const aEnd = a.start + a.count - 1;
    for (const b of rangesB) {
      const bEnd = b.start + b.count - 1;
      // Check overlap: ranges overlap if one starts before the other ends
      if (a.start <= bEnd && b.start <= aEnd) {
        overlaps.push({
          start: Math.max(a.start, b.start),
          end: Math.min(aEnd, bEnd),
        });
      }
    }
  }

  return overlaps;
}

/**
 * Get changed line ranges for a specific file in a worktree.
 * Uses git diff --unified=0 for minimal output.
 */
async function getFileLineRanges(
  worktreePath: string,
  baseBranch: string,
  filePath: string,
): Promise<LineRange[]> {
  try {
    // Committed changes since base
    const { stdout: committed } = await execFileAsync(resolveGitBinary(), [
      'diff', '--unified=0', `${baseBranch}...HEAD`, '--', filePath,
    ], { windowsHide: true, cwd: worktreePath, timeout: 5000 });

    // Uncommitted changes
    const { stdout: uncommitted } = await execFileAsync(resolveGitBinary(), [
      'diff', '--unified=0', '--', filePath,
    ], { windowsHide: true, cwd: worktreePath, timeout: 5000 });

    // Staged changes
    const { stdout: staged } = await execFileAsync(resolveGitBinary(), [
      'diff', '--unified=0', '--cached', '--', filePath,
    ], { windowsHide: true, cwd: worktreePath, timeout: 5000 });

    // Merge all ranges
    const allRanges = [
      ...parseHunkRanges(committed),
      ...parseHunkRanges(uncommitted),
      ...parseHunkRanges(staged),
    ];

    // Deduplicate overlapping ranges
    return mergeRanges(allRanges);
  } catch {
    return [];
  }
}

/**
 * Merge overlapping line ranges into non-overlapping spans.
 */
function mergeRanges(ranges: LineRange[]): LineRange[] {
  if (ranges.length === 0) return [];

  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [sorted[0]!];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const last = merged[merged.length - 1]!;
    const lastEnd = last.start + last.count;

    if (current.start <= lastEnd) {
      // Overlap — extend
      const newEnd = Math.max(lastEnd, current.start + current.count);
      last.count = newEnd - last.start;
    } else {
      merged.push(current);
    }
  }

  return merged;
}

/**
 * Perform deep line-level analysis on a file overlap.
 * Upgrades severity from 'warning' to 'conflict' if lines overlap,
 * or confirms 'warning' if changes are in different sections.
 */
export async function analyzeLineConflict(
  overlap: FileConflictDetail,
  worktreeA: WorktreeInfo,
  worktreeB: WorktreeInfo,
): Promise<FileConflictDetail> {
  const [rangesA, rangesB] = await Promise.all([
    getFileLineRanges(worktreeA.path, worktreeA.baseBranch, overlap.file),
    getFileLineRanges(worktreeB.path, worktreeB.baseBranch, overlap.file),
  ]);

  const overlapping = findOverlappingRanges(rangesA, rangesB);

  return {
    ...overlap,
    rangesA,
    rangesB,
    overlappingRanges: overlapping,
    severity: overlapping.length > 0 ? 'conflict' : 'warning',
  };
}

// ── Merge Order Recommendation ──

/**
 * Calculate total line changes for a worktree (additions + deletions).
 */
async function getWorktreeChangeSize(worktree: WorktreeInfo): Promise<number> {
  try {
    const stdout = await committedDiff(worktree.path, worktree.baseBranch, '--shortstat');

    // Parse: "3 files changed, 42 insertions(+), 8 deletions(-)"
    const insertions = stdout.match(/(\d+) insertion/)?.[1] ?? '0';
    const deletions = stdout.match(/(\d+) deletion/)?.[1] ?? '0';
    return parseInt(insertions, 10) + parseInt(deletions, 10);
  } catch {
    return worktree.dirtyFiles.length * 10; // Estimate
  }
}

/**
 * Recommend merge order based on:
 * 1. Larger change set merges first (establishes foundation, smaller rebase is easier)
 * 2. Older worktrees merge first (been around longer, more tested)
 * 3. Worktrees with fewer conflicts merge first (cleaner base for subsequent merges)
 */
export async function recommendMergeOrder(
  worktrees: WorktreeInfo[],
  conflicts: FileConflictDetail[],
): Promise<MergeOrderRecommendation[]> {
  const active = worktrees.filter((wt) => wt.dirtyFiles.length > 0);
  if (active.length === 0) return [];

  // Calculate change sizes in parallel
  const sizes = await Promise.all(active.map(getWorktreeChangeSize));

  // Count conflicts per worktree
  const conflictCounts = new Map<string, number>();
  for (const c of conflicts) {
    conflictCounts.set(c.worktreeA, (conflictCounts.get(c.worktreeA) ?? 0) + 1);
    conflictCounts.set(c.worktreeB, (conflictCounts.get(c.worktreeB) ?? 0) + 1);
  }

  // Score each worktree (higher = merge earlier)
  const scored = active.map((wt, i) => {
    const changeSize = sizes[i] ?? 0;
    const conflictCount = conflictCounts.get(wt.id) ?? 0;

    // Scoring: larger changes first (weight 3), fewer conflicts first (weight 2)
    // Age removed — it's noise at typical worktree lifetimes (minutes-hours)
    const score =
      (changeSize * 3) +
      ((10 - Math.min(conflictCount, 10)) * 2); // Inverse conflict count

    return {
      worktreeId: wt.id,
      agentType: wt.agentType,
      fileCount: wt.dirtyFiles.length,
      totalChanges: changeSize,
      score,
      conflictCount,
    };
  });

  // Sort by score descending (highest score = merge first)
  scored.sort((a, b) => b.score - a.score);

  return scored.map((s, idx) => {
    let reason: string;
    if (idx === 0 && s.totalChanges > (scored[1]?.totalChanges ?? 0) * 1.5) {
      reason = `Largest change set (${s.totalChanges} lines) — establishes foundation for subsequent merges`;
    } else if (idx === 0 && s.conflictCount === 0) {
      reason = 'No conflicts — clean merge, establishes base for others';
    } else if (s.conflictCount === 0) {
      reason = 'No conflicts with other worktrees';
    } else {
      reason = `${s.conflictCount} overlapping file${s.conflictCount > 1 ? 's' : ''} — rebase after earlier merges`;
    }

    return {
      worktreeId: s.worktreeId,
      agentType: s.agentType,
      position: idx + 1,
      reason,
      fileCount: s.fileCount,
      totalChanges: s.totalChanges,
    };
  });
}

// ── Full Report ──

/**
 * Generate a complete conflict report with file overlaps, line analysis,
 * and merge order recommendations.
 *
 * @param deep - If true, perform line-level analysis on all overlaps (slower)
 */
export async function generateConflictReport(
  worktrees: WorktreeInfo[],
  deep = false,
): Promise<EnhancedConflictReport> {
  // Fast file-level scan
  let fileOverlaps = detectFileOverlaps(worktrees);

  // Optional deep line-level analysis
  if (deep && fileOverlaps.length > 0) {
    const worktreeMap = new Map(worktrees.map((wt) => [wt.id, wt]));

    fileOverlaps = await Promise.all(
      fileOverlaps.map(async (overlap) => {
        const wtA = worktreeMap.get(overlap.worktreeA);
        const wtB = worktreeMap.get(overlap.worktreeB);
        if (wtA && wtB) {
          return analyzeLineConflict(overlap, wtA, wtB);
        }
        return overlap;
      }),
    );
  }

  // Merge order
  const mergeOrder = await recommendMergeOrder(worktrees, fileOverlaps);

  const conflictCount = fileOverlaps.filter((f) => f.severity === 'conflict').length;
  const warningCount = fileOverlaps.filter((f) => f.severity === 'warning').length;

  return {
    files: fileOverlaps,
    safe: fileOverlaps.length === 0,
    conflictCount,
    warningCount,
    mergeOrder,
    generatedAt: Date.now(),
  };
}
