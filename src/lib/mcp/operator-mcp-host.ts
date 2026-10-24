import { CONVERSATION_PR_TOOLS, handleConversationPrs } from './operator-handlers/conversation-prs';
import { PR_STACK_TOOLS, handlePrStack } from './operator-handlers/pr-stack';
import { safeErrorText } from '@/lib/mcp/api-error';
import { discoverMcp, isModernMcpRequest, modernMcpCall, modernMcpError, modernMcpResult } from './operator-mcp-protocol';
import { nativeReadGeneration } from '@/lib/mcp/native-read-publication';
import { SETUP_TOOLS, handleSetup } from '@/lib/mcp/operator-handlers/setup';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { O8_WEBVIEW_TOOLS, createO8WebviewToolHandlers } from '@/lib/mcp/o8-webview-tools';
import { APPROVE_TOOLS, handleApprove, handleApproveAndMerge, handleMergePreview, handleReject } from '@/lib/mcp/operator-handlers/approve';
import { AGENT_MESSAGE_TOOLS, handleAgentMessageAgents, handleAgentMessageInbox, handleAgentMessageSend } from '@/lib/mcp/operator-handlers/agents';
import { CANVAS_TOOLS, handleCanvas, handleRender } from '@/lib/mcp/operator-handlers/canvas';
import { TASK_ARTIFACT_TOOLS, handleTaskArtifact } from '@/lib/mcp/operator-handlers/task-artifact';
import { VISUALIZATION_TOOLS, handleHtmlPreview, handleHtmlRender, handleVisualizationRead } from '@/lib/mcp/operator-handlers/visualization';
import { BROADCAST_TOOLS, handleBroadcastPost, handleBroadcastSay, handleBroadcastToken } from '@/lib/mcp/operator-handlers/broadcast';
import { CLOSE_PACKET_TOOLS, handleClosePacketUnmerged } from '@/lib/mcp/operator-handlers/close-packet';
import { CORTEX_TOOLS, handleAsk, handleProposeObservation } from '@/lib/mcp/operator-handlers/cortex';
import { DIGEST_TOOLS, handleDigest, handleFetchRaw } from '@/lib/mcp/operator-handlers/digest';
import { PROBLEM_TOOLS, handleProblemGet, handleProblemList } from '@/lib/mcp/operator-handlers/problems';
import {
  HARNESS_TOOLS,
  handleCapabilities,
  handleEvaluateDiff,
  handleFeatureAdd,
  handleFeatureList,
  handleFeatureNext,
  handleFeatureVerify,
  handleGroundTask,
  handleHarnessBundle,
  handleHarnessLiftStatus,
  handleHarnessMeasure,
  handleHarnessTransition,
  handleNegotiateContract,
  handleSessionBoot,
  handleSprint,
  handleVerify,
} from '@/lib/mcp/operator-handlers/harness';
import {
  MISSION_TOOLS,
  handleCreateMission,
  handleDispatchMission,
  handleGetMissionStatus,
  handleGetPacketScope,
  handleMissionTail,
  handlePacketDiff,
  handleReportPacketEvent,
  handleRerunWithFeedback,
  handleResetPacket,
  handleRetryPacket,
  handleReviewState,
  handleSubmitReview,
  handleTaskArchive,
  handleTaskBlock,
  handleTaskBrief,
  handleTaskClaim,
  handleTaskCreate,
  handleTaskDispatch,
  handleTaskList,
  handleTaskPrune,
  handleTaskReport,
  handleWaitForMissionReady,
} from '@/lib/mcp/operator-handlers/mission';
import {
  LEASE_TOOLS,
  handleLeaseAcquire,
  handleLeaseList,
  handleLeaseRelease,
  handleLeaseStatus,
} from '@/lib/mcp/operator-handlers/leases';
import {
  REPO_MGMT_TOOLS,
  handleCreateProject,
  handleDeleteProject,
  handleInitRepo,
  handleListProjects,
  handleListRepos,
  handleRegisterRepo,
  handleRemoveRepo,
  handleScaffold,
  handleSetActiveProject,
  handleSetProjectRepos,
} from '@/lib/mcp/operator-handlers/repo-management';
import {
  RECEIPT_TOOLS,
  handlePacketReceipt,
  handleVerifyReceipt,
} from '@/lib/mcp/operator-handlers/receipts';
import {
  type McpTool,
  type McpToolResult,
  checkApiHealth,
  jsonResult,
  textResult,
} from '@/lib/mcp/operator-handlers/shared';
import {
  SPEC_TOOLS,
  handleSpecComment,
  handleSpecPendingFeedback,
  handleSpecRead,
  handleSpecReply,
  handleSpecResolve,
  handleSpecReviewIndex,
  handleSpecSuggest,
  handleSpecValidate,
} from '@/lib/mcp/operator-handlers/spec';
import {
  STATUS_TOOLS,
  handleHistory,
  handleLaneEvents,
  handleOperatorDefaults,
  handleSend,
  handleStatus,
  handleSteerPacket,
  handleTranscript,
} from '@/lib/mcp/operator-handlers/status';
import { TARGETING_TOOLS, handleTargets } from '@/lib/mcp/operator-handlers/targeting';
import { TRUTH_TOOLS, handleTruthQuery } from '@/lib/mcp/operator-handlers/truth';
import { UPDATE_TOOLS, handleUpdateApply } from '@/lib/mcp/operator-handlers/update';
import { getDataDir } from '@/lib/data-dir-migration';

export interface OperatorMcpRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface OperatorMcpResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}


function expandHomePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return value;
}

function isPathArg(key: string): boolean {
  return key === 'path'
    || key === 'repoPath'
    || key === 'repoPaths'
    || key === 'cwd'
    || key === 'dataDir'
    || key.endsWith('Path')
    || key.endsWith('Paths')
    || key.endsWith('Dir');
}

function expandToolPathArgs(value: unknown, key = ''): unknown {
  if (typeof value === 'string') return isPathArg(key) ? expandHomePath(value) : value;
  if (Array.isArray(value)) return value.map((entry) => expandToolPathArgs(entry, key));
  if (value && typeof value === 'object') {
    const expanded: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      expanded[entryKey] = expandToolPathArgs(entryValue, entryKey);
    }
    return expanded;
  }
  return value;
}

function readKnownRepos(): string[] {
  const registryPath = join(getDataDir(), 'repos.json');
  if (!existsSync(registryPath)) return [];

  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf-8')) as unknown;
    const entries = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { repos?: unknown }).repos)
        ? (parsed as { repos: unknown[] }).repos
        : [];
    return entries
      .map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '';
        const record = entry as Record<string, unknown>;
        const rawPath = typeof record.path === 'string'
          ? record.path
          : typeof record.localPath === 'string'
            ? record.localPath
            : '';
        return rawPath.trim() ? resolve(expandHomePath(rawPath)) : '';
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

let o8WebviewClient: O8WebviewClient | null = null;

function getO8WebviewClient(): O8WebviewClient {
  if (!o8WebviewClient) o8WebviewClient = new O8WebviewClient();
  return o8WebviewClient;
}

const LOOP_OBSERVABILITY_TOOLS: McpTool[] = [
  {
    name: 'o8_view_console_errors',
    description: 'Returns runtime errors captured by o8\'s Rust-side ring buffer (window.onerror, unhandledrejection, console.error). Survives a busy JS thread because the buffer is populated as errors fire, not on read. Returns { errors, count, sinceLastFetch }; sinceLastFetch resets on each call.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'o8_view_active_route',
    description: 'Returns the main webview\'s current URL parts ({ pathname, search, hash, routerState }) by querying webview.url() on the Rust side. Use after o8_view_navigate to confirm the route landed without taking a screenshot. routerState is null for now; defer until we wire a Next.js segment reader.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const USER_CONTEXT_TOOLS: McpTool[] = [
  {
    name: 'o8_user_context',
    description: 'Return local o8 user context for resolving shorthand paths without asking the user. Includes username, homedir, cwd, dataDir, and knownRepos.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function invokeTauriCommandFromWebview<T>(command: string): Promise<T> {
  const code = `(() => { try {
    if (!window.__TAURI_INTERNALS__ || typeof window.__TAURI_INTERNALS__.invoke !== 'function') {
      return JSON.stringify({ ok: false, err: 'tauri internals unavailable' });
    }
    return window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)})
      .then((r) => JSON.stringify({ ok: true, data: r }))
      .catch((e) => JSON.stringify({ ok: false, err: String(e && e.message || e) }));
  } catch (e) { return JSON.stringify({ ok: false, err: String(e && e.message || e) }); } })()`;

  const { result } = await getO8WebviewClient().evalJs(code);
  let parsed: unknown = result;
  try {
    parsed = JSON.parse(result);
  } catch {
    throw new Error(`tauri invoke '${command}' returned non-JSON: ${String(result).slice(0, 200)}`);
  }
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { /* leave as is */ }
  }
  const envelope = parsed as { ok: boolean; data?: unknown; err?: string };
  if (!envelope || envelope.ok !== true) throw new Error(envelope?.err || `tauri invoke '${command}' failed`);
  return envelope.data as T;
}

async function handleConsoleErrors(): Promise<McpToolResult> {
  try {
    const data = await invokeTauriCommandFromWebview('o8_view_console_errors');
    return textResult(JSON.stringify(data));
  } catch (error) {
    return textResult(JSON.stringify({ ok: false, error: safeErrorText(error) }), true);
  }
}

async function handleActiveRoute(): Promise<McpToolResult> {
  try {
    const data = await invokeTauriCommandFromWebview('o8_view_active_route');
    return textResult(JSON.stringify(data));
  } catch (error) {
    return textResult(JSON.stringify({ ok: false, error: safeErrorText(error) }), true);
  }
}

async function handleUserContext(): Promise<McpToolResult> {
  let username = process.env.USER || '';
  try { username = userInfo().username || username; } catch { /* keep env fallback */ }
  return jsonResult({ username, homedir: homedir(), cwd: process.cwd(), dataDir: getDataDir(), knownRepos: readKnownRepos() });
}

const TOOLS: McpTool[] = [
  ...CONVERSATION_PR_TOOLS,
  ...STATUS_TOOLS.filter((tool) => tool.name === 'o8_send'),
  ...STATUS_TOOLS.filter((tool) => tool.name === 'o8_status'),
  ...USER_CONTEXT_TOOLS,
  ...REPO_MGMT_TOOLS,
  ...SETUP_TOOLS,
  ...APPROVE_TOOLS.filter((tool) => tool.name === 'o8_approve'),
  ...APPROVE_TOOLS.filter((tool) => tool.name === 'o8_reject'),
  ...STATUS_TOOLS.filter((tool) => tool.name === 'o8_history'),
  ...STATUS_TOOLS.filter((tool) => tool.name === 'o8_lane_events'),
  ...STATUS_TOOLS.filter((tool) => tool.name === 'o8_packet_transcript'),
  ...STATUS_TOOLS.filter((tool) => tool.name === 'steer_packet'),
  ...STATUS_TOOLS.filter((tool) => tool.name === 'o8_operator_defaults'),
  ...CORTEX_TOOLS,
  ...HARNESS_TOOLS,
  ...DIGEST_TOOLS,
  ...SPEC_TOOLS,
  ...TARGETING_TOOLS,
  ...LEASE_TOOLS,
  ...RECEIPT_TOOLS,
  ...TRUTH_TOOLS,
  ...AGENT_MESSAGE_TOOLS,
  ...BROADCAST_TOOLS,
  ...UPDATE_TOOLS,
  ...O8_WEBVIEW_TOOLS,
  ...CANVAS_TOOLS,
  ...TASK_ARTIFACT_TOOLS,
  ...VISUALIZATION_TOOLS,
  ...LOOP_OBSERVABILITY_TOOLS,
  ...MISSION_TOOLS.filter((tool) => tool.name === 'create_mission'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'dispatch_mission'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'get_mission_status'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'mission_tail'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'get_packet_scope'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'o8_packet_diff'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'o8_task_list'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'o8_task_create'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'o8_task_brief'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'o8_task_claim'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'o8_task_dispatch'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'o8_task_block'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'o8_task_report'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'o8_task_archive'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'o8_task_prune'),
  ...PROBLEM_TOOLS,
  ...PR_STACK_TOOLS,
  ...MISSION_TOOLS.filter((tool) => tool.name === 'wait_for_mission_ready'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'submit_review'),
  ...CLOSE_PACKET_TOOLS,
  ...APPROVE_TOOLS.filter((tool) => tool.name === 'approve_and_merge'),
  ...APPROVE_TOOLS.filter((tool) => tool.name === 'o8_merge_preview'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'reset_packet'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'retry_packet'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'rerun_with_feedback'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'o8_review_state'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'report_packet_event'),
];

/**
 * The autonomous dogfood process is an external Claude client that needs the
 * installed app as its hands and eyes, not a second control plane. Its launcher
 * sets this process-local profile so task creation, dispatch, approvals, merge,
 * and every non-webview MCP verb are absent from both discovery and execution.
 * The default remains the complete operator surface for normal clients.
 */
const DOGFOOD_TOOL_NAMES = new Set([
  ...O8_WEBVIEW_TOOLS.filter((tool) => tool.name.startsWith('o8_view_')).map((tool) => tool.name),
  'o8_view_console_errors',
  'o8_view_active_route',
]);

export function operatorToolsForProfile(profile = process.env.O8_OPERATOR_MCP_PROFILE): McpTool[] {
  if (!profile || profile === 'full') return TOOLS;
  if (profile === 'dogfood') return TOOLS.filter((tool) => DOGFOOD_TOOL_NAMES.has(tool.name));
  if (profile === 'visualizations') return VISUALIZATION_TOOLS;
  // An explicitly requested but unknown profile fails closed. A typo in a
  // safety launcher must not silently restore approvals or task tools.
  return [];
}

const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  o8_send: handleSend,
  o8_status: handleStatus,
  o8_approve: handleApprove,
  o8_reject: handleReject,
  o8_history: handleHistory,
  o8_conversation_prs: handleConversationPrs,
  o8_lane_events: handleLaneEvents,
  o8_packet_transcript: handleTranscript,
  steer_packet: handleSteerPacket,
  o8_operator_defaults: handleOperatorDefaults,
  o8_setup: handleSetup,
  cortex_propose_observation: handleProposeObservation,
  cortex_ask: handleAsk,
  o8_feature_list: handleFeatureList,
  o8_feature_next: handleFeatureNext,
  o8_feature_add: handleFeatureAdd,
  o8_feature_verify: handleFeatureVerify,
  o8_ground_task: handleGroundTask,
  o8_session_boot: handleSessionBoot,
  o8_negotiate_contract: handleNegotiateContract,
  o8_sprint: handleSprint,
  o8_verify: handleVerify,
  o8_harness_lift_status: handleHarnessLiftStatus,
  o8_harness_measure: handleHarnessMeasure,
  o8_harness_transition: handleHarnessTransition,
  o8_capabilities: handleCapabilities,
  o8_evaluate_diff: handleEvaluateDiff,
  o8_harness_bundle: handleHarnessBundle,
  digest: handleDigest,
  fetch_raw: handleFetchRaw,
  o8_targets: handleTargets,
  o8_lease_acquire: handleLeaseAcquire,
  o8_lease_release: handleLeaseRelease,
  o8_lease_status: handleLeaseStatus,
  o8_lease_list: handleLeaseList,
  o8_packet_receipt: handlePacketReceipt,
  o8_verify_receipt: handleVerifyReceipt,
  o8_truth_query: handleTruthQuery,
  o8_msg_send: handleAgentMessageSend,
  o8_msg_inbox: handleAgentMessageInbox,
  o8_msg_agents: handleAgentMessageAgents,
  o8_broadcast_post: handleBroadcastPost,
  o8_broadcast_say: handleBroadcastSay,
  o8_broadcast_token: handleBroadcastToken,
  o8_update_apply: handleUpdateApply,
  o8_spec_read: handleSpecRead,
  o8_spec_review_index: handleSpecReviewIndex,
  o8_spec_pending_feedback: handleSpecPendingFeedback,
  o8_spec_validate: handleSpecValidate,
  o8_spec_comment: handleSpecComment,
  o8_spec_reply: handleSpecReply,
  o8_spec_resolve: handleSpecResolve,
  o8_spec_suggest: handleSpecSuggest,
  o8_list_repos: handleListRepos,
  o8_register_repo: handleRegisterRepo,
  o8_remove_repo: handleRemoveRepo,
  o8_init_repo: handleInitRepo,
  o8_list_projects: handleListProjects,
  o8_create_project: handleCreateProject,
  o8_set_active_project: handleSetActiveProject,
  o8_set_project_repos: handleSetProjectRepos,
  o8_delete_project: handleDeleteProject,
  o8_scaffold: handleScaffold,
  ...createO8WebviewToolHandlers(getO8WebviewClient),
  o8_view_console_errors: handleConsoleErrors,
  o8_view_active_route: handleActiveRoute,
  o8_canvas: handleCanvas,
  o8_render: handleRender,
  o8_task_artifact: handleTaskArtifact,
  o8_html_preview: handleHtmlPreview,
  o8_html_render: handleHtmlRender,
  o8_visualization_read: handleVisualizationRead,
  o8_user_context: handleUserContext,
  create_mission: handleCreateMission,
  dispatch_mission: handleDispatchMission,
  get_mission_status: handleGetMissionStatus,
  mission_tail: handleMissionTail,
  get_packet_scope: handleGetPacketScope,
  o8_packet_diff: handlePacketDiff,
  o8_task_list: handleTaskList,
  o8_task_create: handleTaskCreate,
  o8_task_brief: handleTaskBrief,
  o8_task_claim: handleTaskClaim,
  o8_task_dispatch: handleTaskDispatch,
  o8_task_block: handleTaskBlock,
  o8_task_report: handleTaskReport,
  o8_task_archive: handleTaskArchive,
  o8_task_prune: handleTaskPrune,
  o8_pr_stack: handlePrStack,
  o8_problem_list: handleProblemList,
  o8_problem_get: handleProblemGet,
  wait_for_mission_ready: handleWaitForMissionReady,
  submit_review: handleSubmitReview,
  close_packet_unmerged: handleClosePacketUnmerged,
  approve_and_merge: handleApproveAndMerge,
  o8_merge_preview: handleMergePreview,
  reset_packet: handleResetPacket,
  retry_packet: handleRetryPacket,
  rerun_with_feedback: handleRerunWithFeedback,
  o8_review_state: handleReviewState,
  report_packet_event: handleReportPacketEvent,
};

export async function handleOperatorMcpMessage(message: OperatorMcpRequest, requestedProfile?: string): Promise<OperatorMcpResponse | null> {
  if (isModernMcpRequest(message)) {
    const refusal = modernMcpError(message);
    if (refusal) return refusal;
    if (message.method === 'server/discover') return { jsonrpc: '2.0', id: message.id!, result: discoverMcp() };
    if (message.method === 'initialize') return { jsonrpc: '2.0', id: message.id!, error: { code: -32601, message: 'Modern MCP uses server/discover' } };
    const response = await dispatchOperatorMcpMessage(modernMcpCall(message), requestedProfile);
    return response?.result === undefined ? response : { ...response, result: modernMcpResult(response.result, message.method === 'tools/list') };
  }
  return dispatchOperatorMcpMessage(message, requestedProfile);
}

async function dispatchOperatorMcpMessage(message: OperatorMcpRequest, requestedProfile?: string): Promise<OperatorMcpResponse | null> {
  const { method, id, params } = message;
  if (id === undefined || id === null) return null;

  if (method === 'initialize') {
    void checkApiHealth().catch(() => {});
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'o8-operator', version: '1.0.0' },
      },
    };
  }
  const allowedNames = requestedProfile ? new Set(operatorToolsForProfile(requestedProfile).map(tool => tool.name)) : null;
  // A transport may narrow the server's own profile, never expand it.
  const activeTools = operatorToolsForProfile().filter(tool => !allowedNames || allowedNames.has(tool.name));
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: activeTools } };
  // The opt-in Rust transport shares the existing gate, profiles and bounded
  // status snapshot. Rust projects the raw model into the public tool result.
  if (method === 'o8d/read-context' && process.env.O8D_MCP_READS === '1') {
    const requests = Array.isArray(params?.statusRequests) ? params.statusRequests : [];
    const statusSources = activeTools.some((tool) => tool.name === 'o8_status')
      ? await Promise.all(requests.map(async (entry: { index?: unknown; arguments?: Record<string, unknown> }) => {
        const args = entry?.arguments ?? {};
        if (args.fresh !== undefined && typeof args.fresh !== 'boolean') return { index: entry.index };
        try {
          const { readStatusSnapshot } = await import('@/lib/mcp/operator-handlers/status-snapshot');
          return { index: entry.index, source: await readStatusSnapshot(args.sessionKey as string | undefined, args.fresh === true) };
        } catch { return { index: entry.index }; }
      })) : [];
    return { jsonrpc: '2.0', id, result: {
      tools: activeTools, statusSources, profile: process.env.O8_OPERATOR_MCP_PROFILE?.trim() || 'full',
      nativeGeneration: nativeReadGeneration,
    } };
  }
  if (method === 'tools/call') {
    const toolName = (params as Record<string, unknown> | undefined)?.name as string;
    const toolArgs = expandToolPathArgs(
      ((params as Record<string, unknown> | undefined)?.arguments ?? {}) as Record<string, unknown>,
    ) as Record<string, unknown>;
    const exposed = activeTools.some((tool) => tool.name === toolName);
    if (!exposed) {
      const profile = process.env.O8_OPERATOR_MCP_PROFILE?.trim() || 'full';
      return {
        jsonrpc: '2.0',
        id,
        result: textResult(`Tool unavailable in operator MCP profile ${profile}: ${toolName}`, true),
      };
    }
    const handler = TOOL_HANDLERS[toolName];
    if (!handler) return { jsonrpc: '2.0', id, result: textResult(`Unknown tool: ${toolName}`, true) };
    try {
      return { jsonrpc: '2.0', id, result: await handler(toolArgs) };
    } catch (error) {
      return { jsonrpc: '2.0', id, result: textResult(`Tool error: ${safeErrorText(error)}`, true) };
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}
