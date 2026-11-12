/**
 * `o8 inbox list | approve | reject` — the governance approval queue from the CLI.
 *
 * CLI-as-control-plane symmetry (Stage 6). Thin clients of the
 * gated /api/panel/approvals route — the same queue the o8_approve / o8_reject
 * MCP tools resolve and the desktop inbox surfaces. This is where a worker-context
 * `o8 packet approve-merge` lands its card: the operator lists it here and
 * approves, which dispatches the held lane-merge continuation through the gate.
 *
 *   o8 inbox list [--all]          # pending approvals (--all includes resolved)
 *   o8 inbox approve <id>          # approve → runs the deferred action (e.g. merge)
 *   o8 inbox reject  <id>          # reject → sends it back
 */

import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import {
  printHumanHeading,
  printHumanKv,
  printJson,
  type OutputMode,
} from '../output.js';

interface Approval {
  id: string;
  title?: string;
  risk?: string;
  status?: string;
  createdAt?: string | number;
  sessionKey?: string;
}

function firstPositional(rest: string[]): string | null {
  const tok = rest.find((t) => !t.startsWith('-'));
  return tok?.trim() || null;
}

async function runInboxList(mode: OutputMode, rest: string[]): Promise<number> {
  const cfg = resolveConfig();
  const all = rest.includes('--all');
  const res = await apiFetch<{ approvals?: Approval[] }>(cfg, '/api/panel/approvals', {
    query: { status: all ? 'all' : 'pending' },
  });
  const approvals = res.data?.approvals ?? [];
  const payload = { schema: 'o8/cli/inbox.list/v1', count: approvals.length, approvals };
  if (mode.human) {
    printHumanHeading(`inbox (${approvals.length} ${all ? 'total' : 'pending'})`);
    if (approvals.length === 0) {
      printHumanKv([['', '(no approvals)']]);
    } else {
      printHumanKv(approvals.map((a) => [a.id, `${a.risk ?? '?'} · ${a.status ?? 'pending'} · ${a.title ?? ''}`] as [string, string]));
    }
  } else {
    printJson(payload);
  }
  return 0;
}

async function resolveApproval(mode: OutputMode, rest: string[], action: 'approve' | 'reject'): Promise<number> {
  const id = firstPositional(rest);
  if (!id) {
    throw new CliError(
      'invalid_args',
      `o8 inbox ${action} requires an approval id.`,
      EXIT.INVALID_ARGS,
      'Run `o8 inbox list` to see pending approval ids.',
    );
  }
  const cfg = resolveConfig();
  const res = await apiFetch<Record<string, unknown>>(cfg, '/api/panel/approvals', {
    method: 'POST',
    body: { action, id },
  });
  const data = res.data ?? {};
  const note = typeof data.decisionNote === 'string'
    ? data.decisionNote
    : typeof data.note === 'string' ? data.note : (action === 'approve' ? 'Approved.' : 'Denied.');
  const payload = { schema: `o8/cli/inbox.${action}/v1`, id, note, result: data };
  if (mode.human) {
    printHumanHeading(`inbox ${action}`);
    printHumanKv([['approval', id], ['action', action], ['note', note]]);
  } else {
    printJson(payload);
  }
  return 0;
}

function flag(rest: string[], name: string) { return rest[rest.indexOf(name) + 1]; }
async function runDrafts(mode: OutputMode, action: string, rest: string[]): Promise<number> {
  const value = (name: string) => rest.includes(name) ? flag(rest, name) : undefined;
  const repo = value('--repo');
  let data: unknown;
  if (action === 'drafts') {
    data = (await apiFetch<{ drafts: Array<{ number: number; ageDays: number; checks: string | null; conflictsWithMain: boolean | null }>; nextPage: number | null }>(resolveConfig(), '/api/panel/prs', {
      query: { view: 'idle-drafts', repo, page: value('--page') ?? '1' },
    })).data;
  } else {
    const number = Number(rest[0]);
    const decision = action.replace('-draft', '');
    const owner = value('--owner'); const reason = value('--reason');
    if (!Number.isSafeInteger(number) || number < 1 || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new CliError('invalid_args', 'A PR number and --repo owner/repository are required.', EXIT.INVALID_ARGS);
    if (decision === 'handoff' && !owner) throw new CliError('invalid_args', 'Handoff requires --owner <GitHub login>.', EXIT.INVALID_ARGS);
    if (decision === 'close' && !reason?.trim()) throw new CliError('invalid_args', 'Close requires --reason.', EXIT.INVALID_ARGS);
    data = (await apiFetch(resolveConfig(), `/api/panel/prs/${number}`, { method: 'POST',
      body: { action: 'draft-decision', decision, repo, owner, reason },
    })).data;
  }
  if (!mode.human) printJson(data);
  else if (action !== 'drafts') printHumanKv([['decision', action], ['result', JSON.stringify(data)]]);
  else {
    const page = data as { drafts: Array<{ number: number; ageDays: number; checks: string | null; conflictsWithMain: boolean | null }>; nextPage: number | null };
    printHumanHeading('Idle draft decisions (three days)');
    printHumanKv(page.drafts.map(pr => [String(pr.number), `${pr.ageDays} days idle · checks ${pr.checks ?? 'unknown'} · conflicts with main ${pr.conflictsWithMain === null ? 'unknown' : pr.conflictsWithMain ? 'yes' : 'no'} · Continue / Handoff / Close`]));
    printHumanKv([['commands', 'inbox continue-draft | handoff-draft | close-draft <number> --repo owner/repository [--owner login] [--reason text]'], ['next page', String(page.nextPage ?? 'none')]]);
  }
  return 0;
}

export async function runInbox(mode: OutputMode, secondary: string | undefined, rest: string[]): Promise<number> {
  if (secondary && ['drafts', 'continue-draft', 'handoff-draft', 'close-draft'].includes(secondary)) return runDrafts(mode, secondary, rest);
  switch (secondary) {
    case 'list':
      return runInboxList(mode, rest);
    case 'approve':
      return resolveApproval(mode, rest, 'approve');
    case 'reject':
      return resolveApproval(mode, rest, 'reject');
    default:
      throw new CliError(
        'unknown_inbox_subcommand',
        `Unknown inbox subcommand: ${secondary ?? '(none)'}`,
        EXIT.INVALID_ARGS,
        'Subcommands: list | approve | reject | drafts | continue-draft | handoff-draft | close-draft. Run `o8 --help`.',
      );
  }
}
