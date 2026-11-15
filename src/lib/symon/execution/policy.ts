import { symonToolTimeoutMs } from '@/lib/mobile/symon-tool-relay';
import type { PhoneToolName } from './catalog';

/** Governance classes, not a guarantee that a side effect can be undone. */
export type SafetyClass = 'read-only' | 'reversible' | 'destructive';

export const PHONE_TOOL_SAFETY_CLASSES: Readonly<Record<PhoneToolName, SafetyClass>> = {
  'symon_machine_list': 'read-only',
  'symon_machine_switch': 'reversible',
  'symon_execute_plan': 'reversible',
  'o8_status': 'read-only',
  'o8_team_inbox': 'read-only',
  'o8_ask': 'read-only',
  'o8_needs_me': 'read-only',
  'o8_attention_why': 'read-only',
  'o8_approve_item': 'reversible',
  'o8_reject_item': 'reversible',
  'o8_dispatch': 'reversible',
  'escalate': 'read-only',
  'o8_review_diff': 'read-only',
  'o8_delegate': 'reversible',
  'o8_packet_reset': 'reversible',
  'o8_stop_agent': 'reversible',
  'o8_packet_wait': 'read-only',
  'o8_recap': 'read-only',
  'o8_usage': 'read-only',
  'o8_panel_read': 'read-only',
  'terminal_list': 'read-only',
  'terminal_send': 'reversible',
  'agent_turn': 'reversible',
  'o8_packet_steer': 'reversible',
  'o8_agent_task': 'reversible',
  'o8_packet_rerun': 'reversible',
  'gh_issue_create': 'reversible',
  'gh_comment': 'reversible',
  'git_status': 'read-only',
  'git_log': 'read-only',
  'repo_commit_diff': 'read-only',
  'gh_pr_list': 'read-only',
  'gh_issue_list': 'read-only',
  'gh_issue_view': 'read-only',
  'gh_pr_view': 'read-only',
  'gh_triage': 'read-only',
  'symon_ledger_recent': 'read-only',
  'symon_ledger_undo': 'reversible',
  'symon_watch': 'reversible',
  'symon_watch_list': 'read-only',
  'symon_watch_cancel': 'reversible',
  'symon_watch_run': 'reversible',
};

/** Unlisted names, including dynamic mcp__ tools, default to the strictest class. */
export function toolSafetyClass(name: string): SafetyClass {
  return Object.hasOwn(PHONE_TOOL_SAFETY_CLASSES, name)
    ? PHONE_TOOL_SAFETY_CLASSES[name as PhoneToolName]
    : 'destructive';
}

/** Keep execution budgets identical to the existing phone relay. */
export { symonToolTimeoutMs as toolTimeoutMs };
