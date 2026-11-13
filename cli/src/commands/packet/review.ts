import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CliError, EXIT } from '../../api.js';
import { resolveConfig } from '../../config.js';
import {
  printHumanHeading,
  printHumanKv,
  printJson,
  type OutputMode,
} from '../../output.js';
import {
  parsePacketArguments,
  requirePacketId,
  resolvePacketTarget,
} from './target.js';
import { fetchCorrelatedPacketMutation } from './correlated-mutation.js';

interface ReviewArgs {
  packetId: string | null;
  approve: boolean;
  runEvidence?: unknown;
  expectedHeadSha: string | null;
  commitMessage: string | null;
  idempotencyKey: string | null;
  contractVersion: number | null;
  coverageEntries: Array<{
    requirementId: string;
    productionPath: string;
    source?: 'transcript' | 'lane-event' | 'command';
    reference?: string;
  }>;
  processEntries: Array<{ constraintId: string; source: 'transcript' | 'lane-event' | 'command'; reference: string }>;
  missingContractWaiverReason: string | null;
  supplementProcessEvidence: boolean;
}

interface OperatorResponse<T> {
  ok: boolean;
  result?: T;
  error?: { message?: string } | string;
}

function parseReviewArgs(rest: string[]): ReviewArgs {
  const args = parsePacketArguments(rest, {
    command: 'review',
    valueFlags: ['expected-sha', 'commit-message', 'idempotency-key', 'contract-version', 'waive-missing-contract', 'run-evidence', 'not-run'],
    repeatableValueFlags: ['coverage', 'requirement-evidence', 'process-evidence'],
    booleanFlags: ['approve', 'supplement-process-evidence'],
  });

  const rawContractVersion = args.values['contract-version']?.trim();
  if (rawContractVersion && !/^\d+$/.test(rawContractVersion)) {
    throw new CliError('invalid_args', '--contract-version must be a positive integer.', EXIT.INVALID_ARGS);
  }
  const contractVersion = rawContractVersion ? Number.parseInt(rawContractVersion, 10) : null;
  if (contractVersion !== null && contractVersion < 1) {
    throw new CliError('invalid_args', '--contract-version must be a positive integer.', EXIT.INVALID_ARGS);
  }

  const seenRequirementIds = new Set<string>();
  const coverageEntries: ReviewArgs['coverageEntries'] = (args.multiValues.coverage ?? []).map((entry) => {
    const separator = entry.indexOf('=');
    const requirementId = separator >= 0 ? entry.slice(0, separator).trim() : '';
    const productionPath = separator >= 0 ? entry.slice(separator + 1).trim() : '';
    if (!requirementId || !productionPath) {
      throw new CliError(
        'invalid_args',
        '--coverage must use <requirement-id>=<repo-relative-production-path>.',
        EXIT.INVALID_ARGS,
      );
    }
    if (seenRequirementIds.has(requirementId)) {
      throw new CliError(
        'invalid_args',
        `--coverage repeats requirement ${requirementId}.`,
        EXIT.INVALID_ARGS,
      );
    }
    seenRequirementIds.add(requirementId);
    return { requirementId, productionPath };
  });

  for (const entry of args.multiValues['requirement-evidence'] ?? []) {
    const separator = entry.indexOf('=');
    const requirementId = separator >= 0 ? entry.slice(0, separator).trim() : '';
    const citation = separator >= 0 ? entry.slice(separator + 1).trim() : '';
    const colon = citation.indexOf(':');
    const source = citation.slice(0, colon);
    const reference = colon >= 0 ? citation.slice(colon + 1).trim() : '';
    if (!requirementId || !['transcript', 'lane-event', 'command'].includes(source) || !reference) {
      throw new CliError('invalid_args', '--requirement-evidence must use <requirement-id>=<transcript|lane-event|command>:<concrete reference>.', EXIT.INVALID_ARGS);
    }
    if (seenRequirementIds.has(requirementId)) {
      throw new CliError('invalid_args', `--requirement-evidence repeats requirement ${requirementId}.`, EXIT.INVALID_ARGS);
    }
    seenRequirementIds.add(requirementId);
    coverageEntries.push({ requirementId, productionPath: '', source: source as 'transcript' | 'lane-event' | 'command', reference });
  }

  const seenConstraintIds = new Set<string>();
  const processEntries = (args.multiValues['process-evidence'] ?? []).map((entry) => {
    const separator = entry.indexOf('=');
    const constraintId = separator >= 0 ? entry.slice(0, separator).trim() : '';
    const citation = separator >= 0 ? entry.slice(separator + 1).trim() : '';
    const sourceSeparator = citation.indexOf(':');
    const source = sourceSeparator >= 0 ? citation.slice(0, sourceSeparator).trim() : '';
    const reference = sourceSeparator >= 0 ? citation.slice(sourceSeparator + 1).trim() : '';
    if (!constraintId || !['transcript', 'lane-event', 'command'].includes(source) || !reference) {
      throw new CliError('invalid_args', '--process-evidence must use <constraint-id>=<transcript|lane-event|command>:<concrete reference>.', EXIT.INVALID_ARGS);
    }
    if (seenConstraintIds.has(constraintId)) {
      throw new CliError('invalid_args', `--process-evidence repeats constraint ${constraintId}.`, EXIT.INVALID_ARGS);
    }
    seenConstraintIds.add(constraintId);
    return { constraintId, source: source as 'transcript' | 'lane-event' | 'command', reference };
  });

  if (processEntries.length > 0 && coverageEntries.length === 0) {
    throw new CliError('invalid_args', '--process-evidence requires --coverage or --requirement-evidence entries.', EXIT.INVALID_ARGS);
  }

  if (contractVersion !== null && coverageEntries.length === 0) {
    throw new CliError(
      'invalid_args',
      '--contract-version requires at least one --coverage or --requirement-evidence entry.',
      EXIT.INVALID_ARGS,
    );
  }
  const missingContractWaiverReason = args.values['waive-missing-contract']?.trim() || null;
  if (missingContractWaiverReason && (missingContractWaiverReason.length > 500 || coverageEntries.length > 0)) {
    throw new CliError('invalid_args', '--waive-missing-contract requires a reason of at most 500 characters and cannot be combined with --coverage.', EXIT.INVALID_ARGS);
  }

  let runEvidence: unknown;
  if (args.values['run-evidence'] && args.values['not-run']) throw new CliError('invalid_args', 'Choose --run-evidence or --not-run.', EXIT.INVALID_ARGS);
  if (args.values['run-evidence']) {
    try {
      const raw = readFileSync(args.values['run-evidence'], 'utf8');
      if (raw.length > 220_000) throw new Error('Evidence exceeds 220000 characters.');
      runEvidence = JSON.parse(raw);
    } catch { throw new CliError('invalid_args', '--run-evidence must name a bounded JSON evidence file.', EXIT.INVALID_ARGS); }
  } else if (args.values['not-run']) runEvidence = { status: 'not_run', reason: args.values['not-run'] };
  return {
    runEvidence,
    packetId: args.target,
    approve: args.booleans.has('approve'),
    expectedHeadSha: args.values['expected-sha']?.trim() || null,
    commitMessage: args.values['commit-message']?.trim() || null,
    idempotencyKey: args.values['idempotency-key']?.trim() || null,
    contractVersion,
    coverageEntries,
    processEntries,
    missingContractWaiverReason,
    supplementProcessEvidence: args.booleans.has('supplement-process-evidence'),
  };
}

function responseError(payload: OperatorResponse<unknown> | null | undefined, fallback: string) {
  const error = payload?.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

export async function runPacketReview(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parseReviewArgs(rest);
  if (!args.approve) {
    throw new CliError(
      'invalid_args',
      'o8 packet review currently requires --approve.',
      EXIT.INVALID_ARGS,
      'Example: o8 packet review --approve --expected-sha $(git rev-parse HEAD)',
    );
  }

  const packetId = requirePacketId(await resolvePacketTarget(args.packetId), 'review');
  if (args.coverageEntries.length > 0 && !args.expectedHeadSha) {
    throw new CliError(
      'invalid_args',
      '--coverage requires --expected-sha so the evidence is bound to the reviewed commit.',
      EXIT.INVALID_ARGS,
      'Pass the full output of `git rev-parse HEAD` with --expected-sha.',
    );
  }
  if (args.missingContractWaiverReason && !/^[0-9a-f]{40}$/i.test(args.expectedHeadSha ?? '')) {
    throw new CliError('invalid_args', '--waive-missing-contract requires a full 40-character --expected-sha.', EXIT.INVALID_ARGS);
  }
  if (args.coverageEntries.length > 0 && !/^[0-9a-f]{40}$/i.test(args.expectedHeadSha ?? '')) {
    throw new CliError(
      'invalid_args',
      '--coverage requires a full 40-character commit SHA in --expected-sha.',
      EXIT.INVALID_ARGS,
      'Pass the full output of `git rev-parse HEAD` with --expected-sha.',
    );
  }
  const cfg = resolveConfig();
  const receiptKey = args.idempotencyKey ?? randomUUID();
  const reviewRes = await fetchCorrelatedPacketMutation<OperatorResponse<{
    recorded: boolean;
    reviewedHeadSha?: string | null;
    reviewMode?: string;
    verdictLabel?: string;
    runEvidence?: unknown;
    inProgress?: boolean;
    status?: string;
    note?: string;
    contractCoverage?: {
      status: 'passed' | 'failed' | 'not-applicable' | 'waived';
      reason: string;
      checks: Array<{
        requirementId: string;
        covered: boolean;
        citedPath: string | null;
      }>;
      missingRequirementIds: string[];
    } | null;
  }>>(cfg, '/api/orchestrator/review', {
    packetId,
    approved: true,
    runEvidence: args.runEvidence,
    findings: [],
    ...(args.supplementProcessEvidence ? { supplementProcessEvidence: true } : {}),
    reviewedHeadSha: args.expectedHeadSha ?? undefined,
    contractCoverageEvidence: args.coverageEntries.length > 0 ? {
      contractVersion: args.contractVersion ?? 1,
      headSha: args.expectedHeadSha!,
      entries: args.coverageEntries,
      processEntries: args.processEntries,
    } : undefined,
    ...(args.missingContractWaiverReason ? { missingContractWaiverReason: args.missingContractWaiverReason } : {}),
    clientMutationId: receiptKey,
  }, { allowConflict: true });
  if (!reviewRes.data?.ok) {
    throw new CliError('review_failed', responseError(reviewRes.data, 'Packet review was rejected.'), EXIT.CONFLICT);
  }
  const reviewResult = reviewRes.data.result;
  if (!reviewResult) {
    throw new CliError('review_failed', 'Packet review returned no result.', EXIT.CONFLICT);
  }
  if (!reviewResult.recorded) {
    throw new CliError('review_not_recorded', reviewResult.note ?? 'The review was not recorded; merge was not attempted.', EXIT.CONFLICT);
  }
  if (reviewResult.contractCoverage?.status === 'failed') {
    throw new CliError(
      'contract_coverage_failed',
      reviewResult.contractCoverage.reason,
      EXIT.CONFLICT,
      'Provide --coverage <requirement-id>=<changed-path> for file requirements, --requirement-evidence <requirement-id>=<transcript|lane-event|command>:<reference> for non-file requirements, and --process-evidence <constraint-id>=<transcript|lane-event|command>:<reference> for process constraints.',
    );
  }

  const mergeBody = {
    packetId,
    commitMessage: args.commitMessage ?? undefined,
    expectedHeadSha: args.expectedHeadSha ?? undefined,
    idempotencyKey: receiptKey,
  };
  const mergeRes = await fetchCorrelatedPacketMutation<OperatorResponse<{
    merged?: boolean;
    note?: string;
    inProgress?: boolean;
    status?: string;
    currentHeadSha?: string;
    expectedHeadSha?: string;
  }>>(cfg, '/api/orchestrator/merge', mergeBody);
  if (!mergeRes.data?.ok || !mergeRes.data.result) {
    throw new CliError('merge_failed', responseError(mergeRes.data, 'Packet merge was rejected.'), EXIT.CONFLICT);
  }
  const mergeInProgress = mergeRes.status === 202
    || mergeRes.data.result.inProgress === true
    || mergeRes.data.result.status === 'in_progress';

  const payload = {
    schema: 'o8/cli/packet.review/v1',
    packet: {
      id: packetId,
      approved: true,
      reviewMode: reviewResult.reviewMode ?? 'read_only',
      verdictLabel: reviewResult.verdictLabel ?? 'approved, not run',
      runEvidence: reviewResult.runEvidence ?? { status: 'not_run', reason: 'No run evidence was recorded.' },
      reviewedHeadSha: reviewResult.reviewedHeadSha ?? args.expectedHeadSha,
      contractCoverage: reviewResult.contractCoverage ?? null,
      mergeInProgress,
      merge: mergeRes.data.result,
    },
  };

  if (mode.human) {
    printHumanHeading('packet review');
    printHumanKv([
      ['packet', packetId],
      ['verdict', payload.packet.verdictLabel],
      ['reviewed HEAD', payload.packet.reviewedHeadSha ?? '(captured by server)'],
      ['contract coverage', payload.packet.contractCoverage
        ? `${payload.packet.contractCoverage.status}: ${payload.packet.contractCoverage.reason}`
        : 'not required'],
      ['coverage checks', payload.packet.contractCoverage?.checks
        .map((check) => `${check.requirementId}=${check.covered ? 'covered' : 'missing'}${check.citedPath ? ` (${check.citedPath})` : ''}`)
        .join(', ') ?? ''],
      ['merged', mergeInProgress ? 'already in progress (not merged twice)' : mergeRes.data.result.merged ? 'yes' : 'no'],
      ['note', mergeRes.data.result.note ?? ''],
    ]);
  } else {
    printJson(payload);
  }

  return 0;
}
