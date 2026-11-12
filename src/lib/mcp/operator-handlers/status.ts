import { RuntimeOwnerUnconfirmedError, withToolRuntimeOwner } from '@/lib/runtime/owner-context';
import { errorText } from '@/lib/mcp/operator-handlers/shared';
import { lifecycleErrorResult } from './lifecycle-error';
import {
  type McpTool,
  type McpToolResult,
  apiFetch,
  apiFetchCorrelatedMutation,
  jsonResult,
  requiredString,
  textResult,
} from './shared';
import { listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import { readStatusSnapshot } from './status-snapshot';
import { projectOperatorDefaults, projectStatusAgent } from '@/lib/mcp/operator-handlers/response-projections';

const LANE_EVENTS_MAX_LONG_POLL_MS = 12_000;
const LANE_EVENTS_FETCH_MARGIN_MS = 2_500;
async function steerSession(sessionKey: string, message: string): Promise<Record<string, unknown>> {
  const result = await apiFetchCorrelatedMutation<Record<string, unknown>>(
    '/api/runtime/action',
    { action: 'steer', surfaceId: sessionKey, message },
    'clientMutationId',
  );
  return result;
}

export const STATUS_TOOLS: McpTool[] = [
  {
    name: 'o8_send',
    description:
      'USE THIS WHEN the user wants you to delegate work to a background coding agent in o8 (phrasings like "have an agent fix this", "kick off a task in o8", "send this to my fleet") OR to nudge an existing session ("tell the agent to also..."). Don\'t try to do the coding yourself — o8 spawns Codex/Claude/Gemini in a worktree and handles review + merge. Example: o8_send({message: "Fix the login bug in auth.ts", repoPath: "/path/to/repo"}) launches a new agent. o8_send({message: "Also update the tests", sessionKey: "codex-owned:abc123"}) steers an existing one.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The task prompt or follow-up message to send.',
        },
        sessionKey: {
          type: 'string',
          description: 'If provided, steers an existing session instead of launching a new one.',
        },
        repoPath: {
          type: 'string',
          description: 'Absolute path to the repo for a new task. Ignored when steering.',
        },
        taskName: {
          type: 'string',
          description: 'Short human-readable name for a new task. Ignored when steering.',
        },
        readOnly: {
          type: 'boolean',
          description: 'Set true when the new task should inspect and report without changing files.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'o8_status',
    description:
      'USE THIS WHEN the user asks "what\'s running", "any approvals waiting", "show me my agents", or about pending agent work. Returns a composite overview: running agents, pending approvals, recent activity, and runtime connection evidence with sources and check times. Agent status includes authority, observation time and evidence count; includeEvidence opts into full evidence arrays. Includes snapshot capture time and age; revalidates after 5 seconds and waits for refresh at 15 seconds. Pass fresh: true to wait for a refresh explicitly. Call this FIRST before assuming nothing is happening. Example: o8_status() returns all agents. o8_status({sessionKey: "codex-owned:abc123"}) filters to one session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionKey: {
          type: 'string',
          description: 'Filter to a specific session. Returns all if omitted.',
        },
        fresh: {
          type: 'boolean',
          description: 'Wait for a coalesced refresh instead of using the bounded snapshot. May take longer.',
        },
        includeEvidence: { type: 'boolean', description: 'Include full agent status evidence arrays. Default false.' },
      },
    },
  },
  {
    name: 'steer_packet',
    description:
      'Use steer_packet when you want to nudge a parked Codex session with new info, such as typecheck failed and here is the output. Codex warm thread state means this is ~1 turn cost versus rerun_with_feedback, which creates a full new worker. Use rerun_with_feedback when the prior session is gone, or when you need a fresh worker to retry from scratch.',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'Packet id for the parked session to steer.',
        },
        message: {
          type: 'string',
          description: 'Follow-up instruction to append to the existing Codex session.',
        },
      },
      required: ['packetId', 'message'],
    },
  },
  {
    name: 'o8_history',
    description:
      'USE THIS WHEN the user asks "what did the agent do", "show me the conversation", or you need to inspect an in-progress agent\'s reasoning before deciding to interrupt or steer it. Reads the recent transcript of an agent session. Returns the last N messages (default 15). Example: o8_history({sessionKey: "codex-owned:abc123", limit: 30})',
    inputSchema: {
      type: 'object',
      properties: {
        sessionKey: {
          type: 'string',
          description: 'The session key to read the transcript for.',
        },
        limit: {
          type: 'number',
          description: 'Number of transcript entries to return. Default 15.',
        },
      },
      required: ['sessionKey'],
    },
  },
  {
    name: 'o8_lane_events',
    description:
      'Stream lane lifecycle events. Pass `since` cursor from the previous response to long-poll for new events. Returns events in chronological order and a durable terminalReasons snapshot (latest 50, terminalReasonsTruncated when capped), including failures before a session exists. Filter lanes to retrieve older reasons. Blocks up to `timeoutMs` (default 5000, max 12000) waiting for new events when the buffer is empty. Example: o8_lane_events() returns the current buffer. o8_lane_events({since: 47, timeoutMs: 8000}) long-polls for events newer than seq 47.',
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'number',
          description: 'Event sequence cursor from previous response. Omit on first call.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Max ms to wait for new events. Default 5000, max 12000.',
        },
        lanes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional filter to specific lane ids.',
        },
      },
    },
  },
  {
    name: 'o8_packet_transcript',
    description:
      'Returns terminalReason code and cause even when no session exists. Read a paginated tail of a packet\'s codex transcript with normalized events (tool_call / tool_result / assistant / error / done). Pass `tail: true` for the last N events, or `cursor: N` to fetch events with seq > N. Example: o8_packet_transcript({packetId: "P1", tail: true, limit: 20}) returns the last 20 events. o8_packet_transcript({packetId: "P1", cursor: 47}) returns events after seq 47.',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'Packet id to read the transcript for.',
        },
        cursor: {
          type: 'number',
          description: 'Return events with seq > cursor. Ignored when tail is true.',
        },
        tail: {
          type: 'boolean',
          description: 'If true, return the last `limit` events instead of paginating by cursor.',
        },
        limit: {
          type: 'number',
          description: 'Max events to return. Default 50, max 200.',
        },
      },
      required: ['packetId'],
    },
  },
  {
    name: 'o8_operator_defaults',
    description:
      'Read or set global operator-panel defaults. Returns all values and their sources; includeReceipts, includeAuth and includeDetails opt into routing receipts, CLI auth and other diagnostics respectively. Settings persist across missions: read first, change what you need, restore prior values after a temporary change. Example: o8_operator_defaults({orchestratorModel: "claude-sonnet-5", thinkingEffort: "high"}).',
    inputSchema: {
      type: 'object',
      properties: {
        includeReceipts: { type: 'boolean', description: 'Include recent role routing receipts. Default false.' },
        includeAuth: { type: 'boolean', description: 'Include CLI authentication diagnostics. Default false.' },
        includeDetails: { type: 'boolean', description: 'Include settings TOML, role routes and other diagnostics. Default false.' },
        orchestratorModel: {
          type: 'string',
          description: 'Orchestrator model id, e.g. "claude-opus-4-8" or "claude-sonnet-5". Non-empty string.',
        },
        subscriptionProfile: {
          type: 'string',
          enum: ['both', 'claude-only', 'codex-only'],
          description: 'Which authenticated subscription houses o8 may use for orchestration, workers, and Engineering Brain calls.',
        },
        orchestratorBackend: {
          type: 'string',
          enum: ['auto', 'codex', 'claude', 'openclaw', 'hermes', 'collide', 'fable', 'opencode'],
          description: 'Active in-app orchestrator backend. Use "codex" for Codex GPT-6 Astra, "claude" for Claude Code, or "auto" for legacy toggle resolution.',
        },
        collideAggregator: {
          type: 'string',
          enum: ['auto', 'claude', 'codex'],
          description: 'Collide aggregator override. "auto" follows the active composer backend; "claude" or "codex" force the synthesizer.',
        },
        thinkingEffort: {
          type: 'string',
          enum: ['adaptive', 'low', 'medium', 'high', 'max', 'xhigh'],
          description: 'Orchestrator thinking-effort level.',
        },
        codexWorkerEffort: {
          type: 'string',
          enum: ['adaptive', 'low', 'medium', 'high', 'max', 'xhigh'],
          description: 'Thinking-effort level for Codex packet workers.',
        },
        brainCodexModel: {
          type: 'string',
          enum: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.5'],
          description: 'Codex subscription model used for Engineering Brain classification and cited answers.',
        },
        brainCodexEffort: {
          type: 'string',
          enum: ['adaptive', 'low', 'medium', 'high', 'max', 'xhigh'],
          description: 'Codex reasoning effort used only by Engineering Brain calls.',
        },
        broadcastCommentary: {
          type: 'string',
          enum: ['off', 'interval'],
          description: 'Whether Mister posts bounded interval commentary to Broadcast.',
        },
        broadcastCommentaryIntervalMinutes: {
          type: 'number',
          description: 'Minimum minutes between director commentary turns. Default 4.',
        },
        broadcastCommentaryMinNewEvents: {
          type: 'number',
          description: 'Minimum new feed events required for a commentary turn. Default 3.',
        },
        broadcastCommentaryMaxPerHour: {
          type: 'number',
          description: 'Maximum director commentary turns in one hour. Default 12.',
        },
        broadcastVoice: {
          type: 'string',
          enum: ['off', 'on'],
          description: 'Whether Symon speaks new Broadcast commentary. Default off.',
        },
        broadcastVoiceLullMinutes: {
          type: 'number',
          description: 'Quiet minutes before Symon speaks one focus-aware lull line. Default 6.',
        },
        broadcastVoiceQuietHours: {
          type: 'string',
          enum: ['off', 'on'],
          description: 'Whether automatic Symon callouts observe the configured local quiet window.',
        },
        broadcastVoiceQuietStart: {
          type: 'string',
          description: 'Quiet-window start in local HH:MM time.',
        },
        broadcastVoiceQuietEnd: {
          type: 'string',
          description: 'Quiet-window end in local HH:MM time.',
        },
        broadcastVoiceAttention: { type: 'boolean', description: 'Speak when current work needs operator input.' },
        broadcastVoiceApprovals: { type: 'boolean', description: 'Speak while a new approval is still pending.' },
        broadcastVoiceReviews: { type: 'boolean', description: 'Speak review verdicts.' },
        broadcastVoiceFailures: { type: 'boolean', description: 'Speak packet failures, lease timeouts, and spend limits.' },
        broadcastVoiceCompletions: { type: 'boolean', description: 'Speak packet completions and merges.' },
        broadcastVoiceCalendar: { type: 'boolean', description: 'Speak imminent timed Calendar events when access is already granted.' },
        broadcastVoiceCalendarLeadMinutes: { type: 'number', description: 'Minutes before a Calendar event becomes eligible for one callout.' },
        broadcastVoiceTimeCheckins: { type: 'boolean', description: 'Speak one focus-aware update after a quiet-work interval.' },
        presentationQuietMode: {
          type: 'boolean',
          description: 'Presentation (quiet) mode. While on, overlay windows, coach cards, non-critical status pills and toasts, and native review notifications all stay down. Approvals and errors still show.',
        },
        notificationsReviewReady: {
          type: 'string',
          enum: ['off', 'on'],
          description: 'Native "ready for review" desktop banner. Quiet mode forces this off while it is active.',
        },
        claudeWorkerEffort: {
          type: 'string',
          enum: ['adaptive', 'low', 'medium', 'high', 'max', 'xhigh'],
          description: 'Thinking-effort level for Claude Code packet workers.',
        },
        overlapGate: {
          type: 'string',
          enum: ['advisory', 'strict'],
          description: 'Overlap gate mode for parallel packets touching the same files.',
        },
        parallelCap: {
          type: 'number',
          description: 'Max packets running in parallel (positive safe integer).',
        },
        meteredPacketCostCapUsd: {
          type: 'number',
          description: 'Maximum authoritative gateway spend in USD for one metered packet. Default 1.',
        },
        meteredPacketInputTokenCap: {
          type: 'number',
          description: 'Fallback input-token cap when a metered gateway does not report cost. Default 500000.',
        },
        uiLoopMaxIterations: {
          type: 'number',
          description: 'Maximum follow-up Design Mode steers per packet. Default 8.',
        },
        uiLoopMaxMinutes: {
          type: 'number',
          description: 'Maximum wall minutes from the first Design Mode turn. Default 30.',
        },
        uiLoopMaxDiffBytes: {
          type: 'number',
          description: 'Maximum current packet diff bytes before the UI loop parks. Default 65536.',
        },
        uiLoopMaxDiffFiles: {
          type: 'number',
          description: 'Maximum current packet diff files before the UI loop parks. Default 12.',
        },
        uiLoopPreviewTimeoutMs: {
          type: 'number',
          description: 'Preview-ready wait timeout in milliseconds. Default 20000.',
        },
        defaultDispatchRuntime: {
          type: 'string',
          enum: listDispatchableRuntimes(),
          description: 'Default worker runtime for dispatches.',
        },
        workerExecutionCarrier: {
          type: 'string',
          enum: ['ori', ''],
          description: 'Allowlisted worker execution carrier. Use "ori" for Ori or an empty string for direct runtime launch.',
        },
        defaultDispatchModel: {
          type: 'string',
          description: 'Default worker model id. Pass an empty string to restore the selected runtime default.',
        },
        opencodeOrchestratorModel: {
          type: 'string',
          description: 'Pinned OpenCode 2 orchestrator model id, e.g. "openrouter/deepseek/deepseek-v4-flash". Pass an empty string to clear the pin.',
        },
        opencodeWorkerModel: {
          type: 'string',
          description: 'Pinned OpenCode 2 worker model id. Pass an empty string to clear the pin.',
        },
        workersUseBrain: {
          type: 'string',
          enum: ['off', 'auto', 'all'],
          description: 'Whether packet workers are taught to consult the Engineering Brain.',
        },
        workspaceManifestPolicy: {
          type: 'string',
          enum: ['disabled', 'one-approval', 'auto'],
          description: 'Whether checked-in workspace manifest commands are disabled, approved once per hash, or automatic.',
        },
        brainUseClaudeCli: {
          type: 'boolean',
          description: 'Allow Engineering Brain to use the Claude subscription when the subscription profile permits it.',
        },
        brainWarmupEnabled: {
          type: 'boolean',
          description: 'Speculatively pre-spawn the selected Brain CLI before an ask needs it. Off disables only that pre-spawn; an explicit ask still launches its runtime when needed and may wait longer.',
        },
        crossHouseWorkerFallback: {
          type: 'boolean',
          description: 'Automatically redispatch quota-capped workers on the equal-tier runtime from the other subscription house.',
        },
        healBotEnabled: {
          type: 'boolean',
          description: 'Enable the heal bot for stuck packets.',
        },
        supervisorAutoEscalate: {
          type: 'boolean',
          description: 'Auto-escalate stuck packets to the supervisor.',
        },
        promptCachingEnabled: {
          type: 'boolean',
          description: 'Enable prompt caching for orchestrator sessions.',
        },
        requireApproval: {
          type: 'string',
          enum: ['high-risk', 'surface', 'always', 'never'],
          description: 'Human approval posture for lane merges. "surface" keeps easy reviewed merges moving and routes review-worthy work to its dispatcher; "high-risk" preserves the default behavior; "always" gates every merge; "never" enables normal full autonomy.',
        },
      },
    },
  },
];

const OPERATOR_DEFAULTS_KEYS = [
  'subscriptionProfile',
  'orchestratorModel',
  'orchestratorBackend',
  'collideAggregator',
  'thinkingEffort',
  'codexWorkerEffort',
  'claudeWorkerEffort',
  'brainCodexModel',
  'brainCodexEffort',
  'broadcastCommentary',
  'broadcastCommentaryIntervalMinutes',
  'broadcastCommentaryMinNewEvents',
  'broadcastCommentaryMaxPerHour',
  'broadcastVoice',
  'broadcastVoiceLullMinutes',
  'broadcastVoiceQuietHours',
  'broadcastVoiceQuietStart',
  'broadcastVoiceQuietEnd',
  'broadcastVoiceAttention',
  'broadcastVoiceApprovals',
  'broadcastVoiceReviews',
  'broadcastVoiceFailures',
  'broadcastVoiceCompletions',
  'broadcastVoiceCalendar',
  'broadcastVoiceCalendarLeadMinutes',
  'broadcastVoiceTimeCheckins',
  'presentationQuietMode',
  'notificationsReviewReady',
  'overlapGate',
  'parallelCap',
  'meteredPacketCostCapUsd',
  'meteredPacketInputTokenCap',
  'uiLoopMaxIterations',
  'uiLoopMaxMinutes',
  'uiLoopMaxDiffBytes',
  'uiLoopMaxDiffFiles',
  'uiLoopPreviewTimeoutMs',
  'defaultDispatchRuntime',
  'workerExecutionCarrier',
  'defaultDispatchModel',
  'opencodeOrchestratorModel',
  'opencodeWorkerModel',
  'workersUseBrain',
  'workspaceManifestPolicy',
  'brainUseClaudeCli',
  'brainWarmupEnabled',
  'crossHouseWorkerFallback',
  'healBotEnabled',
  'supervisorAutoEscalate',
  'promptCachingEnabled',
  'requireApproval',
] as const;

export async function handleOperatorDefaults(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const supportedKeys = new Set<string>([...OPERATOR_DEFAULTS_KEYS, 'includeReceipts', 'includeAuth', 'includeDetails']);
    const unknownKeys = Object.keys(args)
      .filter((key) => !supportedKeys.has(key))
      .sort();
    if (unknownKeys.length > 0) {
      return {
        ...jsonResult({
          ok: false,
          error: {
            code: 'unknown_operator_default_keys',
            message: `Unsupported o8_operator_defaults key${unknownKeys.length === 1 ? '' : 's'}: ${unknownKeys.join(', ')}`,
            unknownKeys,
            supportedKeys: [...supportedKeys],
          },
        }),
        isError: true,
      };
    }
    const update: Record<string, unknown> = {};
    for (const key of OPERATOR_DEFAULTS_KEYS) {
      if (args[key] !== undefined) update[key] = args[key];
    }
    const EMPTY_STRING_MEANS_NULL = new Set(['opencodeOrchestratorModel', 'opencodeWorkerModel', 'workerExecutionCarrier']);
    for (const key of EMPTY_STRING_MEANS_NULL) {
      if (update[key] === '') update[key] = null;
    }
    const data = Object.keys(update).length === 0
      ? await apiFetch('/api/panel/operator-defaults')
      : await apiFetch('/api/panel/operator-defaults', {
          method: 'POST',
          body: JSON.stringify(update),
        });
    if (data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)) {
      return textResult(`o8_operator_defaults failed: ${(data as Record<string, unknown>).error}`, true);
    }
    return jsonResult(projectOperatorDefaults(data, args));
  } catch (err) {
    console.error(`[o8-operator] o8_operator_defaults failed: `, err);
    return textResult(`Failed to read/update operator defaults: ${errorText(err)}`, true);
  }
}

export async function handleSend(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const message = args.message as string;
    if (!message) return textResult('message is required', true);

    const sessionKey = args.sessionKey as string | undefined;
    let result: Record<string, unknown>;

    if (sessionKey) {
      // Steer existing session
      result = await withToolRuntimeOwner(() => steerSession(sessionKey, message));
    } else {
      // Launch new task via orchestrator
      result = await withToolRuntimeOwner(() => apiFetchCorrelatedMutation<Record<string, unknown>>(
        '/api/orchestrator/delegate',
        {
          prompt: message,
          repoPath: args.repoPath || undefined,
          taskName: args.taskName || undefined,
          readOnly: args.readOnly === true,
        },
        'clientMutationId',
      ));
    }

    if (result.ok === false) {
      // Don't synthesize a "Launched agent…" summary when the backend said no.
      const reason = (result.error as string) || (result.note as string) || 'unknown error';
      return textResult(`Failed to launch agent: ${reason}`, true);
    }

    let status: Record<string, unknown> = {};
    try {
      status = await apiFetch('/api/operator/status') as Record<string, unknown>;
    } catch {
      // Best-effort — endpoint may not exist yet
    }

    const laneId = result.laneId as string | undefined;
    const key = sessionKey || (result.surfaceId as string) || (result.sessionKey as string) || 'unknown';
    const currentStatus = (status.status as string) || (result.status as string) || 'launched';
    const repo = (args.repoPath as string) || (result.repoPath as string) || 'default';

    return jsonResult({
      summary: `Launched agent on ${repo}, session ${key}, status: ${currentStatus}`,
      data: {
        ok: result.ok ?? true,
        laneId: laneId ?? null,
        sessionKey: key,
        status: currentStatus,
      },
    });
  } catch (err) {
    if (err instanceof RuntimeOwnerUnconfirmedError) {
      return jsonResult({ ok: false, code: err.code, message: err.message, state: 'unknown',
        sessionKey: typeof args.sessionKey === 'string' ? args.sessionKey : null,
        next: 'Inspect the session in o8 before retrying. Do not resend automatically.' }, true);
    }
    console.error(`[o8-operator] o8_send failed: `, err);
    return textResult(`Failed to send: ${errorText(err)}`, true);
  }
}

export async function handleSteerPacket(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const packetId = requiredString(args, 'packetId');
    const message = requiredString(args, 'message');
    // #2 Stage 4: route through /api/orchestrator/steer-packet so the lane
    // resolution + status flip run in the Next process (the live registry +
    // warm-session pool), not this MCP process's stale registry instance.
    const res = await withToolRuntimeOwner(() => apiFetchCorrelatedMutation<{
      ok?: boolean;
      result?: Record<string, unknown>;
    }>(
      '/api/orchestrator/steer-packet',
      { packetId, message, source: 'orchestrator' },
      'idempotencyKey',
    ));
    return jsonResult({ ok: true, ...(res.result ?? {}) });
  } catch (err) {
    return lifecycleErrorResult('steer_packet', err, args.packetId);
  }
}

export async function handleStatus(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    if (args.fresh !== undefined && typeof args.fresh !== 'boolean') {
      return textResult('fresh must be a boolean', true);
    }
    const sessionKey = args.sessionKey as string | undefined;
    const { data, runtimeConnections, snapshot } = await readStatusSnapshot(sessionKey, args.fresh === true);

    const agents = (data.agents ?? []) as Array<Record<string, unknown>>;
    const rawApprovals = data.approvals as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
    const approvalItems = Array.isArray(rawApprovals)
      ? rawApprovals
      : Array.isArray((rawApprovals as Record<string, unknown>)?.items)
        ? ((rawApprovals as Record<string, unknown>).items as Array<Record<string, unknown>>)
        : [];
    const approvalCount = typeof (rawApprovals as Record<string, unknown>)?.count === 'number'
      ? (rawApprovals as Record<string, unknown>).count as number
      : approvalItems.length;
    const recentActivity = (data.recentActivity ?? []) as Array<Record<string, unknown>>;
    const spendCapHits = (data.spendCapHits ?? []) as Array<Record<string, unknown>>;

    // #1476 lie 1 — the summary must be derived from the SAME agents array
    // this payload ships. Trusting the API's summary string let the two
    // answers drift ("0 agents running" beside agents[]={failed}); one
    // derivation, one truth.
    const { summarizeOperatorStatus } = await import('@/lib/orchestrator/operator-status-model');
    const summary = summarizeOperatorStatus({
      agents: agents as unknown as Parameters<typeof summarizeOperatorStatus>[0]['agents'],
      approvalCount,
      recentActivity,
    });

    return jsonResult({
      summary,
      data: {
        runtimeConnections,
        snapshot,
        agents: agents.map((agent) => projectStatusAgent(agent, args.includeEvidence === true)),
        approvals: approvalItems,
        approvalCount,
        recentActivity,
        spendCapHits,
        terminalReasons: data.terminalReasons ?? [],
        terminalReasonsTruncated: data.terminalReasonsTruncated === true,
      },
    });
  } catch (err) {
    console.error(`[o8-operator] o8_status failed: `, err);
    return textResult(`Failed to fetch status: ${errorText(err)}`, true);
  }
}

export async function handleHistory(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const sessionKey = args.sessionKey as string;
    if (!sessionKey) return textResult('sessionKey is required', true);

    const limit = (args.limit as number) || 15;
    const qs = `?sessionKey=${encodeURIComponent(sessionKey)}&limit=${limit}`;
    const data = await apiFetch(`/api/runtime/transcript${qs}`) as Record<string, unknown>;
    const transcript = (data.transcript ?? []) as Array<Record<string, unknown>>;

    // Truncate entries to 300 chars each
    const entries = transcript.map((e) => ({
      role: e.role,
      text: typeof e.text === 'string' && e.text.length > 300 ? e.text.slice(0, 300) + '...' : e.text,
      tool: e.toolName ?? null,
      time: e.timestampLabel,
    }));

    const lastAction = entries.length > 0
      ? (entries[entries.length - 1].tool as string) || (entries[entries.length - 1].role as string) || 'unknown'
      : 'none';

    return jsonResult({
      summary: `${entries.length} entries. Last action: ${lastAction}`,
      data: { entryCount: entries.length, transcript: entries },
    });
  } catch (err) {
    console.error(`[o8-operator] o8_history failed: `, err);
    return textResult(`Failed to read history: ${errorText(err)}`, true);
  }
}

export async function handleLaneEvents(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const sinceRaw = args.since;
    const since = typeof sinceRaw === 'number' && Number.isFinite(sinceRaw) && sinceRaw >= 0
      ? Math.floor(sinceRaw)
      : 0;

    const timeoutRaw = args.timeoutMs;
    const requestedTimeoutMs = typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw >= 0
      ? Math.floor(timeoutRaw)
      : 5_000;
    const timeoutMs = Math.min(requestedTimeoutMs, LANE_EVENTS_MAX_LONG_POLL_MS);

    const laneFilterRaw = args.lanes;
    const laneFilter = Array.isArray(laneFilterRaw)
      ? laneFilterRaw
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0)
      : [];

    const qs = new URLSearchParams();
    qs.set('since', String(since));
    qs.set('timeoutMs', String(timeoutMs));
    if (laneFilter.length > 0) qs.set('lanes', laneFilter.join(','));

    const data = await apiFetch(`/api/orchestrator/lane-events?${qs.toString()}`, {
      timeoutMs: timeoutMs + LANE_EVENTS_FETCH_MARGIN_MS,
    }) as Record<string, unknown>;
    const events = Array.isArray(data.events) ? data.events as Array<Record<string, unknown>> : [];
    const nextSinceRaw = data.nextSince;
    const nextSince = typeof nextSinceRaw === 'number' && Number.isFinite(nextSinceRaw)
      ? nextSinceRaw
      : since;

    const summary = events.length === 0
      ? `No new lane events (nextSince: ${nextSince})`
      : `${events.length} lane events (nextSince: ${nextSince})`;

    return jsonResult({
      summary,
      data: {
        events,
        nextSince,
        terminalReasons: data.terminalReasons ?? [],
        terminalReasonsTruncated: data.terminalReasonsTruncated === true,
        timeoutMs,
        ...(requestedTimeoutMs > timeoutMs ? { requestedTimeoutMs } : {}),
      },
    });
  } catch (err) {
    console.error(`[o8-operator] o8_lane_events failed: `, err);
    return textResult(`Failed to read lane events: ${errorText(err)}`, true);
  }
}

// Cap any oversized string field on a transcript event so a single large
// tool_result payload can't flood the caller's context. The route bounds the
// response window to 200 events; this bounds per-event size.
const PER_EVENT_TEXT_CAP = 2000;
function capTranscriptEvent(event: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    out[key] = typeof value === 'string' && value.length > PER_EVENT_TEXT_CAP
      ? `${value.slice(0, PER_EVENT_TEXT_CAP)}…[+${value.length - PER_EVENT_TEXT_CAP} chars truncated]`
      : value;
  }
  return out;
}

export async function handleTranscript(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const packetIdRaw = args.packetId;
    const packetId = typeof packetIdRaw === 'string' ? packetIdRaw.trim() : '';
    if (!packetId) return textResult('packetId is required', true);

    const cursorRaw = args.cursor;
    const cursor = typeof cursorRaw === 'number' && Number.isFinite(cursorRaw) && cursorRaw >= 0
      ? Math.floor(cursorRaw)
      : undefined;

    const tailRaw = args.tail;
    const tail = tailRaw === true || tailRaw === 'true' || tailRaw === 1;

    const limitRaw = args.limit;
    const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(200, Math.floor(limitRaw))
      : undefined;

    const qs = new URLSearchParams();
    qs.set('packetId', packetId);
    qs.set('history', 'complete');
    if (tail) qs.set('tail', 'true');
    if (cursor !== undefined) qs.set('cursor', String(cursor));
    if (limit !== undefined) qs.set('limit', String(limit));

    const data = await apiFetch(`/api/orchestrator/packet-transcript?${qs.toString()}`) as Record<string, unknown>;
    const events = (Array.isArray(data.events) ? data.events as Array<Record<string, unknown>> : []).map(capTranscriptEvent);
    const nextCursorRaw = data.nextCursor;
    const nextCursor = typeof nextCursorRaw === 'number' && Number.isFinite(nextCursorRaw)
      ? nextCursorRaw
      : null;
    const reason = data.terminalReason as { code?: string; cause?: string } | null;
    const note = typeof data.note === 'string' ? data.note : '';

    const summary = events.length === 0
      ? (note ? `No events (${note})` : `No transcript events for ${packetId}`)
      : `${events.length} transcript events (nextCursor: ${nextCursor ?? 'null'})`;

    return jsonResult({
      summary: reason ? `${summary}: ${reason.code}${reason.cause ? `: ${reason.cause}` : ''}` : summary,
      data: {
        packetId,
        sessionKey: data.sessionKey ?? null,
        events,
        nextCursor,
        note: note || null,
        terminalReason: reason ?? null,
      },
    });
  } catch (err) {
    console.error(`[o8-operator] o8_packet_transcript failed: `, err);
    return textResult(`Failed to read packet transcript: ${errorText(err)}`, true);
  }
}
