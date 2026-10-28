import { apiError, safeErrorText } from '@/lib/mcp/api-error';
import { sharedCheckoutControlFailure } from '@/lib/mcp/shared-checkout-control-error';
import { DEFAULT_WS_PORT } from '@/lib/panel/api-port';
import { pollCorrelatedMcpApiMutation } from '@/lib/mcp/correlated-mutation';
import { finishSharedCheckoutTeam, inspectSharedCheckoutTeam, reconcileSharedCheckoutTeam } from '@/lib/orchestrator/shared-checkout-team';
import { findOwnedLaunchByMutationId, lookupOwnedActiveRunFresh } from '@/lib/runtimes/shared/owned-session-index';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function textResult(message: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: message }], ...(isError ? { isError: true } : {}) };
}

function jsonResult(value: unknown): ToolResult {
  return textResult(JSON.stringify(value));
}

export function createCortexDelegationHandlers(config: {
  apiFetch: (path: string, options?: RequestInit) => Promise<unknown>;
  apiBase: string;
  repoPath: string;
  parentThreadId: string;
  fastCapability: string;
  wsToken: string;
}) {
  const handleLaunchAgent = async (args: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (!prompt) return textResult('prompt is required', true);
      const repoPath = typeof args.repoPath === 'string' && args.repoPath.trim()
        ? args.repoPath.trim() : config.repoPath;
      if (!repoPath) return textResult('repoPath is required (not available from env either)', true);
      const checkoutMode = args.checkoutMode === 'shared' ? 'shared' : 'isolated';
      if (checkoutMode === 'shared' && !config.parentThreadId) {
        return textResult('Shared mode needs a persisted orchestrator chat. Open this conversation in an o8 workspace first.', true);
      }
      if (checkoutMode === 'shared' && repoPath !== config.repoPath) {
        return textResult('Shared mode workers must use this orchestrator workspace checkout.', true);
      }
      const result = await pollCorrelatedMcpApiMutation<Record<string, unknown>>({
        url: `${config.apiBase}/api/orchestrator/delegate`,
        authorization: `Bearer ${config.wsToken}`,
        parseError: (response, payload) => apiError('/api/orchestrator/delegate', response.status, JSON.stringify(payload)),
        correlationField: 'clientMutationId',
        body: {
          prompt,
          repoPath,
          taskName: args.taskName || undefined,
          isolate: args.isolate !== false,
          checkoutMode,
          ...(config.parentThreadId ? { parentThreadId: config.parentThreadId } : {}),
          requestedEffort: args.requestedEffort,
          thinkingEffort: args.thinkingEffort,
          ...(checkoutMode === 'shared' ? {
            parentThreadId: config.parentThreadId,
            fastCapability: config.fastCapability,
            assignedPaths: args.assignedPaths,
          } : {}),
          runtime: args.runtime || undefined,
          model: args.model || undefined,
          workerIntent: args.workerIntent || undefined,
          readOnly: args.readOnly === true,
          ...(args.reviewPullRequest !== undefined ? { reviewPullRequest: args.reviewPullRequest } : {}),
        },
      });
      if (result.approvalId) return jsonResult({
        ok: false,
        laneId: result.laneId,
        approvalId: result.approvalId,
        note: result.note ?? 'Approval required before this agent can be launched.',
        status: 'awaiting_approval',
      });
      if (!result.ok) return textResult(`Delegation failed: ${safeErrorText(result)}`, true);

      const surfaceId = result.surfaceId as string;
      try {
        const wsPort = process.env.O8_WS_PORT || process.env.WS_PORT || String(DEFAULT_WS_PORT);
        await fetch(`http://127.0.0.1:${wsPort}/supervisor/watch`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.wsToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            surfaceId,
            repoPath,
            laneId: result.laneId,
            name: (args.taskName as string) || prompt.slice(0, 60),
            prompt,
            ...(result.launchContext ? { launchContext: result.launchContext } : {}),
          }),
          signal: AbortSignal.timeout(3_000),
        });
      } catch {
        // Launch succeeds even when the optional supervisor is unavailable.
      }
      return jsonResult({
        ok: true,
        laneId: result.laneId,
        surfaceId,
        branch: result.branch,
        worktreePath: result.worktreePath ?? null,
        teamId: result.teamId ?? null,
        checkoutMode: result.checkoutMode ?? 'isolated',
        workerRouting: result.workerRouting ?? null,
        reviewSource: result.reviewSource ?? null,
        note: result.note,
      });
    } catch (error) {
      return textResult(`Failed to launch agent: ${safeErrorText(error)}`, true);
    }
  };

  const handleWorkerCatalog = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const params = new URLSearchParams({ repoPath: config.repoPath });
    if (typeof args.runtime === 'string' && args.runtime) params.set('runtime', args.runtime);
    const call = 'GET /api/orchestrator/delegate';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let status: number | null = null;
      let failure: string;
      try {
        const response = await fetch(`${config.apiBase}/api/orchestrator/delegate?${params}`, {
          headers: { Authorization: `Bearer ${config.wsToken}` }, signal: AbortSignal.timeout(45_000),
        });
        status = response.status;
        if (status >= 400 && status < 500) {
          // A rejected request is final even when its body is not JSON.
          const body = await response.text().catch(() => '');
          let payload;
          try { payload = JSON.parse(body); }
          catch { payload = { error: body }; }
          const step = typeof payload?.step === 'string' ? `; step ${payload.step}` : '';
          return textResult(`${call} failed (HTTP ${status}${step}): ${safeErrorText(payload)}`, true);
        }
        const payload = await response.json();
        if (response.ok) return jsonResult(payload);
        const step = typeof payload?.step === 'string' ? `; step ${payload.step}` : '';
        failure = `${call} failed (HTTP ${status}${step}): ${safeErrorText(payload)}`;
        if (status < 500) return textResult(failure, true);
      } catch (error) {
        failure = `${call} failed (${status === null ? 'network; no HTTP response' : `HTTP ${status}`}): ${safeErrorText(error)}`;
      }
      if (attempt === 3) return textResult(`${failure} Stopped after 3 attempts. Retry the catalog read when the service recovers; no worker was started.`, true);
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    }
    return textResult(`${call} unavailable. Retry the catalog read; no worker was started.`, true);
  };

  const handleSharedTeamStatus = async (): Promise<ToolResult> => {
    if (!config.repoPath || !config.parentThreadId) {
      return textResult('This tool requires a persisted o8 orchestrator chat.', true);
    }
    try {
      const status = inspectSharedCheckoutTeam({ repoPath: config.repoPath, parentThreadId: config.parentThreadId });
      if (!status) return jsonResult({ team: null, note: 'No Shared workers have been launched from this chat.' });
      const memberOutcomes = await Promise.all(status.team.members.map(async (member) => {
        if (!member.surfaceId) return { taskName: member.taskName, surfaceId: null, outcome: member.state };
        const launch = await findOwnedLaunchByMutationId(member.clientMutationId);
        const active = await lookupOwnedActiveRunFresh(member.surfaceId);
        return {
          taskName: member.taskName,
          surfaceId: member.surfaceId,
          outcome: launch?.surfaceId === member.surfaceId ? launch.outcome : 'unconfirmed',
          activeProcess: active?.pid !== undefined || active?.tmuxSession !== undefined,
        };
      }));
      return jsonResult({ ...status, memberOutcomes });
    } catch (error) {
      return textResult(`Shared team review unavailable: ${safeErrorText(error)}`, true);
    }
  };

  const handleFinishSharedTeam = async (args: Record<string, unknown>): Promise<ToolResult> => {
    if (!config.repoPath || !config.parentThreadId) {
      return textResult('cortex_finish_shared_team failed: Open the saved orchestrator chat, then retry.', true);
    }
    try {
      const reviewSummary = typeof args.reviewSummary === 'string' ? args.reviewSummary.trim() : '';
      const verification = typeof args.verification === 'string' ? args.verification.trim() : '';
      const result = await finishSharedCheckoutTeam({
        repoPath: config.repoPath,
        parentThreadId: config.parentThreadId,
        reviewSummary,
        verification,
      });
      return jsonResult({ ok: true, teamId: result.team.id, reviewedHead: result.reviewedHead,
        committedPaths: result.committedPaths, note: 'Shared team review was archived and checkout ownership was released.' });
    } catch (error) {
      return textResult(sharedCheckoutControlFailure('cortex_finish_shared_team', error), true);
    }
  };

  const handleReconcileSharedTeam = async (args: Record<string, unknown>): Promise<ToolResult> => {
    if (!config.repoPath || !config.parentThreadId) {
      return textResult('cortex_reconcile_shared_team failed: Open the saved orchestrator chat, then retry.', true);
    }
    if (typeof args.reviewId !== 'string' || typeof args.reviewedHead !== 'string'
      || typeof args.reviewSummary !== 'string' || !Array.isArray(args.acknowledgedPaths)
      || !args.acknowledgedPaths.every((path) => typeof path === 'string')) {
      return textResult('cortex_reconcile_shared_team failed: Provide the exact status review ID, HEAD, paths and an explicit review summary. Run cortex_shared_team_status and review the current diff before retrying.', true);
    }
    try {
      const receipt = await reconcileSharedCheckoutTeam({ repoPath: config.repoPath, parentThreadId: config.parentThreadId,
        reviewId: args.reviewId, reviewedHead: args.reviewedHead, acknowledgedPaths: args.acknowledgedPaths,
        reviewSummary: args.reviewSummary });
      return jsonResult({ ok: true, receipt, note: 'Reviewed checkout state recorded. Source is unchanged; Finish must still verify settled workers and this exact state.' });
    } catch (error) { return textResult(sharedCheckoutControlFailure('cortex_reconcile_shared_team', error), true); }
  };

  async function handleCorrectWorkers(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      if (!config.repoPath || !config.parentThreadId) return textResult('Worker corrections require a persisted parent conversation.', true);
      const path = '/api/orchestrator/worker-corrections';
      if (args.targets === undefined) return jsonResult(await config.apiFetch(`${path}?${new URLSearchParams({ repoPath: config.repoPath, threadId: config.parentThreadId })}`));
      return jsonResult(await config.apiFetch(path, { method: 'POST', body: JSON.stringify({ repoPath: config.repoPath,
        threadId: config.parentThreadId, id: args.idempotencyKey, payload: { targets: args.targets, message: args.message,
          mode: args.mode, holdMerges: args.holdMerges === true } }) }));
    } catch (error) { return textResult(`Worker correction failed: ${safeErrorText(error)}`, true); }
  }

  async function handleInterruptAgent(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const surfaceId = args.surfaceId as string;
      if (!surfaceId) return textResult('surfaceId is required', true);

      const result = await pollCorrelatedMcpApiMutation<Record<string, unknown>>({
        url: `${config.apiBase}/api/runtime/action`,
        authorization: `Bearer ${config.wsToken}`,
        body: { action: 'interrupt', surfaceId },
        parseError: (response, payload) => apiError('/api/runtime/action', response.status, JSON.stringify(payload)),
        correlationField: 'clientMutationId',
      });

      if (result.ok) {
        return jsonResult({ ok: true, note: result.note });
      }
      return textResult(`Interrupt failed: ${safeErrorText(result)}`, true);
    } catch (err) {
      return textResult(`Failed to interrupt agent: ${safeErrorText(err)}`, true);
    }
  }

  return { handleWorkerCatalog, handleLaunchAgent, handleSharedTeamStatus, handleFinishSharedTeam, handleReconcileSharedTeam, handleCorrectWorkers, handleInterruptAgent };
}
