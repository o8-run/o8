import { readFileSync } from 'node:fs';

import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../output.js';
import { parseDurationMs } from './mission.js';

interface LeadResponse {
  schema: string;
  ok: boolean;
  lead: {
    id: string;
    threadId: string;
    repoPath: string;
    routing: { backend: string; model: string; effort: string };
    status: string;
    result: { turnId: string | null; status: string; text: string | null; error: string | null;
      reason?: string | null; outcome?: { kind: string; summary: string | null; evidence: unknown } | null } | null;
    stopReason: string | null;
  };
  latestTurn: { id: string; ordinal: number; kind: string; status: string; error: string | null } | null;
  requestedTurn: { id: string; ordinal: number; kind: string; status: string; error: string | null } | null;
  queueDepth: number;
  cursor: number;
  events: Array<{ cursor: number; kind: string; status: string; detail: string | null }>;
  admittedTurnId?: string;
}

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const result = args[index + 1];
  if (!result || result.startsWith('--')) {
    throw new CliError('invalid_args', `--${name} requires a value.`, EXIT.INVALID_ARGS);
  }
  return result;
}

function positional(args: string[]): string[] {
  const results: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith('--')) {
      index += 1;
      continue;
    }
    results.push(args[index]);
  }
  return results;
}

function required(args: string[], name: string): string {
  const result = value(args, name);
  if (!result) throw new CliError('invalid_args', `--${name} is required.`, EXIT.INVALID_ARGS);
  return result;
}

function printLead(mode: OutputMode, response: LeadResponse): void {
  if (!response?.ok || !response.lead?.id) {
    throw new CliError('invalid_response', 'Lead endpoint returned an invalid response.', EXIT.INVALID_ARGS);
  }
  if (!mode.human) {
    printJson({ ...response, schema: 'o8/cli/lead/v1' });
    return;
  }
  printHumanHeading(`o8 lead ${response.lead.id}`);
  printHumanKv([
    ['status', response.lead.status],
    ['thread', response.lead.threadId],
    ['routing', `${response.lead.routing.backend}/${response.lead.routing.model}/${response.lead.routing.effort}`],
    ['queued', String(response.queueDepth)],
    ['cursor', String(response.cursor)],
    ['reason', response.lead.result?.reason ?? ''],
    ['outcome', response.lead.result?.outcome ? JSON.stringify(response.lead.result.outcome) : ''],
  ]);
}

async function start(mode: OutputMode, args: string[]): Promise<number> {
  const briefPath = required(args, 'brief');
  let brief: unknown;
  try {
    brief = JSON.parse(readFileSync(briefPath, 'utf8'));
  } catch (error) {
    throw new CliError(
      'invalid_brief',
      `Could not read JSON brief ${briefPath}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.INVALID_ARGS,
    );
  }
  const response = await apiFetch<LeadResponse>(resolveConfig(), '/api/orchestrator/lead', {
    method: 'POST',
    body: {
      action: 'start',
      repoPath: required(args, 'repo'),
      backend: required(args, 'backend'),
      model: required(args, 'model'),
      effort: required(args, 'effort'),
      idempotencyKey: required(args, 'idempotency-key'),
      brief,
    },
  });
  printLead(mode, response.data as LeadResponse);
  return 0;
}

async function send(mode: OutputMode, args: string[]): Promise<number> {
  const leadId = positional(args)[0];
  if (!leadId) throw new CliError('invalid_args', 'Usage: o8 lead send <lead-id> --message <text> --idempotency-key <key>', EXIT.INVALID_ARGS);
  const body: Record<string, unknown> = {
    action: 'send',
    leadId,
    message: required(args, 'message'),
    idempotencyKey: required(args, 'idempotency-key'),
  };
  for (const [flag, field] of [
    ['repo', 'repoPath'],
    ['thread-id', 'threadId'],
    ['backend', 'backend'],
    ['model', 'model'],
    ['effort', 'effort'],
  ]) {
    const selected = value(args, flag);
    if (selected) body[field] = selected;
  }
  const response = await apiFetch<LeadResponse>(resolveConfig(), '/api/orchestrator/lead', {
    method: 'POST',
    body,
  });
  printLead(mode, response.data as LeadResponse);
  return 0;
}

async function report(mode: OutputMode, args: string[]): Promise<number> {
  const leadId = positional(args)[0];
  if (!leadId) {
    throw new CliError('invalid_args', 'Usage: o8 lead report <lead-id> --turn <id> --repo <path> --thread-id <id> --kind <kind> --summary <text> --evidence <json-array>', EXIT.INVALID_ARGS);
  }
  let evidence: unknown;
  try {
    evidence = JSON.parse(required(args, 'evidence'));
  } catch (error) {
    throw new CliError(
      'invalid_args',
      `--evidence must be a JSON array: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.INVALID_ARGS,
    );
  }
  const response = await apiFetch<LeadResponse>(resolveConfig(), '/api/orchestrator/lead', {
    method: 'POST',
    body: {
      action: 'report',
      leadId,
      turnId: required(args, 'turn'),
      repoPath: required(args, 'repo'),
      threadId: required(args, 'thread-id'),
      kind: required(args, 'kind'),
      summary: required(args, 'summary'),
      evidence,
    },
  });
  printLead(mode, response.data as LeadResponse);
  return 0;
}

async function status(mode: OutputMode, args: string[]): Promise<number> {
  const leadId = positional(args)[0];
  if (!leadId) throw new CliError('invalid_args', 'Usage: o8 lead status <lead-id> [--after <cursor>]', EXIT.INVALID_ARGS);
  const response = await apiFetch<LeadResponse>(resolveConfig(), '/api/orchestrator/lead', {
    query: { leadId, turnId: value(args, 'turn'), afterCursor: value(args, 'after') },
  });
  printLead(mode, response.data as LeadResponse);
  return 0;
}

async function wait(mode: OutputMode, args: string[]): Promise<number> {
  const leadId = positional(args)[0];
  if (!leadId) throw new CliError('invalid_args', 'Usage: o8 lead wait <lead-id> [--timeout 10m] [--after <cursor>]', EXIT.INVALID_ARGS);
  const timeoutMs = parseDurationMs(value(args, 'timeout'), 10 * 60 * 1000);
  const deadline = Date.now() + timeoutMs;
  let cursor = Number.parseInt(value(args, 'after') ?? '0', 10);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new CliError('invalid_args', '--after must be a non-negative integer.', EXIT.INVALID_ARGS);
  }
  const terminal = new Set(['completed', 'blocked', 'needs_approval', 'failed', 'stopped']);
  let latest: LeadResponse | null = null;
  let turnId = value(args, 'turn');
  while (Date.now() < deadline) {
    const waitMs = Math.min(30_000, Math.max(1, deadline - Date.now()));
    const response = await apiFetch<LeadResponse>(resolveConfig(), '/api/orchestrator/lead', {
      query: { leadId, turnId, afterCursor: cursor, waitMs },
      timeoutMs: waitMs + 5_000,
    });
    latest = response.data as LeadResponse;
    turnId ??= latest.requestedTurn?.id;
    cursor = latest.cursor;
    const terminalStatus = latest.lead.status === 'stopped'
      ? 'stopped'
      : latest.requestedTurn?.status ?? latest.lead.status;
    if (terminal.has(terminalStatus) || terminalStatus === 'interrupted') {
      printLead(mode, latest);
      return 0;
    }
  }
  if (latest) printLead(mode, latest);
  throw new CliError('lead_wait_timeout', `Lead did not reach a terminal state within ${timeoutMs}ms.`, EXIT.SERVER_TIMEOUT);
}

async function stop(mode: OutputMode, args: string[]): Promise<number> {
  const leadId = positional(args)[0];
  if (!leadId) throw new CliError('invalid_args', 'Usage: o8 lead stop <lead-id> [--reason <text>]', EXIT.INVALID_ARGS);
  const response = await apiFetch<LeadResponse>(resolveConfig(), '/api/orchestrator/lead', {
    method: 'POST',
    body: { action: 'stop', leadId, reason: value(args, 'reason') },
  });
  printLead(mode, response.data as LeadResponse);
  return 0;
}

export async function runLead(
  mode: OutputMode,
  subcommand: string | undefined,
  args: string[],
): Promise<number> {
  if (subcommand === 'start') return start(mode, args);
  if (subcommand === 'send') return send(mode, args);
  if (subcommand === 'report') return report(mode, args);
  if (subcommand === 'status') return status(mode, args);
  if (subcommand === 'wait') return wait(mode, args);
  if (subcommand === 'stop') return stop(mode, args);
  throw new CliError('unknown_lead_subcommand', `Unknown lead subcommand: ${subcommand ?? '(none)'}`, EXIT.INVALID_ARGS);
}
