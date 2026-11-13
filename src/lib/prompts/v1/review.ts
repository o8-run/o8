import { REVIEW_RUN_EVIDENCE_PROMPT } from '@/lib/orchestrator/review-run-evidence';
import { formatPacketTaskContractForReview } from '@/lib/orchestrator/packet-task-contract';
import type { PacketTaskContract } from '@/lib/orchestrator/types';
import { REVIEWER_OUTCOME_OWNERSHIP_PROMPT_V1 } from './outcome-ownership';

const REVIEWER_LIMITATIONS = [
  'Tool failures are reviewer limitations, not packet defects. Do not request changes solely because your transcript, scope, preview, or verification tool is unavailable.',
  'If code and file-backed coverage clear, approve with unverified process items. Record each as a severity "note", status "accepted", description starting "Reviewer limitation:" in submit_review findings or the structured verdict. Name the failed tool, error and affected constraint IDs. Never invent process citations.',
  'The deterministic merge gate still requires process evidence at the reviewed HEAD. The operator can supply it with `o8 packet review --approve --supplement-process-evidence --expected-sha <HEAD> --coverage <R>=<path> --process-evidence <P>=<source>:<reference>`. This completes the existing review without resetting its second pass. Missing code coverage and concrete defects still require changes.',
].join('\n');

export interface BlindSecondPassPromptInputV1 {
  laneLabel: string;
  branch: string;
  packetId?: string | null;
  diffSummary: string;
  cwd: string;
  highRiskReasons: string[];
  taskContract?: PacketTaskContract | null;
  taskContractRequired?: boolean;
}

export function buildBlindSecondPassPromptV1(input: BlindSecondPassPromptInputV1): string {
  const contractArmed = input.taskContractRequired === true || Boolean(input.taskContract);
  const taskContractMissing = input.taskContractRequired === true && !input.taskContract;
  const reasons = input.highRiskReasons.length > 0
    ? input.highRiskReasons.map((reason) => `- ${reason}`).join('\n')
    : '- high-risk classification returned no structured reason';
  return [
    `You are the blind, independent second-pass reviewer for lane "${input.laneLabel}" (branch: ${input.branch}).`,
    'Do not rely on any prior review, prior verdict, approval card, summary, or finding. Evaluate only the diff and protocol below.',
    '',
    `## High-risk reasons\n${reasons}`,
    '',
    input.diffSummary,
    '',
    contractArmed ? formatPacketTaskContractForReview(input.taskContract) : null,
    contractArmed ? '' : null,
    REVIEWER_OUTCOME_OWNERSHIP_PROMPT_V1,
    REVIEWER_LIMITATIONS,
    '',
    '## Required verification protocol',
    `Worktree: ${input.cwd}`,
    input.packetId ? `Packet: ${input.packetId}` : null,
    'SCOPE traces: for every changed file that writes or mutates state, cite `SCOPE: <file:line> partition=<repo|tenant|user|project|lane|packet|scope|slug|id|NONE>` and confirm the single intended destination.',
    'GUARD traces: for every new guard, condition, or early return, cite `GUARD: <file:line> fires-from=<file:line|INERT>`.',
    contractArmed
      ? 'COVERAGE checklist: enumerate every task-contract requirement ID as `[x] <ID> <sub-requirement> - evidence <file:line|command output>` or `[ ] <ID> <sub-requirement> - gap <reason>`.'
      : 'COVERAGE checklist: enumerate each packet sub-requirement as `[x] <sub-requirement> - evidence <file:line|command output>` or `[ ] <sub-requirement> - gap <reason>`.',
    contractArmed && input.taskContract?.processConstraints?.length
      ? 'PROCESS checklist: assess every process constraint ID from transcript, lane event, or command evidence. Do not count a changed file as proof of an unrelated process action. Mark missing evidence unverified.'
      : null,
    contractArmed ? 'MINIMALITY trace: map every changed file or change unit to requirement IDs. Cite the logged deviation for anything outside the smallestRoute, then state whether a substantially smaller complete diff exists.' : null,
    'COMPLETENESS trace - when the change establishes or restores an invariant, name it, then enumerate every production path with that property:',
    '`INVARIANT: <one sentence, or NONE>`',
    '`SITE: <file:line> covered=<yes|no> evidence=<file:line|reason>`',
    'EXECUTION-PATH TRACE: trace the actual call path the change runs under, not the one its name implies.',
    contractArmed
      ? `You may agree only if ${taskContractMissing ? 'the required structured task contract exists, ' : ''}every guard is live, every write is partitioned correctly, every requirement is covered, the minimality trace clears, every COMPLETENESS site is covered, and the execution path reaches the changed code.`
      : 'You may agree only if every guard is live, every write is partitioned correctly, every sub-requirement is covered, every COMPLETENESS site is covered, and the execution path reaches the changed code.',
    '',
    'Do not call submit_review. Do not call lane_command. Do not stamp or merge anything yourself.',
    'End your output with exactly one final line:',
    'SECOND_PASS_VERDICT: agree',
    'or',
    'SECOND_PASS_VERDICT: disagree - <file:line> <reason>',
  ].filter((value): value is string => value !== null).join('\n');
}

export interface AutoReviewScreenshotV1 {
  path: string;
  width?: number | null;
  height?: number | null;
  mimeType?: string | null;
  capturedAt?: string | null;
}

export interface AutoReviewPromptInputV1 {
  lane: {
    id: string;
    label: string;
    branch: string;
    packetId?: string | null;
  };
  depth: 'fast-track' | 'standard' | 'deep-dive';
  worktreePath: string;
  diffSummary: string;
  selfReviewSection: string;
  deviationsEntries: string[];
  mergeGateSection?: string | null;
  mechanicalChecksSummary?: string | null;
  reviewScreenshot?: AutoReviewScreenshotV1 | null;
  adversarialReviewProtocol?: string | null;
  taskContract?: PacketTaskContract | null;
  taskContractRequired?: boolean;
}

export function buildAutoReviewPromptV1(input: AutoReviewPromptInputV1): string {
  const contractArmed = input.taskContractRequired === true || Boolean(input.taskContract);
  const taskContractSection = contractArmed
    ? formatPacketTaskContractForReview(input.taskContract)
    : null;
  const taskContractMissing = input.taskContractRequired === true && !input.taskContract;
  const depthGuidance = input.depth === 'deep-dive'
    ? 'This lane has low-confidence or missing self-review context. Perform a deep-dive review and challenge assumptions, edge cases, and missing validation.'
    : 'This lane reports medium-confidence self-review. Do a normal review with independent verification of the claimed changes.';
  // #1490; surface the worker's self-reported departures to the reviewer.
  const deviationsSection = input.deviationsEntries.length > 0
    ? [
        '## Worker deviations from brief',
        '',
        'The worker logged these departures from the plan (packet notes artifact → ## Deviations). Verify each is the conservative call the brief asked for, and factor them into your verdict:',
        ...input.deviationsEntries.map((entry) => `- ${entry}`),
      ].join('\n')
    : '## Worker deviations from brief\n\nNo deviations reported by the worker.';
  const reviewScreenshotMetadata = input.reviewScreenshot
    ? [
        typeof input.reviewScreenshot.width === 'number' && input.reviewScreenshot.width > 0
          && typeof input.reviewScreenshot.height === 'number' && input.reviewScreenshot.height > 0
          ? `${input.reviewScreenshot.width}x${input.reviewScreenshot.height}`
          : null,
        input.reviewScreenshot.mimeType ?? null,
        input.reviewScreenshot.capturedAt ? `captured ${input.reviewScreenshot.capturedAt}` : null,
      ].filter((value): value is string => Boolean(value)).join(' • ')
    : '';
  const requiredTraceFormat = [
    '## Required verification traces',
    '',
    'Before any verdict, recommendation, or submit_review call, emit a completed trace block in this exact format:',
    `Worktree: ${input.worktreePath}`,
    input.lane.packetId ? `Packet: ${input.lane.packetId}` : null,
    '',
    'SCOPE traces - required for every changed file that writes or mutates state:',
    '`SCOPE: <file:line> partition=<repo|tenant|user|project|lane|packet|scope|slug|id|NONE>`',
    'Then state the single intended destination and confirm the diff writes there and only there. Flag output written to the wrong location or duplicated across locations.',
    '',
    'GUARD traces - required for every new guard, condition, or early return:',
    '`GUARD: <file:line> fires-from=<file:line|INERT>`',
    '',
    contractArmed
      ? 'COVERAGE checklist - enumerate each requirement ID from the pre-edit task contract:'
      : 'COVERAGE checklist - enumerate each sub-requirement from the packet scope:',
    '`COVERAGE:`',
    contractArmed
      ? '`[x] <ID> <sub-requirement> - evidence <file:line|command output>`'
      : '`[x] <sub-requirement> - evidence <file:line|command output>`',
    contractArmed
      ? '`[ ] <ID> <sub-requirement> - gap <reason>`'
      : '`[ ] <sub-requirement> - gap <reason>`',
    contractArmed && input.taskContract?.processConstraints?.length
      ? 'PROCESS checklist - assess every process constraint ID from transcript, lane events, or command observations. Mark unavailable process evidence as a Reviewer limitation: and leave it unverified for the operator; never cite a changed file as proof of an unrelated process action.'
      : null,
    contractArmed && input.taskContract?.processConstraints?.length && input.lane.packetId
      ? `Retrieve the packet's persisted worker evidence with o8_packet_transcript(${JSON.stringify({ packetId: input.lane.packetId, tail: true, limit: 50 })}). Paginate with cursor and limit when the required evidence is outside that tail. Cite concrete event sequences for process constraints. If the tool or evidence is unavailable, record a Reviewer limitation: with the affected process IDs; do not guess transcript paths or assume the previous reviewer session's context is available.`
      : null,
    contractArmed ? '' : null,
    contractArmed ? 'MINIMALITY trace - map every changed file or bounded change unit to task-contract requirement IDs:' : null,
    contractArmed ? '`MINIMALITY: <file|change-unit> -> <R1,R2|DEVIATION> necessary=<yes|no> evidence=<reason|implementation-notes entry>`' : null,
    contractArmed ? 'Then state the smallest complete counterfactual diff. If the current diff is substantially larger without requirement-backed evidence, request changes.' : null,
    contractArmed ? '' : null,
    'COMPLETENESS trace - when the change establishes or restores an invariant, name it, then enumerate every production path with that property:',
    '`INVARIANT: <one sentence, or NONE>`',
    '`SITE: <file:line> covered=<yes|no> evidence=<file:line|reason>`',
    '',
    contractArmed
      ? `Hard approval rule: You may not approve if ${taskContractMissing ? 'the pre-edit task contract is missing, ' : ''}any guard is INERT, any write has partition=NONE, any COVERAGE box is unchecked, the diff contains an unjustified non-minimal change unit, or any COMPLETENESS site is uncovered. Request changes instead.`
      : 'Hard approval rule: You may not approve if any guard is INERT, any write has partition=NONE, any COVERAGE box is unchecked, or any COMPLETENESS site is uncovered. Request changes instead.',
    'When any COMPLETENESS site is uncovered, list every uncovered `SITE:` line in the request-changes findings so the next worker round receives the full set.',
    contractArmed
      ? 'For submit_review, include contractCoverageEvidence with the sealed contractVersion, the exact reviewed HEAD from `git rev-parse HEAD`, and one entry per file-backed requirement: `{ requirementId, productionPath, anchor?, verification? }`. Each productionPath must be a repo-relative file the change actually touched. For every process constraint include a separate processEntries item `{ constraintId, source: "transcript"|"lane-event"|"command", reference }` citing a concrete turn, event, or command observation. If process evidence is unavailable, record a Reviewer limitation: and omit that process entry; the operator must supply its citation before merge. reviewedHeadSha must equal contractCoverageEvidence.headSha.'
      : null,
    'To clear an intentional global write, cite the file:line that proves the global destination is correct.',
    'Where the change has observable output (a file written, a command stdout, a function return), prefer to run it in the worktree and inspect the actual output over reasoning about the diff.',
  ].filter((value): value is string => value !== null).join('\n');

  return [
    `An agent has completed work on lane "${input.lane.label}" (branch: ${input.lane.branch}).`,
    '',
    depthGuidance,
    '',
    'Review the diff independently. Summarize the change and its evidence for the operator approval card.',
    REVIEW_RUN_EVIDENCE_PROMPT,
    '',
    input.mergeGateSection,
    input.mergeGateSection ? '' : null,
    input.mechanicalChecksSummary || null,
    input.mechanicalChecksSummary ? '' : null,
    input.selfReviewSection,
    '',
    REVIEWER_OUTCOME_OWNERSHIP_PROMPT_V1,
    REVIEWER_LIMITATIONS,
    '',
    deviationsSection,
    '',
    taskContractSection,
    taskContractSection ? '' : null,
    input.reviewScreenshot ? '## Attached review screenshot' : null,
    input.reviewScreenshot ? 'A screenshot was auto-captured when this lane entered review. Inspect the image file directly at native resolution instead of asking for a reduced copy.' : null,
    input.reviewScreenshot ? `Image path: ${input.reviewScreenshot.path}` : null,
    reviewScreenshotMetadata ? `Image metadata: ${reviewScreenshotMetadata}` : null,
    input.reviewScreenshot ? '' : null,
    input.diffSummary,
    '',
    requiredTraceFormat,
    '',
    input.adversarialReviewProtocol || null,
    input.adversarialReviewProtocol ? '' : null,
    'Report a 1-2 sentence change summary, the completed Required verification traces, and your recommendation: approve or request changes.',
    'EXECUTION-PATH TRACE: trace the actual call path the change runs under, not the one its name implies.',
    input.mergeGateSection ? 'Address each merge gate violation as an enforcement-level finding.' : null,
    input.mechanicalChecksSummary ? 'Confirm or dismiss each mechanical check finding with evidence.' : null,
    '',
    input.lane.packetId
      ? `After reviewing, record your verdict by calling submit_review with packetId "${input.lane.packetId}", findings, and reviewedHeadSha from \`git rev-parse HEAD\`.`
      : 'This lane has no packet ID. Report the verdict and an Operator follow-up: to bind the lane to a packet before recording or merging it.',
    input.lane.packetId
      ? 'Set approved=true only if all required traces clear; otherwise set approved=false with findings. Never attempt a merge after a rejected or unrecorded verdict.'
      : null,
    input.lane.packetId
      ? `Only after the approved verdict is recorded, and only when the requested next action is a merge, call approve_and_merge(${JSON.stringify({ packetId: input.lane.packetId, expectedHeadSha: '<reviewed HEAD>' })}). Report any returned blockers without claiming the merge succeeded.`
      : null,
    'PR creation and draft-to-ready changes require an operator follow-up. If either action was requested, include a separate finding with severity "note" and description starting "Operator follow-up:" that names the outstanding action and PR when known. Include it in submit_review findings (or the structured verdict fallback) so it appears on the review card; prose alone is insufficient.',
    'Use status "deferred" and approved=false if that missing action blocks the required outcome; otherwise use status "accepted" for the handoff. Do not claim the PR was created or marked ready, and do not merge when the requested outcome is PR publication only.',
  ].filter((value): value is string => value !== null && value !== undefined).join('\n');
}
