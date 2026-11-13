import { laneGitSync } from './lane-git';
import { isSafeGitRef } from '@/lib/git/refs';
import { extractAddedLines, parseDiffStat } from './lane-diff-facts';
import type { Lane } from './types';

// ── Mechanical Checks (#482) ──
// Automated diff stats + security pattern scan that runs before LLM review.
// Findings are prepended to the review prompt so the orchestrator sees them.

interface MechanicalFinding {
  severity: 'high' | 'warning';
  label: string;
  detail: string;
}

const SECURITY_PATTERNS: Array<{ pattern: RegExp; label: string; severity: 'high' | 'warning' }> = [
  { pattern: /execSync\s*\(.*\$\{/, label: 'execSync with template literal', severity: 'high' },
  { pattern: /execSync\s*\(.*\+\s*/, label: 'execSync with string concatenation', severity: 'high' },
  { pattern: /\bexec\s*\(.*\$\{/, label: 'exec with template literal', severity: 'high' },
  { pattern: /child_process.*\bsh\s+-c\b/, label: 'sh -c shell execution', severity: 'high' },
  { pattern: /\beval\s*\(/, label: 'eval() usage', severity: 'high' },
  { pattern: /new\s+Function\s*\(/, label: 'new Function() constructor', severity: 'high' },
  { pattern: /dangerouslySetInnerHTML/, label: 'dangerouslySetInnerHTML', severity: 'warning' },
  { pattern: /path\.join\s*\([^)]*(?:req\.|params\.|query\.|body\.)/, label: 'path.join on user input without bounds check', severity: 'high' },
  { pattern: /\.innerHTML\s*=/, label: 'direct innerHTML assignment', severity: 'warning' },
];

export function runMechanicalChecks(lane: Lane, comparisonRef?: string): { findings: MechanicalFinding[]; summary: string } {
  const cwd = lane.worktreePath || lane.repoPath;
  const safeBase = comparisonRef && isSafeGitRef(comparisonRef)
    ? comparisonRef
    : isSafeGitRef(lane.baseBranch) ? lane.baseBranch : null;
  const findings: MechanicalFinding[] = [];

  // ── Diff stats check ──
  let stat = '';
  try {
    stat = laneGitSync(cwd, lane.repoPath, ['diff', '--stat', safeBase ? `${safeBase}...HEAD` : 'HEAD~1'], { timeout: 10_000 }).trim();
  } catch {
    try {
      stat = laneGitSync(cwd, lane.repoPath, ['diff', '--stat', 'HEAD~1'], { timeout: 10_000 }).trim();
    } catch { /* no commits */ }
  }

  if (stat) {
    const fileStats = parseDiffStat(stat);
    for (const fs of fileStats) {
      const total = fs.insertions + fs.deletions;
      if (total === 0) continue;
      const deleteRatio = fs.deletions / total;
      if (fs.deletions > 50 && deleteRatio > 0.5) {
        findings.push({
          severity: 'high',
          label: 'Possible file rewrite',
          detail: `${fs.file}: ${fs.deletions} deletions (${Math.round(deleteRatio * 100)}% of changes). Agent may have rewritten instead of surgically editing.`,
        });
      } else if (fs.deletions > 20 && deleteRatio > 0.3) {
        findings.push({
          severity: 'warning',
          label: 'High deletion ratio',
          detail: `${fs.file}: ${fs.deletions} deletions (${Math.round(deleteRatio * 100)}% of changes). Verify deletions were intentional.`,
        });
      }
    }
  }

  // ── Security pattern scan ──
  let rawDiff = '';
  try {
    rawDiff = laneGitSync(cwd, lane.repoPath, ['diff', safeBase ? `${safeBase}...HEAD` : 'HEAD~1', '--no-color'], { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 });
  } catch {
    try {
      rawDiff = laneGitSync(cwd, lane.repoPath, ['diff', 'HEAD~1', '--no-color'], { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 });
    } catch { /* no commits */ }
  }

  if (rawDiff) {
    // Only scan added lines (lines starting with +, excluding +++ headers)
    const addedLines = extractAddedLines(rawDiff);

    for (const { pattern, label, severity } of SECURITY_PATTERNS) {
      for (const line of addedLines) {
        if (pattern.test(line)) {
          findings.push({
            severity,
            label,
            detail: `New code matches security pattern: ${line.slice(1).trim().slice(0, 120)}`,
          });
          break; // One finding per pattern is enough
        }
      }
    }
  }

  if (findings.length === 0) {
    return { findings, summary: '' };
  }

  const highCount = findings.filter((f) => f.severity === 'high').length;
  const warnCount = findings.filter((f) => f.severity === 'warning').length;
  const lines = [
    '## Mechanical checks (automated)',
    '',
    `Found ${findings.length} issue${findings.length === 1 ? '' : 's'}: ${highCount} high, ${warnCount} warning.`,
    '',
    ...findings.map((f) => `- **[${f.severity.toUpperCase()}]** ${f.label}: ${f.detail}`),
    '',
    'These checks are automated and may have false positives. Evaluate each finding independently.',
  ];

  console.log(`[auto-review] Mechanical checks for lane ${lane.id}: ${highCount} high, ${warnCount} warning`);

  return { findings, summary: lines.join('\n') };
}
