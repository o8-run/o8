/**
 * Merge gate — hard enforcement layer for lane merges.
 *
 * Runs four checks before any merge can proceed:
 * 1. Security pattern hard-blocks (code injection, eval, etc.)
 * 2. Diff budget validation (actual diff vs preservation envelope)
 * 3. Untracked import validation (catches imports pointing to files outside git)
 * 4. Self-review integrity (catches agents lying about results)
 *
 * Unlike the advisory mechanical checks in auto-review.ts, these are
 * enforcement gates: violations with severity 'block' prevent merge
 * entirely and force human approval. The operator can still override,
 * but they must see and acknowledge the violations first.
 *
 * Called from two places (defense in depth):
 * - auto-review.ts: includes gate results in orchestrator review prompt
 * - commands.ts: final hard gate before merge execution
 */

import { laneGit, LaneGitMetadataError } from '@/lib/lane/lane-git';
import { createHash } from 'node:crypto';
import type { PacketDiffBaseResolution } from '@/lib/diff/base-resolution';
import { isSafeGitRef } from '@/lib/git/refs';
import { resolveLaneAttributionBase } from '@/lib/lane/attribution-base';
import { IMPLEMENTATION_NOTES_FILENAME } from '@/lib/orchestrator/packet-deviations';
import type { PacketSelfReview } from '@/lib/orchestrator/types';
import { getCachedFileLineCounts } from '@/lib/skeleton/store';
import { checkUntrackedImports } from './check-untracked-imports';
import { getRelocatedDeletionCredits } from './diff-relocation';
import { hasScopePartitionToken } from './review-risk';
import { inspectOperatorCheckoutMergeSafety } from './operator-checkout-merge';
import { hasPushRemote } from './worktree-merge-git';
import type { Lane } from './types';

// ── Budget Constants (shared with dispatch.ts preservation envelope) ──

export const PRESERVATION_DELETE_BUDGET_RATIO = 0.1;
export const PRESERVATION_ADD_BUDGET_RATIO = 0.2;
export const PRESERVATION_MIN_DELETE_BUDGET = 5;

// Budget multiplier before a violation escalates from warning to hard-block.
// 3x = agent exceeded budget by 200% — true scope creep or a rewrite.
//
// Why 3x and not 1.5x: dogfood found the 1.5x bar blocked legitimate
// refactors. Examples (F22 #998, F23 #999, dogfood loop v3):
// - #712 UpdateBanner.tsx: deleted 50 / budget 25 = 2x — that's the fix
//   the issue asked for (replace polling with event subscription).
// - #986 directives/filter.ts: added 46 / budget 24 = 1.92x — that's
//   the per-project filtering feature the issue specified.
// Both got hard-blocked at 1.5x even after operator approval. Operators
// then had to cherry-pick manually. Treating 1.5–3x as warning lets
// these legitimate diffs pass while still blocking >3x rewrites.
const BUDGET_BLOCK_MULTIPLIER = 3;

// ── Security Patterns (hard-block tier) ──
// These are a subset of auto-review's patterns, elevated to enforcement.
// Only patterns that indicate genuine injection risk are hard-blocks.

const PROCESS_EXIT_PATTERN = /\bprocess\.exit\s*\(/;
const REVIEWED_CLI_EXIT_FILE = 'cli/src/exit.ts';
// This reviewed wrapper drains output before terminating a one-shot CLI. Pin
// its entire committed contents when allowing new termination calls.
const REVIEWED_CLI_EXIT_SHA256 = '538866e90234deda04c1626cf6ecae0d1a930edf3deb798e7f0d30de4d5c9823';

const HARD_BLOCK_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Injection vectors
  { pattern: /execSync\s*\(.*\$\{/, label: 'execSync with template literal injection' },
  { pattern: /execSync\s*\(.*\+\s*/, label: 'execSync with string concatenation injection' },
  { pattern: /\bexec\s*\(.*\$\{/, label: 'exec with template literal injection' },
  { pattern: /child_process.*\bsh\s+-c\b/, label: 'Shell injection via sh -c' },
  { pattern: /\beval\s*\(/, label: 'eval() — code injection risk' },
  { pattern: /new\s+Function\s*\(/, label: 'new Function() — code injection risk' },
  // Capability escalation — agents should not introduce new process/import vectors
  { pattern: /require\s*\(\s*['"]child_process['"]/, label: 'New child_process require — capability escalation' },
  { pattern: /from\s+['"]child_process['"]/, label: 'New child_process import — capability escalation' },
  { pattern: /\bprocess\.exit\s*\(/, label: 'process.exit() — agent must not kill the process' },
  // Prototype pollution
  { pattern: /__proto__/, label: '__proto__ access — prototype pollution risk' },
  { pattern: /constructor\s*\[\s*['"]prototype['"]/, label: 'constructor.prototype access — prototype pollution risk' },
];

const SCOPE_PARTITION_WRITE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bwriteFile(?:Sync)?\s*\(/i, label: 'File write without partition token' },
  { pattern: /\bmkdir\s*\(/i, label: 'Directory write without partition token' },
  { pattern: /\b(?:INSERT|UPDATE)\b/i, label: 'Database write without partition token' },
  { pattern: /\.(?:set|put)\s*\(/i, label: 'Store mutation without partition token' },
];

// ── Types ──

export interface MergeViolation {
  category: 'security' | 'budget' | 'integrity';
  severity: 'block' | 'warn';
  label: string;
  detail: string;
  file?: string;
}

export interface MergeGateResult {
  passed: boolean;
  violations: MergeViolation[];
  diffBase?: PacketDiffBaseResolution;
}

interface AddedDiffLine {
  file: string | null;
  text: string;
}

function isWorkerScratchNoise(file: string | null): boolean {
  return file === IMPLEMENTATION_NOTES_FILENAME;
}

const WEBVIEW_LATCH_FILE = 'src-tauri/src/webview_latch.rs';
const WEBVIEW_LATCH_BRIDGE_CALL = 'webview.' + 'ev' + 'al(js.as_ref())';
const MERGE_GATE_FILE = 'src/lib/lane/merge-gate.ts';

// ── Helpers ──

function parseGitDiffFilePath(line: string): string | null {
  const path = line.trim();
  if (!path || path === '/dev/null') return null;
  return path.startsWith('b/') ? path.slice(2) : path;
}

async function getAddedLines(cwd: string, baseBranch: string, headSha: string, repoPath: string): Promise<AddedDiffLine[]> {
  if (!isSafeGitRef(baseBranch)) return [];
  try {
    const { stdout: diff } = await laneGit(cwd, repoPath, ['diff', `${baseBranch}...${headSha}`, '--no-color'], {
      timeout: 15_000, maxBuffer: 10 * 1024 * 1024,
    });
    const addedLines: AddedDiffLine[] = [];
    let currentFile: string | null = null;

    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ ')) {
        currentFile = parseGitDiffFilePath(line.slice(4));
        continue;
      }

      if (line.startsWith('+') && !isWorkerScratchNoise(currentFile)) {
        addedLines.push({ file: currentFile, text: line });
      }
    }

    return addedLines;
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    return [];
  }
}

async function readHeadSha(cwd: string, repoPath: string): Promise<string> {
  return (await laneGit(cwd, repoPath, ['rev-parse', 'HEAD'], { timeout: 5_000 })).stdout.trim();
}

interface DiffNumstat {
  file: string;
  insertions: number;
  deletions: number;
}

async function getDiffNumstat(cwd: string, baseBranch: string, repoPath: string): Promise<DiffNumstat[]> {
  if (!isSafeGitRef(baseBranch)) return [];
  try {
    const output = (await laneGit(cwd, repoPath, ['diff', '--numstat', `${baseBranch}...HEAD`], { timeout: 10_000 })).stdout.trim();

    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('\t');
        const add = parts[0]?.trim() ?? '';
        const del = parts[1]?.trim() ?? '';
        const file = parts[2]?.trim() ?? '';
        // Binary files show as "-\t-\tfilename" — skip
        if (add === '-' || del === '-') return null;
        const insertions = parseInt(add, 10);
        const deletions = parseInt(del, 10);
        if (!file || isNaN(insertions) || isNaN(deletions)) return null;
        return isWorkerScratchNoise(file) ? null : { file, insertions, deletions };
      })
      .filter((entry): entry is DiffNumstat => entry !== null);
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    return [];
  }
}

async function getChangedFiles(cwd: string, baseBranch: string, repoPath: string): Promise<string[]> {
  if (!isSafeGitRef(baseBranch)) return [];
  try {
    const output = (await laneGit(cwd, repoPath, ['diff', '--name-only', `${baseBranch}...HEAD`], {
      timeout: 10_000, maxBuffer: 1024 * 1024,
    })).stdout.trim();

    return output.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    return [];
  }
}

/** True when the packet edits the gate itself (#3414). The host still runs its own gate. */
async function changesMergeGate(cwd: string, baseBranch: string, repoPath: string): Promise<boolean> {
  return (await getChangedFiles(cwd, baseBranch, repoPath)).includes(MERGE_GATE_FILE);
}

// ── Check 1: Security Patterns ──

function isSecurityScanExemptPath(file: string | null): boolean {
  return file !== null && /^(scripts|bin)\//.test(file);
}

function isCanonicalWebviewLatchBridge(file: string | null, text: string): boolean {
  if (file !== WEBVIEW_LATCH_FILE) return false;
  return text.slice(1).replace(/\s+/g, '') === WEBVIEW_LATCH_BRIDGE_CALL;
}

async function hasReviewedCliExit(cwd: string, headSha: string, repoPath: string): Promise<boolean> {
  try {
    const { stdout: contents } = await laneGit(cwd, repoPath, ['show', `${headSha}:${REVIEWED_CLI_EXIT_FILE}`], {
      timeout: 5_000, maxBuffer: 64 * 1024,
    });
    return createHash('sha256').update(contents).digest('hex') === REVIEWED_CLI_EXIT_SHA256;
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    return false;
  }
}

async function checkSecurityPatterns(cwd: string, headSha: string, addedLines: AddedDiffLine[], repoPath: string): Promise<MergeViolation[]> {
  const violations: MergeViolation[] = [];
  const reviewedCliExit = addedLines.some(({ file, text }) => (
    file === REVIEWED_CLI_EXIT_FILE && PROCESS_EXIT_PATTERN.test(text)
  )) && await hasReviewedCliExit(cwd, headSha, repoPath);

  for (const { pattern, label } of HARD_BLOCK_PATTERNS) {
    for (const { file, text } of addedLines) {
      if (isSecurityScanExemptPath(file)) continue;
      if (isCanonicalWebviewLatchBridge(file, text)) continue;
      // Only the termination pattern is allowed, never a whole-file exemption.
      if (pattern.source === PROCESS_EXIT_PATTERN.source && file === REVIEWED_CLI_EXIT_FILE && reviewedCliExit) continue;

      if (pattern.test(text)) {
        violations.push({
          category: 'security',
          severity: 'block',
          label,
          detail: `New code matches blocked pattern: ${text.slice(1).trim().slice(0, 120)}`,
          file: file ?? undefined,
        });
        break; // One finding per pattern
      }
    }
  }

  return violations;
}

function checkScopePartitionHeuristics(addedLines: AddedDiffLine[]): MergeViolation[] {
  const violations: MergeViolation[] = [];

  for (const { pattern, label } of SCOPE_PARTITION_WRITE_PATTERNS) {
    for (const { file, text } of addedLines) {
      if (!pattern.test(text) || hasScopePartitionToken(text)) {
        continue;
      }

      violations.push({
        category: 'integrity',
        severity: 'warn',
        label,
        detail: `New write/mutation lacks an obvious partition token on the same line: ${text.slice(1).trim().slice(0, 120)}`,
        file: file ?? undefined,
      });
      break; // One advisory finding per pattern
    }
  }

  return violations;
}

// ── Check 2: Diff Budget Validation ──
//
// When `orchestratorApproved` is true, budget violations are downgraded
// from `block` to `warn` — the orchestrator has reviewed the diff and
// signed off, which carries more weight than the heuristic budget cap.
// Security + integrity violations stay block-level regardless (those
// catch genuine risks the orchestrator can't waive). See F25 / #1001.

async function checkDiffBudgets(
  cwd: string,
  baseBranch: string,
  repoPath: string,
  orchestratorApproved: boolean,
): Promise<MergeViolation[]> {
  const numstat = await getDiffNumstat(cwd, baseBranch, repoPath);
  if (numstat.length === 0) return [];

  // Budgets need scalar line counts, never the repository's symbol/import JSON.
  const skeleton = new Map(getCachedFileLineCounts(repoPath).map((file) => [file.relativePath, file.lineCount]));
  let relocationCredits = new Map<string, number>();
  try {
    const { stdout } = await laneGit(cwd, repoPath, ['diff', '--unified=0', '--no-color', '--no-ext-diff', `${baseBranch}...HEAD`], {
      timeout: 15_000, maxBuffer: 10 * 1024 * 1024,
    });
    relocationCredits = getRelocatedDeletionCredits(cwd, baseBranch, () => stdout);
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
  }
  const violations: MergeViolation[] = [];

  for (const { file, insertions, deletions } of numstat) {
    const lineCount = skeleton.get(file);
    if (!lineCount) continue; // New file — no budget applies

    const addBudget = Math.ceil(lineCount * PRESERVATION_ADD_BUDGET_RATIO);
    const deleteBudget = Math.max(
      PRESERVATION_MIN_DELETE_BUDGET,
      Math.ceil(lineCount * PRESERVATION_DELETE_BUDGET_RATIO),
    );
    const relocatedDeletions = Math.min(deletions, relocationCredits.get(file) ?? 0);
    const budgetedDeletions = deletions - relocatedDeletions;

    if (budgetedDeletions > deleteBudget) {
      const wouldBlock = budgetedDeletions > deleteBudget * BUDGET_BLOCK_MULTIPLIER;
      const severity: 'block' | 'warn' = wouldBlock && !orchestratorApproved ? 'block' : 'warn';
      violations.push({
        category: 'budget',
        severity,
        label: 'Delete budget exceeded',
        detail: `${file}: deleted ${deletions} lines${relocatedDeletions > 0 ? ` (${relocatedDeletions} relocated, ${budgetedDeletions} budgeted)` : ''} (budget: ${deleteBudget}, original: ${lineCount} lines)${wouldBlock && orchestratorApproved ? ' — orchestrator-approved override' : ''}`,
        file,
      });
    }

    if (insertions > addBudget) {
      const wouldBlock = insertions > addBudget * BUDGET_BLOCK_MULTIPLIER;
      const severity: 'block' | 'warn' = wouldBlock && !orchestratorApproved ? 'block' : 'warn';
      violations.push({
        category: 'budget',
        severity,
        label: 'Add budget exceeded',
        detail: `${file}: added ${insertions} lines (budget: ${addBudget}, original: ${lineCount} lines)${wouldBlock && orchestratorApproved ? ' — orchestrator-approved override' : ''}`,
        file,
      });
    }
  }

  return violations;
}

// ── Check 3: Untracked Imported Files ──

async function checkUntrackedImportViolations(cwd: string, baseBranch: string, repoPath: string): Promise<MergeViolation[]> {
  const outputs = new Map<string, string>();
  const untrackedArgs = ['ls-files', '--others', '--exclude-standard'];
  const changedArgs = ['diff', '--name-only', '--diff-filter=ACMR', `${baseBranch}...HEAD`];
  for (const args of [untrackedArgs, changedArgs]) {
    if (args === changedArgs && !outputs.get(JSON.stringify(untrackedArgs))?.trim()) break;
    try { outputs.set(JSON.stringify(args), (await laneGit(cwd, repoPath, args)).stdout); }
    catch (error) {
      if (error instanceof LaneGitMetadataError) throw error;
      outputs.set(JSON.stringify(args), '');
    }
  }
  const result = checkUntrackedImports(cwd, baseBranch, repoPath, (args) => outputs.get(JSON.stringify(args)) ?? '');
  if (result.ok) return [];

  const fileCount = result.untrackedFiles.length;
  const importedBy = result.importingFiles.length === 1
    ? ` Imported by ${result.importingFiles[0]}.`
    : result.importingFiles.length > 1
      ? ` Imported by changed files: ${result.importingFiles.join(', ')}.`
      : '';

  return [{
    category: 'integrity',
    severity: 'block',
    label: 'Untracked imported files',
    detail: `Imports point to ${fileCount} untracked file${fileCount === 1 ? '' : 's'}: ${result.untrackedFiles.join(', ')}. Run \`git add\` and amend.${importedBy}`,
  }];
}

// ── Check 4: Self-Review Integrity ──

function checkSelfReviewIntegrity(
  selfReview: PacketSelfReview | undefined,
  priorViolations: MergeViolation[],
): MergeViolation[] {
  if (!selfReview) return [];

  const blockCount = priorViolations.filter((v) => v.severity === 'block').length;

  if (blockCount === 0) return [];

  // Agent claimed success but gate found hard-block violations.
  // Fires regardless of confidence level — an agent claiming passed:true
  // at any confidence while blocking violations exist is an integrity failure.
  if (selfReview.passed) {
    return [{
      category: 'integrity',
      severity: 'block',
      label: 'Self-review integrity failure',
      detail: `Agent claimed passed:true (confidence:${selfReview.confidence}) but merge gate found ${blockCount} blocking violation(s). Self-review cannot be trusted for this lane.`,
    }];
  }

  return [];
}

// ── Public API ──

/**
 * Run the merge gate for a lane. Returns pass/fail + violations.
 *
 * - `block` severity violations prevent merge (force human approval)
 * - `warn` severity violations are informational (shown in approval card)
 *
 * `orchestratorApproved`: when true, budget violations are downgraded to
 * `warn` (the orchestrator has signed off on the diff). Security and
 * integrity violations stay block-level regardless. See F25 / #1001.
 */
export async function runMergeGate(
  lane: Lane,
  selfReview?: PacketSelfReview,
  orchestratorApproved = false,
): Promise<MergeGateResult> {
  const cwd = lane.worktreePath || lane.repoPath;
  const baseBranch = lane.baseBranch || 'main';
  const headSha = await readHeadSha(cwd, lane.repoPath);
  const diffBase = await resolveLaneAttributionBase(lane, cwd, headSha, (args) => laneGit(cwd, lane.repoPath, args));
  const comparisonRef = diffBase.mergeBase ?? diffBase.comparisonRef;
  const checkoutSafety = await inspectOperatorCheckoutMergeSafety({
    repoPath: lane.repoPath,
    candidateCwd: cwd,
    candidateBaseRef: comparisonRef,
    candidateGit: (args) => laneGit(cwd, lane.repoPath, args),
    baseBranch,
  });
  const remotePublicationAvailable = checkoutSafety.conflictingPaths.length > 0 && await hasPushRemote(lane.repoPath);
  const checkoutViolations: MergeViolation[] = checkoutSafety.status === 'safe'
    ? []
    : [{
      category: 'integrity',
      severity: checkoutSafety.status === 'unsafe' && !remotePublicationAvailable ? 'block' : 'warn',
      label: checkoutSafety.status === 'unsafe'
        ? 'Operator checkout blocks base fast-forward'
        : 'Operator checkout safety could not be verified',
      detail: remotePublicationAvailable
        ? `${checkoutSafety.detail} The approved commit can be published to origin while the local checkout update is deferred.`
        : checkoutSafety.detail ?? `o8 found branch "${checkoutSafety.foundBranch}"; merge needs branch "${checkoutSafety.neededBranch}".`,
    }];

  const gateSelfUpdate = await changesMergeGate(cwd, comparisonRef, lane.repoPath);
  const addedLines = await getAddedLines(cwd, comparisonRef, headSha, lane.repoPath);
  const securityViolations = await checkSecurityPatterns(cwd, headSha, addedLines, lane.repoPath);
  const scopePartitionViolations = checkScopePartitionHeuristics(addedLines);
  const budgetViolations = await checkDiffBudgets(cwd, comparisonRef, lane.repoPath, orchestratorApproved);
  const importViolations = await checkUntrackedImportViolations(cwd, comparisonRef, lane.repoPath);
  const integrityViolations = checkSelfReviewIntegrity(
    selfReview,
    [...securityViolations, ...scopePartitionViolations, ...budgetViolations, ...importViolations],
  );

  // The gate is host code. A packet that edits it is checked by the installed
  // gate, its copy never runs, and a person approves the change (#3414).
  const gateViolations: MergeViolation[] = gateSelfUpdate
    ? [{
      category: 'integrity',
      severity: 'block',
      label: 'Packet changes the merge gate',
      detail: `This packet edits ${MERGE_GATE_FILE}. o8 checked it with the installed gate and did not run the packet's copy. A person must approve this merge.`,
      file: MERGE_GATE_FILE,
    }]
    : [];

  const violations = [
    ...securityViolations,
    ...scopePartitionViolations,
    ...budgetViolations,
    ...importViolations,
    ...checkoutViolations,
    ...integrityViolations,
    ...gateViolations,
  ];
  const hasBlocks = violations.some((v) => v.severity === 'block');

  if (violations.length > 0) {
    const blockCount = violations.filter((v) => v.severity === 'block').length;
    const warnCount = violations.filter((v) => v.severity === 'warn').length;
    console.log(`[merge-gate] Lane ${lane.id}: ${blockCount} block, ${warnCount} warn`);
  }

  return { passed: !hasBlocks, violations, diffBase };
}

/**
 * Format merge gate violations for the operator approval card.
 *
 * Binary signal only: the operator sees blocks, never warnings.
 * Warnings are orchestrator-only context (see formatMergeGateForReview).
 * This follows the App Review model — reject or approve, no muddy middle.
 */
export function formatMergeGateViolations(violations: MergeViolation[]): string {
  const blocks = violations.filter((v) => v.severity === 'block');
  if (blocks.length === 0) return '';

  const lines: string[] = [
    `Merge gate rejected: ${blocks.length} violation${blocks.length === 1 ? '' : 's'}`,
    '',
  ];

  for (const v of blocks) {
    lines.push(`[${v.category.toUpperCase()}] ${v.label}`);
    lines.push(`  ${v.detail}`);
    lines.push('');
  }

  lines.push('Override requires operator approval.');

  return lines.join('\n');
}

/**
 * Format merge gate results for inclusion in an orchestrator review prompt.
 */
export function formatMergeGateForReview(result: MergeGateResult): string {
  const diffBaseLines = result.diffBase
    ? [
        '',
        `Diff base: ${result.diffBase.mergeBase ?? result.diffBase.comparisonRef} (fetchedRemoteBase:${result.diffBase.fetchedRemoteBase}, usedFallback:${result.diffBase.usedFallback})`,
        ...(result.diffBase.warning ? [`Warning: ${result.diffBase.warning}`] : []),
      ]
    : [];

  if (result.violations.length === 0) {
    return ['## Merge gate', '', 'All checks passed. No violations detected.', ...diffBaseLines].join('\n');
  }

  const blocks = result.violations.filter((v) => v.severity === 'block');
  const warns = result.violations.filter((v) => v.severity === 'warn');

  const lines = [
    '## Merge gate (enforcement)',
    '',
    `${blocks.length} blocking violation(s), ${warns.length} warning(s).`,
    ...diffBaseLines,
  ];

  if (blocks.length > 0) {
    lines.push('');
    lines.push('**BLOCKED — these violations prevent auto-merge. Human approval required.**');
    for (const v of blocks) {
      lines.push(`- **[${v.category.toUpperCase()}]** ${v.label}: ${v.detail}`);
    }
  }

  if (warns.length > 0) {
    lines.push('');
    lines.push('Warnings (non-blocking):');
    for (const v of warns) {
      lines.push(`- [${v.category}] ${v.label}: ${v.detail}`);
    }
  }

  if (!result.passed) {
    lines.push('');
    lines.push('You MUST request changes or flag this for operator review. Do NOT attempt to auto-merge.');
  }

  return lines.join('\n');
}
