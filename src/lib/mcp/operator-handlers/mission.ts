export { handleCreateMission } from './mission-create';
export { handleResetPacket, handleRetryPacket } from './packet-reset';
import { lifecycleErrorResult } from './lifecycle-error';
import {
  isAgentReportReason,
  normalizeAgentReportEvent,
  normalizeAgentReportMessage,
  normalizeAgentReportMetadata,
} from '@/lib/lane/agent-report';
import {
  dispatchMission,
  getMissionStatus,
  rerunWithFeedback,
  submitPacketReview,
} from '@/lib/mcp/operator-mission-tools';
import { getPacketScope, projectPacketScope } from '@/lib/lanes/scope';
import {
  archiveTask,
  blockTask,
  claimTask,
  createTask,
  dispatchTask,
  pruneTask,
  reportTask,
} from '@/lib/tasks/actions';
import { getTaskPoolTask } from '@/lib/tasks/pool';
import { TASK_LIST_TOOL } from '@/lib/mcp/operator-handlers/task-list';
export { handleTaskList } from '@/lib/mcp/operator-handlers/task-list';
import { listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import {
  apiFetch, McpInputError,
  type McpTool,
  type McpToolResult,
  errorText,
  jsonResult,
  optionalString,
  parseDirectivesApplied,
  parseDirectivesViolated,
  parseMissionRuntime,
  parseReviewFindings,
  requiredString,
  textResult,
} from './shared';
import {
  findMissionAttentionPacket,
  missionPacketSignature,
  type MinimalMissionStatusShape,
} from './mission-wait';
import { CREATE_MISSION_TOOL } from './mission-create-tool';
import { WORKER_PROVIDER_OPTIONS } from './mission-worker-input';
import { CONTRACT_COVERAGE_EVIDENCE_SCHEMA, parseContractCoverageEvidenceInput } from './review-coverage-input';
export const MISSION_TOOLS: McpTool[] = [
  CREATE_MISSION_TOOL,
  {
    name: 'dispatch_mission',
    description:
      'Dispatch the existing packets of a prepared mission created with dispatch:false. Pass the exact missionId returned by create_mission: dispatch_mission({missionId: "mission-abc123"}). This starts that mission without creating a new mission or generic delegate packet. Also use after reset_packet or retry_packet when a relaunch is needed, or for explicit redispatch. Omit runtime to preserve the prepared routing and contract. create_mission dispatches by default; do not dispatch it again unless it was prepared or needs relaunch. Omitted missionId selects the current stored mission.',
    inputSchema: {
      type: 'object',
      properties: {
        missionId: { type: 'string', description: 'Optional mission ID. If omitted, dispatches the current stored mission.' },
        runtime: { type: 'string', enum: listDispatchableRuntimes(), description: 'Optional per-dispatch worker runtime. When set, it overrides the runtime stamped on every not-yet-launched packet admitted by this dispatch.' },
      },
    },
  },
  {
    name: 'get_mission_status',
    description:
      'USE THIS WHEN the user asks "how\'s the mission going", "what\'s the status of my dispatch", or right before each tick of an automated review loop to see which packets are awaiting_review / running / blocked. Returns waves, packet state, active agents, blockers, optional cost and timing receipts.',
    inputSchema: {
      type: 'object',
      properties: {
        missionId: {
          type: 'string',
          description: 'Optional mission ID. If omitted, reads the current stored mission.',
        },
        includeCost: {
          type: 'boolean',
          description: 'Include aggregated runtime cost for the mission.',
        },
        includeTiming: { type: 'boolean', description: 'Include the persisted mission funnel timing and autonomy receipt.' },
      },
    },
  },
  {
    name: 'mission_tail',
    description:
      'Return a batch of lane events for one packet with a nextSince unix-ms cursor. Poll this instead of get_mission_status when the orchestrator needs progress events for a packet. Example: mission_tail({packetId: "pkt-abc", since: 1710000000000})',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'Packet id to tail.',
        },
        since: {
          type: 'number',
          description: 'Unix-ms cursor from the previous response. Omit for the first batch.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Optional long-poll timeout in ms. Default 0; max 25000.',
        },
      },
      required: ['packetId'],
    },
  },
  {
    name: 'get_packet_scope',
    description:
      'Return bounded one-call worker context for a packet or lane: project brief, repos, locks, branch, base, head SHA, worktree, path limits, directive count plus id/title references, and related packet overlaps. Directive bodies are omitted by default; pass includeDirectives:true only when their full text is needed. Provide packetId or laneId.',
    inputSchema: {
      // No top-level anyOf — OpenAI strict function-calling rejects oneOf /
      // anyOf / allOf siblings to `type: 'object'`. Handler validates that
      // either packetId or laneId is present and throws if neither is.
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'Packet id, for example pkt-abc. Either packetId or laneId is required.',
        },
        laneId: {
          type: 'string',
          description: 'Lane id, for example lane-xyz. Either packetId or laneId is required.',
        },
        includeDirectives: {
          type: 'boolean',
          description: 'Include full directive metadata and bodies. Default false; the bounded default returns only directive id/title references plus directiveCount.',
        },
      },
    },
  },
  {
    name: 'o8_packet_diff',
    description:
      "Read a packet's actual code diff (committed + uncommitted) against where its lane diverged from base — what to review before approving, without raw shell. Byte-bounded (default 64KB; pass maxBytes to raise, cap 512KB). Provide packetId or laneId.",
    inputSchema: {
      type: 'object',
      properties: {
        packetId: { type: 'string', description: 'Packet id (e.g. pkt-abc). Either packetId or laneId is required.' },
        laneId: { type: 'string', description: 'Lane id (e.g. lane-xyz). Either packetId or laneId is required.' },
        maxBytes: { type: 'number', description: 'Max diff bytes to return (default 65536, cap 524288).' },
      },
    },
  },
  TASK_LIST_TOOL,
  {
    name: 'o8_task_create',
    description:
      'Create a project-backed task in the o8 task pool. This creates a queued packet in the existing packet/lane control plane; it does not spawn a worker until o8_task_dispatch is called.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short task title.',
        },
        summary: {
          type: 'string',
          description: 'Optional task detail or brief.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project id or slug. If omitted, o8 resolves the active project.',
        },
        repoPath: {
          type: 'string',
          description: 'Optional absolute repo path for the current repo.',
        },
        workerIntent: {
          type: 'string',
          enum: ['light_worker', 'heavy_worker', 'reviewer', 'diagnostic', 'orchestrator'],
          description: 'Desired worker role. Select its runtime independently with requestedRuntime.',
        },
        requestedProvider: {
          type: 'string',
          enum: WORKER_PROVIDER_OPTIONS,
          description: 'Provider hint recorded in routing metadata. Select the execution runtime explicitly with requestedRuntime.',
        },
        requestedRuntime: {
          type: 'string',
          enum: listDispatchableRuntimes(),
          description: 'Worker runtime for this task. When omitted, the operator default applies.',
        },
        model: {
          type: 'string',
          description: 'Optional per-packet model hint. It is applied when its model house matches the selected runtime, including Claude models on claude-code packets.',
        },
        allowedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional allowed file hints for the packet brief.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'o8_task_brief',
    description:
      'Return one project-backed task brief for a packet or lane id. Use this when a worker needs the exact main repo, current repo, related repo, and output policy before editing.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Packet id, lane id, or task id.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project id or slug filter.',
        },
        repoPath: {
          type: 'string',
          description: 'Optional absolute repo path filter.',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'o8_task_claim',
    description:
      'Claim a task from the o8 task pool by binding/reserving it to a lane without launching a runtime. Use before dispatch when an agent wants an explicit ownership point.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Packet id, lane id, or task id.',
        },
        note: {
          type: 'string',
          description: 'Optional claim note.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project id or slug filter.',
        },
        repoPath: {
          type: 'string',
          description: 'Optional absolute repo path filter.',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'o8_task_dispatch',
    description:
      'Dispatch a task from the o8 task pool. Returns a durable launching receipt before provisioning finishes. Follow progress with mission_tail. Repeating the same dispatch returns its existing receipt; reset the packet before changing an active launch intent.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Packet id, lane id, or task id.',
        },
        message: {
          type: 'string',
          description: 'Optional dispatch note appended to the task brief.',
        },
        model: {
          type: 'string',
          description: 'Optional runtime model override.',
        },
        workerIntent: {
          type: 'string',
          enum: ['light_worker', 'heavy_worker', 'reviewer', 'diagnostic', 'orchestrator'],
          description: 'Desired worker role. Select its runtime independently with requestedRuntime.',
        },
        requestedProvider: {
          type: 'string',
          enum: WORKER_PROVIDER_OPTIONS,
          description: 'Provider hint recorded in routing metadata. Select the execution runtime explicitly with requestedRuntime.',
        },
        requestedRuntime: {
          type: 'string',
          enum: listDispatchableRuntimes(),
          description: 'Worker runtime for this task. When omitted, the operator default applies.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project id or slug filter.',
        },
        repoPath: {
          type: 'string',
          description: 'Optional absolute repo path filter.',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'o8_task_block',
    description:
      'Mark a task blocked with a human-readable reason. This moves the lane to awaiting_orchestrator and updates the task pool blocked group.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Packet id, lane id, or task id.',
        },
        reason: {
          type: 'string',
          description: 'Human-readable block reason.',
        },
        code: {
          type: 'string',
          enum: [
            'needs_clarification',
            'missing_context',
            'out_of_scope',
            'dependency_blocked',
            'context_full',
            'nondeterministic_test',
            'external_api_down',
            'unknown',
          ],
          description: 'Optional normalized blocker code.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project id or slug filter.',
        },
        repoPath: {
          type: 'string',
          description: 'Optional absolute repo path filter.',
        },
      },
      required: ['taskId', 'reason'],
    },
  },
  {
    name: 'o8_task_report',
    description:
      'Append a structured progress report to a task lane. event:"blocked" or event:"question" also moves the task to awaiting_orchestrator.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Packet id, lane id, or task id.',
        },
        event: {
          type: 'string',
          description: 'Report event, for example progress, blocked, question, or handoff.',
        },
        status: {
          type: 'string',
          description: 'Alias for event when callers think in status terms.',
        },
        reason: {
          type: 'string',
          enum: [
            'needs_clarification',
            'missing_context',
            'out_of_scope',
            'dependency_blocked',
            'context_full',
            'nondeterministic_test',
            'external_api_down',
            'unknown',
          ],
          description: 'Optional normalized report reason.',
        },
        message: {
          type: 'string',
          description: 'Optional human-readable detail.',
        },
        metadata: {
          type: 'object',
          description: 'Optional structured metadata to attach to the report.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project id or slug filter.',
        },
        repoPath: {
          type: 'string',
          description: 'Optional absolute repo path filter.',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'o8_task_archive',
    description:
      'Archive a stale task-pool row by archiving its lane and marking its packet archived. Use this to prune old session_lost or launch_error rows from active ready/running pools while preserving history.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Packet id, lane id, or task id.',
        },
        reason: {
          type: 'string',
          description: 'Optional cleanup reason.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project id or slug filter.',
        },
        repoPath: {
          type: 'string',
          description: 'Optional absolute repo path filter.',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'o8_task_prune',
    description:
      'Permanently prune a done/archived task-pool row after the work is genuinely complete. Removes the terminal packet and lane from the visible pool, so use archive first for active or stale rows.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Packet id, lane id, or task id.',
        },
        reason: {
          type: 'string',
          description: 'Optional cleanup reason.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project id or slug filter.',
        },
        repoPath: {
          type: 'string',
          description: 'Optional absolute repo path filter.',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'wait_for_mission_ready',
    description:
      'Long-poll until a packet reaches an attention state or its packet/lane state changes. Reruns and packets with running/reviewing lanes remain active instead of returning already-terminal. Returns the get_mission_status payload plus `wakeReason` ("state-change" | "timeout" | "already-terminal"). Specify packetId to watch one packet. Default timeout 600000ms; cap 1800000ms.',
    inputSchema: {
      type: 'object',
      properties: {
        missionId: {
          type: 'string',
          description: 'Optional mission ID. If omitted, watches the current stored mission.',
        },
        packetId: {
          type: 'string',
          description: 'Optional packet ID. When set, returns when this specific packet hits a terminal state.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Max time to wait in ms. Default 600000 (10 min); capped at 1800000 (30 min).',
        },
        pollIntervalMs: {
          type: 'number',
          description: 'Poll interval in ms. Default 3000ms; minimum 1000ms.',
        },
      },
    },
  },
  {
    name: 'submit_review',
    description:
      'Required: packetId, findings, approved. Each finding requires file, severity (bug, rule_violation, note), description, and status (fixed, accepted, deferred). USE THIS WHEN a packet is awaiting_review and you\'ve inspected the diff (via o8_merge_preview or by reading the worktree). approved:true unlocks the F18 auto-merge path; approved:false sends the packet back to the agent with findings as feedback. Findings are relayed to downstream dependent packets. Use status for the finding enum (fixed, accepted, deferred); put free-text fix details in description or fixSuggestion. Example: submit_review({packetId: "pkt-abc", approved: false, findings: [{file: "src/foo.ts", severity: "rule_violation", description: "CSS shorthand used", status: "fixed", fixSuggestion: "Use paddingTop and paddingLeft instead."}]})',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'The packet ID being reviewed.',
        },
        findings: {
          type: 'array',
          description: 'Review findings to persist.',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              line: { type: 'number' },
              severity: { type: 'string', enum: ['bug', 'rule_violation', 'note'], description: 'bug for defects, rule_violation for policy failures, note for observations. Legacy severity aliases remain accepted.' },
              description: { type: 'string' },
              status: {
                type: 'string',
                enum: ['fixed', 'accepted', 'deferred'],
                description: 'Finding status enum. Use fixSuggestion or description for free-text fix details.',
              },
              resolution: {
                type: 'string',
                enum: ['fixed', 'accepted', 'deferred'],
                description: 'Deprecated alias for status. Do not use for free-text fix details.',
              },
              fixSuggestion: {
                type: 'string',
                description: 'Optional free-text fix narrative.',
              },
            },
            required: ['file', 'severity', 'description', 'status'],
          },
        },
        approved: {
          type: 'boolean',
          description: 'Whether the review approved the packet for merge.',
        },
        reviewedHeadSha: {
          type: 'string',
          description: 'Optional 7- to 40-character hexadecimal worktree HEAD SHA that was reviewed. Abbreviated SHAs are expanded in the packet repository; if omitted, o8 captures the lane worktree HEAD at review time.',
        },
        contractCoverageEvidence: CONTRACT_COVERAGE_EVIDENCE_SCHEMA,
        directivesApplied: {
          type: 'array',
          description: '#732 — Directives the diff RESPECTED. List the directive title or filename (as returned by get_packet_scope). Surfaces in the Packet Review Card so the operator can see governance enforcement.',
          items: { type: 'string' },
        },
        directivesViolated: {
          type: 'array',
          description: '#732 — Directives the diff CONTRADICTED. Each entry names the directive plus the offending file:line. Surfaces in the Packet Review Card as warning rows.',
          items: {
            type: 'object',
            properties: {
              directive: { type: 'string', description: 'Directive title or filename (from get_packet_scope).' },
              file: { type: 'string', description: 'Path of the file where the violation was found.' },
              line: { type: 'number', description: 'Line number of the violating change.' },
              snippet: { type: 'string', description: 'Optional one-line snippet showing the violation.' },
            },
            required: ['directive'],
          },
        },
      },
      required: ['packetId', 'findings', 'approved'],
    },
  },
  {
    name: 'reset_packet',
    description:
      'USE THIS WHEN a packet is stuck (lane status stuck in launching, session_lost, failed, recovering) or the agent produced bad output you want to wipe and try again. Archives the old lane + session AND removes the worktree dir by default. Pass clearWorktree:false to keep the worktree (rare — use retry_packet instead if you want to preserve work). Call dispatch_mission() after to re-launch. Example: reset_packet({packetId: "pkt-abc", reason: "agent timed out"})',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'The packet ID to reset.',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for the reset (e.g., "worktree lost", "agent failed").',
        },
        clearWorktree: {
          type: 'boolean',
          description: 'Also prune the old worktree directory after resetting.',
        },
      },
      required: ['packetId'],
    },
  },
  {
    name: 'retry_packet',
    description:
      'USE THIS WHEN a packet is in session_lost / failed / recovering and you want to preserve its existing worktree. If that worktree already has a clean committed result, retry_packet returns salvaged:true and moves it directly to review; do not redispatch it. Otherwise it archives the old lane + session and needs dispatch_mission() to relaunch. Pass clearWorktree:true to wipe (or use reset_packet instead). Example: retry_packet({packetId: "pkt-abc", reason: "session_lost"})',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'The packet ID to retry.',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for the retry (e.g., "worktree lost", "agent failed").',
        },
        clearWorktree: {
          type: 'boolean',
          description: 'Also prune the old worktree directory after resetting.',
        },
      },
      required: ['packetId'],
    },
  },
  {
    name: 'o8_review_state',
    description:
      'Get the canonical review state for a packet. Returns working|ready-to-merge|needs-revision|merged|failed plus the latest orchestrator review verdict and merge-gate verdict. Poll this to know when a packet is safe to approve_and_merge. Example: o8_review_state({packetId: "pkt-abc"}) returns {state, orchestratorReview, mergeGate, lane, branch}.',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'The packet ID to read state for.',
        },
      },
      required: ['packetId'],
    },
  },
  {
    name: 'report_packet_event',
    description:
      'Report structured packet progress, blockers, or questions from a worker agent. Use event:"blocked" or event:"question" to move the lane to awaiting_orchestrator; event:"progress" appends history only. Example: report_packet_event({packetId: "pkt-abc", event: "blocked", reason: "needs_clarification", message: "Which auth provider should this target?"})',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'Packet ID whose active lane should receive the report.',
        },
        event: {
          type: 'string',
          description: 'Free-form report event. blocked/question update lane status; progress only records an event.',
        },
        reason: {
          type: 'string',
          enum: [
            'needs_clarification',
            'missing_context',
            'out_of_scope',
            'dependency_blocked',
            'context_full',
            'nondeterministic_test',
            'external_api_down',
            'unknown',
          ],
          description: 'Optional codified reason for the report.',
        },
        message: {
          type: 'string',
          description: 'Optional human-readable detail.',
        },
        metadata: {
          type: 'object',
          description: 'Optional structured metadata to attach to the report.',
        },
      },
      required: ['packetId', 'event'],
    },
  },
  {
    name: 'rerun_with_feedback',
    description:
      'Re-dispatch a rejected packet with appended feedback. Use after submit_review with approved:false records findings — this tool feeds those findings back into the packet body and re-queues for dispatch. The packet keeps its lane history; Codex picks up where it left off with the corrections in scope. Example: rerun_with_feedback({packetId: "pkt-abc", feedback: "Replace webview.eval with app.emit() — security gate blocks eval."})',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'The packet ID to rerun with feedback.',
        },
        feedback: {
          type: 'string',
          description: 'Free-text feedback to append to the packet body for the next dispatch.',
        },
      },
      required: ['packetId', 'feedback'],
    },
  },
];

export async function handleDispatchMission(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const result = await dispatchMission({
      missionId: optionalString(args, 'missionId') || undefined,
      runtime: args.runtime === undefined ? undefined : parseMissionRuntime(args.runtime),
    });
    return jsonResult(result, 'error' in result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} dispatch_mission failed: ${errorText(error)}`);
    return textResult(`Failed to dispatch mission: ${errorText(error)}`, true);
  }
}

export async function handleGetMissionStatus(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const includeCost = typeof args.includeCost === 'boolean' ? args.includeCost : false;
    const includeTiming = typeof args.includeTiming === 'boolean' ? args.includeTiming : false;
    const result = await getMissionStatus({ missionId: optionalString(args, 'missionId') || undefined, includeCost, includeTiming });
    return jsonResult(result, 'error' in result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} get_mission_status failed: ${errorText(error)}`);
    return textResult(`Failed to read mission status: ${errorText(error)}`, true);
  }
}

export { handleMissionTail } from './mission-tail';

export async function handleGetPacketScope(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const packetId = optionalString(args, 'packetId') || undefined;
    const laneId = optionalString(args, 'laneId') || undefined;
    if (!packetId && !laneId) {
      return textResult('packetId or laneId is required', true);
    }

    const result = await getPacketScope({ packetId, laneId });
    if (!result) {
      return textResult('Packet scope not found', true);
    }
    return jsonResult(projectPacketScope(result, args.includeDirectives === true));
  } catch (error) {
    console.error(`${'[mcp-operator]'} get_packet_scope failed: ${errorText(error)}`);
    return textResult(`Failed to read packet scope: ${errorText(error)}`, true);
  }
}

export async function handlePacketDiff(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const packetId = optionalString(args, 'packetId') || undefined;
    const laneId = optionalString(args, 'laneId') || undefined;
    const id = laneId || packetId;
    if (!id) {
      return textResult('packetId or laneId is required', true);
    }
    const maxBytes = typeof args.maxBytes === 'number' && Number.isFinite(args.maxBytes) && args.maxBytes > 0
      ? Math.floor(args.maxBytes)
      : undefined;
    const qs = maxBytes ? `?maxBytes=${maxBytes}` : '';
    const data = await apiFetch(`/api/lanes/${encodeURIComponent(id)}/diff${qs}`, { acceptedErrorStatuses: [409] });
    return { ...jsonResult(data), isError: Boolean(data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)) };
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_packet_diff failed: ${errorText(error)}`);
    return textResult(`Failed to read packet diff: ${errorText(error)}`, true);
  }
}

export async function handleTaskCreate(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const allowedFiles = Array.isArray(args.allowedFiles)
      ? args.allowedFiles.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean)
      : null;
    const result = await createTask({
      actor: 'orchestrator',
      title: requiredString(args, 'title'),
      summary: optionalString(args, 'summary') || null,
      projectId: optionalString(args, 'projectId') || null,
      repoPath: optionalString(args, 'repoPath') || null,
      model: optionalString(args, 'model') || null,
      workerIntent: optionalString(args, 'workerIntent') || null,
      requestedProvider: optionalString(args, 'requestedProvider') || null,
      requestedRuntime: optionalString(args, 'requestedRuntime') || null,
      allowedFiles,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_task_create failed: ${errorText(error)}`);
    return textResult(`Failed to create task: ${errorText(error)}`, true);
  }
}

export async function handleTaskBrief(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const taskId = requiredString(args, 'taskId');
    const projectId = optionalString(args, 'projectId') || null;
    const repoPath = optionalString(args, 'repoPath') || null;
    const task = await getTaskPoolTask(taskId, { projectId, repoPath });
    if (!task) {
      return textResult('Task not found', true);
    }
    return jsonResult({
      schema: 'o8/task.detail/v1',
      task,
    });
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_task_brief failed: ${errorText(error)}`);
    return textResult(`Failed to read task brief: ${errorText(error)}`, true);
  }
}

export async function handleTaskClaim(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const result = await claimTask(requiredString(args, 'taskId'), {
      actor: 'orchestrator',
      note: optionalString(args, 'note') || null,
      projectId: optionalString(args, 'projectId') || null,
      repoPath: optionalString(args, 'repoPath') || null,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_task_claim failed: ${errorText(error)}`);
    return textResult(`Failed to claim task: ${errorText(error)}`, true);
  }
}

export async function handleTaskDispatch(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const result = await dispatchTask(requiredString(args, 'taskId'), {
      waitForLaunch: false,
      actor: 'orchestrator',
      message: optionalString(args, 'message') || null,
      model: optionalString(args, 'model') || null,
      workerIntent: optionalString(args, 'workerIntent') || null,
      requestedProvider: optionalString(args, 'requestedProvider') || null,
      requestedRuntime: optionalString(args, 'requestedRuntime') || null,
      projectId: optionalString(args, 'projectId') || null,
      repoPath: optionalString(args, 'repoPath') || null,
    });
    if (!result.ok) return lifecycleErrorResult('o8_task_dispatch', { code: 'task_dispatch_failed', note: result.note }, result.packetId ?? args.taskId);
    return jsonResult(result);
  } catch (error) {
    return lifecycleErrorResult('o8_task_dispatch', error, args.taskId);
  }
}

export async function handleTaskBlock(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const code = optionalString(args, 'code') || undefined;
    if (code !== undefined && !isAgentReportReason(code)) {
      throw new McpInputError('code must be one of: needs_clarification, missing_context, out_of_scope, dependency_blocked, context_full, nondeterministic_test, external_api_down, unknown.');
    }
    const result = await blockTask(requiredString(args, 'taskId'), {
      actor: 'orchestrator',
      reason: requiredString(args, 'reason'),
      code,
      projectId: optionalString(args, 'projectId') || null,
      repoPath: optionalString(args, 'repoPath') || null,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_task_block failed: ${errorText(error)}`);
    return textResult(`Failed to block task: ${errorText(error)}`, true);
  }
}

export async function handleTaskReport(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const reason = optionalString(args, 'reason') || undefined;
    if (reason !== undefined && !isAgentReportReason(reason)) {
      throw new McpInputError('reason must be one of: needs_clarification, missing_context, out_of_scope, dependency_blocked, context_full, nondeterministic_test, external_api_down, unknown.');
    }
    const metadata = args.metadata === undefined || args.metadata === null
      ? undefined
      : normalizeAgentReportMetadata(args.metadata);
    if (args.metadata !== undefined && args.metadata !== null && !metadata) {
      throw new McpInputError('metadata must be an object');
    }
    const result = await reportTask(requiredString(args, 'taskId'), {
      actor: 'orchestrator',
      event: optionalString(args, 'event') || null,
      status: optionalString(args, 'status') || null,
      reason,
      message: optionalString(args, 'message') || null,
      metadata: metadata ?? null,
      projectId: optionalString(args, 'projectId') || null,
      repoPath: optionalString(args, 'repoPath') || null,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_task_report failed: ${errorText(error)}`);
    return textResult(`Failed to report task: ${errorText(error)}`, true);
  }
}

export async function handleTaskArchive(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const result = await archiveTask(requiredString(args, 'taskId'), {
      actor: 'orchestrator',
      reason: optionalString(args, 'reason') || null,
      projectId: optionalString(args, 'projectId') || null,
      repoPath: optionalString(args, 'repoPath') || null,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_task_archive failed: ${errorText(error)}`);
    return textResult(`Failed to archive task: ${errorText(error)}`, true);
  }
}

export async function handleTaskPrune(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const result = await pruneTask(requiredString(args, 'taskId'), {
      actor: 'orchestrator',
      reason: optionalString(args, 'reason') || null,
      projectId: optionalString(args, 'projectId') || null,
      repoPath: optionalString(args, 'repoPath') || null,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_task_prune failed: ${errorText(error)}`);
    return textResult(`Failed to prune task: ${errorText(error)}`, true);
  }
}

type MissionStatusReader = (input: {
  missionId?: string;
  includeCost: boolean;
}) => Promise<MinimalMissionStatusShape | Awaited<ReturnType<typeof getMissionStatus>>>;

export async function handleWaitForMissionReady(
  args: Record<string, unknown>,
  readStatus: MissionStatusReader = getMissionStatus,
): Promise<McpToolResult> {
  const TIMEOUT_DEFAULT_MS = 10 * 60 * 1000;
  const TIMEOUT_MAX_MS = 30 * 60 * 1000;
  const POLL_DEFAULT_MS = 3000;
  const POLL_MIN_MS = 1000;

  const missionId = optionalString(args, 'missionId') || undefined;
  const packetIdFilter = optionalString(args, 'packetId') || null;
  const timeoutInput = typeof args.timeoutMs === 'number' ? args.timeoutMs : TIMEOUT_DEFAULT_MS;
  const timeoutMs = Math.max(1000, Math.min(TIMEOUT_MAX_MS, timeoutInput));
  const pollInput = typeof args.pollIntervalMs === 'number' ? args.pollIntervalMs : POLL_DEFAULT_MS;
  const pollIntervalMs = Math.max(POLL_MIN_MS, pollInput);

  try {
    const baseline = (await readStatus({ missionId, includeCost: false })) as MinimalMissionStatusShape;

    // If a terminal state already exists at baseline, return immediately so
    // the caller never blocks unnecessarily.
    const baselineTerminal = findMissionAttentionPacket(baseline, packetIdFilter);
    if (baselineTerminal) {
      return jsonResult({ ...baseline, wakeReason: 'already-terminal', terminalPacketId: baselineTerminal.id ?? null });
    }

    const baselineSig = missionPacketSignature(baseline.packets);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      // Sleep first — we just fetched baseline, no point hitting again on tick 0.
      const remaining = deadline - Date.now();
      const wait = Math.min(pollIntervalMs, Math.max(0, remaining));
      if (wait > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, wait));
      }
      if (Date.now() >= deadline) break;

      const next = (await readStatus({ missionId, includeCost: false })) as MinimalMissionStatusShape;
      const terminal = findMissionAttentionPacket(next, packetIdFilter);
      if (terminal) {
        return jsonResult({ ...next, wakeReason: 'state-change', terminalPacketId: terminal.id ?? null });
      }
      if (missionPacketSignature(next.packets) !== baselineSig) {
        return jsonResult({ ...next, wakeReason: 'state-change', terminalPacketId: null });
      }
    }

    const finalSnapshot = (await readStatus({ missionId, includeCost: false })) as MinimalMissionStatusShape;
    return jsonResult({ ...finalSnapshot, wakeReason: 'timeout', terminalPacketId: null });
  } catch (error) {
    console.error(`${'[mcp-operator]'} wait_for_mission_ready failed: ${errorText(error)}`);
    return textResult(`Failed to wait for mission: ${errorText(error)}`, true);
  }
}

export async function handleSubmitReview(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    if (typeof args.approved !== 'boolean') {
      throw new McpInputError('approved is required');
    }
    const result = await submitPacketReview({
      packetId: requiredString(args, 'packetId'),
      findings: parseReviewFindings(args.findings),
      approved: args.approved,
      reviewedHeadSha: optionalString(args, 'reviewedHeadSha') || undefined,
      contractCoverageEvidence: parseContractCoverageEvidenceInput(args.contractCoverageEvidence),
      directivesApplied: parseDirectivesApplied(args.directivesApplied),
      directivesViolated: parseDirectivesViolated(args.directivesViolated),
    });
    return 'error' in result ? textResult(JSON.stringify(result), true) : jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} submit_review failed: ${errorText(error)}`);
    return textResult(`Failed to submit review: ${errorText(error)}`, true);
  }
}

export async function handleRerunWithFeedback(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const result = await rerunWithFeedback({
      packetId: requiredString(args, 'packetId'),
      feedback: requiredString(args, 'feedback'),
    });
    return jsonResult(result, 'error' in result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} rerun_with_feedback failed: ${errorText(error)}`);
    return textResult(`Failed to rerun with feedback: ${errorText(error)}`, true);
  }
}

interface ReportLane {
  id: string;
  packetId: string | null;
}

export async function handleReportPacketEvent(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const packetId = requiredString(args, 'packetId');
    const event = normalizeAgentReportEvent(args.event);
    if (!event) {
      throw new McpInputError('event is required');
    }

    const reason = optionalString(args, 'reason') || undefined;
    if (reason !== undefined && !isAgentReportReason(reason)) {
      throw new McpInputError('reason must be one of: needs_clarification, missing_context, out_of_scope, dependency_blocked, context_full, nondeterministic_test, external_api_down, unknown.');
    }

    const lanesResult = await apiFetch('/api/lanes?active=false') as { lanes?: ReportLane[] };
    const lane = (lanesResult.lanes ?? []).find((candidate) => candidate.packetId === packetId);
    if (!lane) {
      return textResult(`No lane found for packet ${packetId}.`, true);
    }

    const metadata = args.metadata === undefined || args.metadata === null
      ? undefined
      : normalizeAgentReportMetadata(args.metadata);
    if (args.metadata !== undefined && args.metadata !== null && !metadata) {
      throw new McpInputError('metadata must be an object');
    }

    const result = await apiFetch(`/api/lanes/${encodeURIComponent(lane.id)}/events`, {
      method: 'POST',
      body: JSON.stringify({
        verb: 'agent_report',
        event,
        reason,
        message: normalizeAgentReportMessage(args.message),
        metadata,
      }),
    }) as Record<string, unknown>;

    if (result.ok === false) {
      return textResult(String(result.note ?? `Failed to report event for ${packetId}.`), true);
    }

    return jsonResult({
      summary: `Reported ${event} for ${packetId}.`,
      data: result,
    });
  } catch (error) {
    console.error(`${'[mcp-operator]'} report_packet_event failed: ${errorText(error)}`);
    return textResult(`Failed to report packet event: ${errorText(error)}`, true);
  }
}

export async function handleReviewState(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const packetId = requiredString(args, 'packetId');
    const result = await apiFetch(`/api/orchestrator/review-state?packetId=${encodeURIComponent(packetId)}`);
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_review_state failed: ${errorText(error)}`);
    return textResult(`Failed to read review state: ${errorText(error)}`, true);
  }
}
