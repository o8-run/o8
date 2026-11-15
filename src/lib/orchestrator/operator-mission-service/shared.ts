import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { listLanes } from '@/lib/lane/registry';
import {
  buildDomainLaneSummaries,
  readOrchestratorControlPlaneState,
} from '@/lib/orchestrator/control-plane';
import {
  normalizeOrchestratorMissionState,
  reconcileOrchestratorMissionState,
} from '@/lib/orchestrator/store';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';
import { appendPacketFileValidationWarning } from '@/lib/orchestrator/packet-file-validator';
import type { LoadedIssue } from './types';

const LOG_PREFIX = '[mcp-operator]';

export function log(message: string, details?: unknown) {
  if (details === undefined) {
    console.log(`${LOG_PREFIX} ${message}`);
    return;
  }
  console.log(`${LOG_PREFIX} ${message}`, details);
}

export function buildMissionId() {
  return `mission-${randomUUID().slice(0, 12)}`;
}

export function buildPacketId() {
  return `pkt-${randomUUID()}`;
}

export function slugify(value: string, maxLength = 48) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug.slice(0, maxLength).replace(/-+$/g, '') || 'work';
}

/** Inline/ad-hoc issues use synthetic numbers starting at 90001 and have no URL. */
export function isInlineIssue(issue: LoadedIssue) {
  return !issue.url && issue.number >= 90001;
}

export function branchTargetForMissionIssue(issue: LoadedIssue, branchPrefix: string, maxInlineLength: number) {
  if (!isInlineIssue(issue)) {
    return `${branchPrefix}/${issue.number}-${slugify(issue.title)}`;
  }
  const prefix = `inline/${issue.number}-`;
  return `${prefix}${slugify(issue.title, Math.max(1, maxInlineLength - prefix.length))}`;
}

const INLINE_ISSUE_BASE = 90_000_000_000;
const INLINE_ISSUE_RANDOM_SPACE = 2 ** 47;
const issuedInlineIssueNumbers = new Set<number>();

/**
 * Pipeline root fix (2026-07-03): UNIQUE synthetic numbers for inline issues.
 * Early creators reused fixed low numbers, then a time-based variant still
 * allowed same-ms collisions across processes. Crypto-backed values keep
 * `isInlineIssue` true while making cross-process collisions practically
 * impossible; the issued set also prevents same-process repeats.
 */
export function nextInlineIssueNumbers(count: number): number[] {
  const normalizedCount = Number.isFinite(count) ? Math.max(1, Math.trunc(count)) : 1;
  return Array.from({ length: normalizedCount }, () => {
    let candidate = INLINE_ISSUE_BASE + randomInt(INLINE_ISSUE_RANDOM_SPACE);
    while (issuedInlineIssueNumbers.has(candidate)) {
      candidate = INLINE_ISSUE_BASE + randomInt(INLINE_ISSUE_RANDOM_SPACE);
    }
    issuedInlineIssueNumbers.add(candidate);
    return candidate;
  });
}

export function ensureRepoPath(repoPath: string) {
  const normalized = repoPath.trim();
  if (!normalized) {
    throw new Error('repoPath is required.');
  }
  if (!existsSync(normalized) || !statSync(normalized).isDirectory()) {
    throw new Error(`Repository path not found: ${normalized}`);
  }
  return normalized;
}

export function normalizeLoadedIssue(issue: LoadedIssue, index: number): LoadedIssue {
  if (!Number.isInteger(issue.number) || issue.number < 1) {
    throw new Error(`issues[${index}] must include a positive issue number.`);
  }

  const title = typeof issue.title === 'string' ? issue.title.trim() : '';
  if (!title) {
    throw new Error(`issues[${index}] must include a title.`);
  }

  const allowedFiles = Array.isArray(issue.allowedFiles)
    ? [...new Set(issue.allowedFiles.map((file) => (typeof file === 'string' ? file.trim() : '')).filter(Boolean))].slice(0, 64)
    : [];

  return {
    number: issue.number,
    title,
    body: typeof issue.body === 'string' ? issue.body : '',
    url: typeof issue.url === 'string' ? issue.url : '',
    ...(issue.runtime ? { runtime: issue.runtime } : {}),
    ...(allowedFiles.length > 0 ? { allowedFiles } : {}),
  };
}

export function extractIssueDependencies(body: string, availableIssueNumbers: Set<number>) {
  const dependencies = new Set<number>();
  const patterns = [
    /(?:depends on|blocked by|after|requires)\s+(?:https?:\/\/[^\s/]+\/[^/\s]+\/[^/\s]+\/issues\/|#)?(\d+)/gi,
    /(?:depends on|blocked by|after|requires)\s+issue\s+#?(\d+)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) {
      const numberValue = Number.parseInt(match[1] ?? '', 10);
      if (Number.isFinite(numberValue) && availableIssueNumbers.has(numberValue)) {
        dependencies.add(numberValue);
      }
    }
  }

  return [...dependencies];
}

export function buildMissionPrompt(issues: LoadedIssue[], repoPath: string, constraints: string) {
  const repoName = basename(repoPath);
  const hasInline = issues.some(isInlineIssue);
  return [
    `Sprint mission for ${repoName}.`,
    '',
    hasInline ? 'Tasks:' : 'Issues:',
    ...issues.map((issue, index) =>
      isInlineIssue(issue)
        ? `- inline-${index + 1}: ${issue.title}`
        : `- #${issue.number}: ${issue.title}`,
    ),
    constraints ? '' : null,
    constraints ? `Constraints: ${constraints}` : null,
  ].filter((value): value is string => Boolean(value)).join('\n');
}

export function buildMissionSummary(issues: LoadedIssue[], repoPath: string) {
  const repoName = basename(repoPath);
  const hasInline = issues.some(isInlineIssue);
  const noun = hasInline ? 'task' : 'issue';
  return `Sprint mission for ${repoName} with ${issues.length} ${noun}${issues.length === 1 ? '' : 's'}.`;
}

export function buildPacketSummary(
  issue: LoadedIssue,
  constraints: string,
  repoPath: string,
  inlineLabel?: string,
) {
  const header = isInlineIssue(issue)
    ? `Task${inlineLabel ? ` ${inlineLabel}` : ''}: ${issue.title}`
    : `GitHub issue #${issue.number}: ${issue.title}`;
  const summary = [
    header,
    issue.body.trim() || (isInlineIssue(issue) ? 'No description provided.' : 'No issue body provided.'),
    constraints ? `Constraints: ${constraints}` : null,
  ].filter((value): value is string => Boolean(value)).join('\n\n');
  return appendPacketFileValidationWarning(summary, repoPath);
}

export function normalizeMissionSelection(state: OrchestratorMissionState, missionId?: string) {
  const requestedMissionId = missionId?.trim();
  if (!requestedMissionId) {
    return;
  }

  const currentMissionId = state.missionId?.trim() ?? '';
  if (!currentMissionId) {
    throw new Error(`No active mission is stored. Requested ${requestedMissionId}.`);
  }
}

export function currentMissionState() {
  const current = normalizeOrchestratorMissionState(readOrchestratorControlPlaneState());
  return reconcileOrchestratorMissionState(current, {
    laneSnapshots: [],
    runtimeTruth: [],
    domainLanes: buildDomainLaneSummaries(),
  });
}

export function missionAgentKeys(packetIds: Set<string>) {
  return listLanes()
    .filter((lane) => lane.packetId && packetIds.has(lane.packetId))
    .filter((lane) => lane.status !== 'completed' && lane.status !== 'archived')
    .map((lane) => ({
      label: lane.label || lane.branch,
      status: lane.status,
      laneId: lane.id,
      packetId: lane.packetId,
    }));
}
