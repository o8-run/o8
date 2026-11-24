import { INBOX_DECISIONS_TOOL, handleGetInboxDecisions } from './operator-handlers/inbox-decisions';
import { INTEGRATION_QUEUE_TOOLS, handleIntegrationQueue } from './operator-handlers/integration-queue';
import { EFFECTIVE_POLICY_TOOL, handleGetEffectivePolicy } from './operator-handlers/effective-policy';
import { ADOPT_PR_TOOL, handleAdoptPr } from './operator-handlers/adopt-pr';
import { IDLE_DRAFT_TOOLS, handleIdleDrafts } from './operator-handlers/idle-drafts';
import { CONVERSATION_PR_TOOLS, handleConversationPrs } from './operator-handlers/conversation-prs';
import { PR_STACK_TOOLS, handlePrStack } from './operator-handlers/pr-stack';
import { THREAD_TOOLS, handleThreadsList } from './operator-handlers/threads';
import { safeErrorText } from '@/lib/mcp/api-error';
import { discoverMcp, isModernMcpRequest, modernMcpCall, modernMcpError, modernMcpResult } from './operator-mcp-protocol';
import { nativeReadGeneration } from '@/lib/mcp/native-read-publication';
import { SETUP_TOOLS, handleSetup } from '@/lib/mcp/operator-handlers/setup';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { createO8WebviewBrowserHandlers, O8_WEBVIEW_BROWSER_TOOLS } from '@/lib/mcp/o8-webview-browser-tools';
import { APPROVE_TOOLS, handleApprove, handleApproveAndMerge, handleMergePreview, handleReject } from '@/lib/mcp/operator-handlers/approve';
import { AGENT_MESSAGE_TOOLS, handleAgentMessageAgents, handleAgentMessageInbox, handleAgentMessageSend } from '@/lib/mcp/operator-handlers/agents';
import { CANVAS_TOOLS, handleCanvas, handleRender } from '@/lib/mcp/operator-handlers/canvas';
import { TASK_ARTIFACT_TOOLS, handleTaskArtifact } from '@/lib/mcp/operator-handlers/task-artifact';
import { VISUALIZATION_TOOLS, handleHtmlPreview, handleHtmlRender, handleVisualizationRead } from '@/lib/mcp/operator-handlers/visualization';
import { BROADCAST_TOOLS, handleBroadcastPost, handleBroadcastSay, handleBroadcastToken } from '@/lib/mcp/operator-handlers/broadcast';
import { CLOSE_PACKET_TOOLS, handleClosePacketUnmerged } from '@/lib/mcp/operator-handlers/close-packet';
import { CORTEX_TOOLS, CORTEX_HANDLERS } from '@/lib/mcp/operator-handlers/cortex';
import { DIGEST_TOOLS, handleDigest, handleFetchRaw } from '@/lib/mcp/operator-handlers/digest';
import { PROBLEM_TOOLS, handleProblemGet, handleProblemList } from '@/lib/mcp/operator-handlers/problems';
import {
  MISSION_TOOLS,
  handleCreateMission,
  handleDispatchMission,
  handleGetMissionStatus,
  handleGetPacketScope,
  handlePacketScopeGrant,
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
  REPO_MGMT_TOOLS,
  handleCreateProject,
  handleDeleteProject,
  handleInitRepo,
  handleListProjects,
  handleListRepos,
  handleRegisterRepo,
  handleRemoveRepo,
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
import { DEVICE_TOOLS, handleDevice } from './operator-handlers/devices';
import type { DeviceControllerContext } from '@/lib/devices/controller-store';
import { DeviceError } from '@/lib/devices/types';
import { boundOperatorResult, readOperatorResultPage, RESULT_PAGE_TOOL } from './operator-result-pages';

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

const USER_CONTEXT_TOOLS: McpTool[] = [
  {
    name: 'o8_user_context',
    description: 'Return local o8 user context for resolving shorthand paths without asking the user. Includes username, homedir, cwd, dataDir, and knownRepos.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function handleUserContext(): Promise<McpToolResult> {
  let username = process.env.USER || '';
  try { username = userInfo().username || username; } catch { /* keep env fallback */ }
  return jsonResult({ username, homedir: homedir(), cwd: process.cwd(), dataDir: getDataDir(), knownRepos: readKnownRepos() });
}

const TOOLS: McpTool[] = [
  ...THREAD_TOOLS,
  ADOPT_PR_TOOL,
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
  ...DIGEST_TOOLS,
  ...TARGETING_TOOLS,
  ...RECEIPT_TOOLS,
  ...TRUTH_TOOLS,
  ...AGENT_MESSAGE_TOOLS,
  ...BROADCAST_TOOLS,
  ...UPDATE_TOOLS,
  ...O8_WEBVIEW_BROWSER_TOOLS,
  ...DEVICE_TOOLS,
  ...CANVAS_TOOLS,
  ...TASK_ARTIFACT_TOOLS,
  ...VISUALIZATION_TOOLS,
  ...MISSION_TOOLS.filter((tool) => tool.name === 'create_mission'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'dispatch_mission'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'get_mission_status'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'mission_tail'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'get_packet_scope'),
  ...MISSION_TOOLS.filter((tool) => tool.name === 'o8_packet_scope_grant'),
  EFFECTIVE_POLICY_TOOL,
  INBOX_DECISIONS_TOOL,
  ...INTEGRATION_QUEUE_TOOLS,
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
  ...IDLE_DRAFT_TOOLS,
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

export function operatorToolsForProfile(profile = process.env.O8_OPERATOR_MCP_PROFILE): McpTool[] {
  let tools: McpTool[];
  if (!profile || profile === 'full') tools = TOOLS;
  else if (profile === 'visualizations') tools = VISUALIZATION_TOOLS;
  else if (profile === 'devices') tools = DEVICE_TOOLS;
  // An explicitly requested but unknown profile fails closed. A typo in a
  // safety launcher must not silently restore approvals or task tools.
  else return [];
  return [...tools.map((tool) => ({ ...tool,
    description: `${tool.description} Text results over 20 KB return a summary and saved pages; follow nextArguments with o8_result_page without repeating the action.`,
  })), RESULT_PAGE_TOOL];
}

const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  o8_threads_list: handleThreadsList,
  o8_send: handleSend,
  o8_status: handleStatus,
  o8_approve: handleApprove,
  o8_reject: handleReject,
  o8_history: handleHistory,
  o8_adopt_pr: handleAdoptPr,
  o8_conversation_prs: handleConversationPrs,
  o8_lane_events: handleLaneEvents,
  o8_packet_transcript: handleTranscript,
  steer_packet: handleSteerPacket,
  o8_operator_defaults: handleOperatorDefaults,
  o8_setup: handleSetup,
  ...CORTEX_HANDLERS,
  digest: handleDigest,
  fetch_raw: handleFetchRaw,
  o8_targets: handleTargets,
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
  o8_list_repos: handleListRepos,
  o8_register_repo: handleRegisterRepo,
  o8_remove_repo: handleRemoveRepo,
  o8_init_repo: handleInitRepo,
  o8_list_projects: handleListProjects,
  o8_create_project: handleCreateProject,
  o8_set_active_project: handleSetActiveProject,
  o8_set_project_repos: handleSetProjectRepos,
  o8_delete_project: handleDeleteProject,
  ...createO8WebviewBrowserHandlers(),
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
  o8_packet_scope_grant: handlePacketScopeGrant,
  get_effective_policy: handleGetEffectivePolicy,
  get_inbox_decisions: handleGetInboxDecisions,
  o8_integration_queue: handleIntegrationQueue,
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
  o8_idle_drafts: handleIdleDrafts,
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

export async function handleOperatorMcpMessage(message: OperatorMcpRequest, requestedProfile?: string, deviceContext?: DeviceControllerContext): Promise<OperatorMcpResponse | null> {
  if (isModernMcpRequest(message)) {
    const refusal = modernMcpError(message);
    if (refusal) return refusal;
    if (message.method === 'server/discover') return { jsonrpc: '2.0', id: message.id!, result: discoverMcp() };
    if (message.method === 'initialize') return { jsonrpc: '2.0', id: message.id!, error: { code: -32601, message: 'Modern MCP uses server/discover' } };
    const response = await dispatchOperatorMcpMessage(modernMcpCall(message), requestedProfile, deviceContext);
    return response?.result === undefined ? response : { ...response, result: modernMcpResult(response.result, message.method === 'tools/list') };
  }
  return dispatchOperatorMcpMessage(message, requestedProfile, deviceContext);
}

async function dispatchOperatorMcpMessage(message: OperatorMcpRequest, requestedProfile?: string, deviceContext?: DeviceControllerContext): Promise<OperatorMcpResponse | null> {
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
    const rawArgs = params?.arguments === undefined ? {} : params.arguments;
    if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
      return { jsonrpc: '2.0', id, result: textResult('arguments must be an object. Set arguments to an object such as {}.', true) };
    }
    const toolArgs = expandToolPathArgs(
      rawArgs as Record<string, unknown>,
    ) as Record<string, unknown>;
    const exposed = activeTools.some((tool) => tool.name === toolName);
    if (!exposed) {
      const profile = process.env.O8_OPERATOR_MCP_PROFILE?.trim() || 'full';
      return {
        jsonrpc: '2.0',
        id,
        result: textResult(`Tool unavailable in operator MCP profile ${profile}: ${toolName}. Call tools/list and use an available name exactly.`, true),
      };
    }
    const resultScope = JSON.stringify([getDataDir(), process.env.O8_OPERATOR_MCP_PROFILE || 'full', requestedProfile || '', deviceContext ?? null]);
    if (toolName === RESULT_PAGE_TOOL.name) {
      return { jsonrpc: '2.0', id, result: readOperatorResultPage(toolArgs, resultScope, new Set(activeTools.map((tool) => tool.name))) };
    }
    const handler = toolName === 'o8_device' ? (args: Record<string, unknown>) => handleDevice(args, deviceContext) : TOOL_HANDLERS[toolName];
    if (!handler) return { jsonrpc: '2.0', id, result: textResult(`Unknown tool: ${toolName}`, true) };
    try {
      return { jsonrpc: '2.0', id, result: boundOperatorResult(toolName, resultScope, await handler(toolArgs)) };
    } catch (error) {
      if (error instanceof DeviceError) return { jsonrpc: '2.0', id, result: jsonResult({ error: { code: error.code, message: error.message } }, true) };
      return { jsonrpc: '2.0', id, result: textResult(`Tool error: ${safeErrorText(error)}`, true) };
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}
