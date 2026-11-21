import { randomUUID } from 'node:crypto';
import { CliError, EXIT, SLOW_MUTATION_TIMEOUT_MS } from '../../api.js';
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

const DISPOSITIONS = ['adopted_elsewhere', 'superseded', 'spec_changed', 'wontfix'] as const;
type Disposition = typeof DISPOSITIONS[number];

interface CloseResponse {
  ok: boolean;
  result?: {
    closed?: boolean;
    disposition?: Disposition;
    note?: string;
    inProgress?: boolean;
    status?: string;
    laneId?: string;
    worktreeRemoved?: boolean;
    worktreeCleanup?: 'missing' | 'removed' | 'preserved';
    preservedBranch?: string | null;
  };
  error?: { code?: string; message?: string } | string;
}

function errorMessage(response: CloseResponse | null | undefined): string {
  if (typeof response?.error === 'string') return response.error;
  if (response?.error?.message) return response.error.message;
  return 'Packet close was rejected.';
}

/**
 * A packet that never launched has no lane to resolve through. An explicit id
 * that matches no lane goes to the server as is; the server refuses an unknown packet.
 */
async function closeTargetPacketId(target: string | null): Promise<string> {
  try {
    return requirePacketId(await resolvePacketTarget(target), 'close');
  } catch (error) {
    if (target && error instanceof CliError && error.code === 'packet_target_not_found') return target;
    throw error;
  }
}

export async function runPacketClose(
  mode: OutputMode,
  rest: string[],
  command: 'close' | 'discard' = 'close',
): Promise<number> {
  const args = parsePacketArguments(rest, {
    command,
    valueFlags: ['reason', 'note', 'idempotency-key'],
    booleanFlags: ['acknowledge-missing-worktree'],
  });
  const reason = args.values.reason?.trim() || (command === 'discard' ? 'wontfix' : '');
  if (!reason || !(DISPOSITIONS as readonly string[]).includes(reason)) {
    throw new CliError(
      'invalid_args',
      `o8 packet ${command} requires --reason adopted_elsewhere|superseded|spec_changed|wontfix.`,
      EXIT.INVALID_ARGS,
      'Example: o8 packet close --reason adopted_elsewhere --note "Implemented in o8-mobile."',
    );
  }

  const packetId = await closeTargetPacketId(args.target);
  const cfg = resolveConfig();
  const res = await fetchCorrelatedPacketMutation<CloseResponse>(
    cfg,
    '/api/orchestrator/discard-packet',
    {
      packetId,
      disposition: reason,
      note: args.values.note?.trim() || undefined,
      acknowledgeMissingWorktree: args.booleans.has('acknowledge-missing-worktree'),
      clientMutationId: args.values['idempotency-key']?.trim() || randomUUID(),
    },
    { timeoutMs: SLOW_MUTATION_TIMEOUT_MS, allowConflict: true },
  );
  if (!res.data?.ok || !res.data.result?.closed) {
    const code = typeof res.data?.error === 'object' ? res.data.error?.code : undefined;
    throw new CliError(code || 'close_failed', errorMessage(res.data), EXIT.CONFLICT);
  }

  const result = res.data.result;
  const payload = {
    schema: `o8/cli/packet.${command}/v1`,
    packet: {
      id: packetId,
      disposition: result.disposition ?? reason,
      laneId: result.laneId ?? null,
      preservedBranch: result.preservedBranch ?? null,
      worktreeRemoved: result.worktreeRemoved === true,
      worktreeCleanup: result.worktreeCleanup ?? null,
    },
    note: result.note ?? 'Closed unmerged.',
  };
  if (mode.human) {
    printHumanHeading(`packet ${command}`);
    printHumanKv([
      ['packet', packetId],
      ['disposition', result.disposition ?? reason],
      ['branch', result.preservedBranch ?? '(none)'],
      ['worktree', result.worktreeCleanup ?? (result.worktreeRemoved ? 'removed' : 'preserved')],
      ['note', result.note ?? 'Closed unmerged.'],
    ]);
  } else {
    printJson(payload);
  }
  return 0;
}
