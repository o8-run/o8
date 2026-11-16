import { boundedObservedResult } from '@/lib/mcp/symon-mcp-call-route';
import { callSymonMcpTool } from '@/lib/mcp/symon-tools';
import { redactThreadText } from '@/lib/threads/redaction';
import type { PhoneToolHandler } from './calls';
import type { PhoneToolReview } from './confirm';
import { approvalReview, decideApproval, reviewDiff } from './handlers/approvals';
import { github, githubReview } from './handlers/github';
import { control } from './handlers/control';
import { reads } from './handlers/reads';
import { lane, laneResult, scope } from './handlers/scope';
import { terminals, terminalTarget } from './handlers/terminals';
import { required, str, trim, type Args } from './handlers/transport';
import { watches, watchTarget } from './handlers/watches';

export const PHONE_SERVER_TOOLS = [
  'o8_status', 'o8_needs_me', 'o8_team_inbox', 'o8_ask', 'o8_attention_why', 'o8_review_diff',
  'o8_packet_wait', 'o8_recap', 'o8_usage', 'o8_panel_read', 'o8_dispatch', 'o8_delegate',
  'o8_packet_steer', 'o8_agent_task', 'o8_packet_rerun', 'o8_packet_reset', 'o8_stop_agent',
  'o8_approve_item', 'o8_reject_item', 'terminal_list', 'terminal_send', 'symon_watch_list', 'symon_watch_cancel',
  'git_status', 'git_log', 'repo_commit_diff', 'gh_pr_list', 'gh_issue_list', 'gh_issue_view',
  'gh_pr_view', 'gh_triage', 'gh_issue_create', 'gh_comment',
] as const;
export const PHONE_DEFERRED_TOOLS = new Set([
  'symon_execute_plan', 'symon_machine_list', 'symon_machine_switch', 'symon_ledger_recent',
  'symon_ledger_undo', 'symon_watch', 'symon_watch_run', 'agent_turn', 'escalate',
]);
const controls = new Set(['o8_packet_wait', 'o8_dispatch', 'o8_delegate', 'o8_packet_steer', 'o8_agent_task', 'o8_packet_rerun', 'o8_packet_reset', 'o8_stop_agent']);
const dispatch: PhoneToolHandler = async (tool, args, { signal }) => {
  if (tool.startsWith('mcp__')) {
    signal.throwIfAborted();
    const externalArgs = Object.fromEntries(Object.entries(args).filter(([key]) => !key.startsWith('__symon')));
    return boundedObservedResult(tool, await callSymonMcpTool(tool, externalArgs));
  }
  if (PHONE_DEFERRED_TOOLS.has(tool)) return { error: 'desktop_unavailable' };
  if (!(PHONE_SERVER_TOOLS as readonly string[]).includes(tool)) return { error: 'unknown_tool' };
  signal.throwIfAborted();
  checkProtectedPath(args);
  if (tool.startsWith('git_') || tool.startsWith('gh_') || tool === 'repo_commit_diff') return github(tool, args, signal);
  if (tool === 'o8_review_diff') return reviewDiff(args, signal);
  if (tool === 'o8_approve_item' || tool === 'o8_reject_item') return decideApproval(tool, args, signal);
  if (controls.has(tool)) return control(tool, args, signal);
  if (tool.startsWith('terminal_')) return terminals(tool, args, signal);
  if (tool.startsWith('symon_watch_')) return watches(tool, args, signal);
  return reads(tool, args, signal);
};

/** Preserve classic dispatch_result_payload's model-facing { error } refusals. */
export const phoneToolHandler: PhoneToolHandler = async (tool, args, context) => {
  try { return await dispatch(tool, args, context); }
  catch (error) {
    context.signal.throwIfAborted();
    return { error: redactThreadText(error instanceof Error ? error.message : 'tool_failed') };
  }
};

function checkProtectedPath(args: Args): void {
  const path = str(args, 'path');
  if (['/etc/', '/usr/', '/bin/', '/sbin/', '/var/', '/private/', '/System/', '/Library/Keychains/', '.tauri', '.env', 'credentials', 'secrets'].some(part => path.includes(part))) throw new Error('Path is a protected system path');
}

type ReviewBuilder = (args: Args, context: { signal: AbortSignal }) => Promise<PhoneToolReview>;
const packetReview = (tool: string): ReviewBuilder => async (args, { signal }) => {
  const key = tool === 'o8_stop_agent' || (tool === 'o8_agent_task' && trim(args, 'laneId')) ? 'laneId' : 'packetId';
  if (tool === 'o8_agent_task' && Boolean(trim(args, 'laneId')) === Boolean(trim(args, 'packetId'))) throw new Error('o8_agent_task requires exactly one of laneId or packetId');
  const l = await lane(args, key, signal), target = laneResult(l);
  let summary: string;
  switch (tool) {
    case 'o8_packet_steer': summary = `Steer packet ${target.packetId}: ${required(args, 'message')}`; break;
    case 'o8_agent_task': summary = `Send ${key === 'laneId' ? `lane ${target.laneId}` : `packet ${target.packetId}`} the task: ${required(args, typeof args.task === 'string' ? 'task' : 'message')}`; break;
    case 'o8_packet_rerun': summary = `Restart packet ${target.packetId} ${trim(args, 'feedback') ? `with feedback: ${trim(args, 'feedback')}` : 'fresh'}`; break;
    case 'o8_packet_reset': summary = `Reset packet ${target.packetId} without relaunching it, ${args.keepWorktree === true || (typeof args.keepWorktree !== 'boolean' && args.keep_worktree === true) ? 'keeping' : 'wiping'} its worktree`; break;
    default: summary = `Stop lane ${target.laneId}, kill it and archive it, with no relaunch`;
  }
  return { summary, target: { packetId: target.packetId, laneId: target.laneId, ...(typeof l.sessionKey === 'string' ? { sessionKey: l.sessionKey } : {}) } };
};
const dispatchReview = (tool: string): ReviewBuilder => async (args, { signal }) => {
  const task = required(args, 'task'), repo = await scope(args, signal, tool === 'o8_dispatch');
  return { summary: `${tool === 'o8_dispatch' ? 'Dispatch' : 'Delegate'} this task to ${repo?.name || repo?.id || 'the live in-app orchestrator'}: ${task}`, target: {} };
};
/** Call before start(); failures must prevent creating the confirmation card. Never trust model-supplied review fields. */
const builders: Record<string, ReviewBuilder> = {
  gh_issue_create: (args, { signal }) => githubReview('gh_issue_create', args, signal),
  gh_comment: (args, { signal }) => githubReview('gh_comment', args, signal),
  o8_dispatch: dispatchReview('o8_dispatch'), o8_delegate: dispatchReview('o8_delegate'),
  o8_packet_steer: packetReview('o8_packet_steer'), o8_agent_task: packetReview('o8_agent_task'),
  o8_packet_rerun: packetReview('o8_packet_rerun'), o8_packet_reset: packetReview('o8_packet_reset'), o8_stop_agent: packetReview('o8_stop_agent'),
  o8_approve_item: (args, { signal }) => approvalReview('o8_approve_item', args, signal),
  o8_reject_item: (args, { signal }) => approvalReview('o8_reject_item', args, signal),
  terminal_send: async (args, { signal }) => {
    const session = await terminalTarget(args, signal);
    return { summary: `Send “${str(args, 'text')}” to the o8 terminal “${session.name}”`, target: {} };
  },
  symon_watch_cancel: async (args, { signal }) => {
    signal.throwIfAborted();
    const watch = await watchTarget(args, signal);
    return { summary: `Stop watching for “${watch.condition}” (${watch.id})`, target: {} };
  },
};

export const PHONE_TOOL_REVIEW_BUILDERS: Readonly<Record<string, ReviewBuilder>> = Object.freeze(Object.fromEntries(
  Object.entries(builders).map(([tool, build]) => [tool, async (args: Args, context: { signal: AbortSignal }) => {
    checkProtectedPath(args);
    const review = await build(args, context);
    return { ...review, summary: redactThreadText(review.summary) };
  }]),
));
