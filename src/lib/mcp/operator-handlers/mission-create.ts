import { createHash } from 'node:crypto';
import { McpInputError } from '@/lib/mcp/api-error';
import { resolveSealedMissionContract } from '@/lib/orchestrator/sealed-task-contract';
import { createMission, createMissionInline, dispatchMission } from '@/lib/mcp/operator-mission-tools';
import { nextInlineIssueNumbers } from '@/lib/orchestrator/operator-mission-service/shared';
import { type McpToolResult, errorText, jsonResult, optionalString, parseIssueList, parseMissionRuntime, requiredString, textResult } from './shared';
import { parseMissionCandidateMode, parseTaskContractSetting } from './quality-search-input';
import { parseMissionWorkerPinInput, parseWorkerProvider } from './mission-worker-input';
import { parseExistingBranchPolicy, parseWorkerIntent } from './mission-input';

export async function handleCreateMission(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const repoPath = requiredString(args, 'repoPath');
    if (args.idempotencyKey !== undefined && (typeof args.idempotencyKey !== 'string' || !args.idempotencyKey.trim())) {
      throw new McpInputError('idempotencyKey must be a non-empty string.');
    }
    const idempotencyKey = optionalString(args, 'idempotencyKey') || undefined;
    const runtime = parseMissionRuntime(args.runtime);
    const workerIntent = parseWorkerIntent(args.workerIntent);
    const requestedProvider = parseWorkerProvider(args.requestedProvider);
    const workerPinInput = parseMissionWorkerPinInput(args);
    const constraints = optionalString(args, 'constraints');
    const inlineIssues = Array.isArray(args.issues_inline) ? args.issues_inline : null;
    const ghIssues = Array.isArray(args.issues) && args.issues.length > 0 ? args.issues : null;
    if (!inlineIssues && !ghIssues) {
      return textResult('Provide either `issues` (GitHub refs) or `issues_inline` (inline objects).', true);
    }
    const shouldDispatch = args.dispatch !== false;
    if (args.projectId !== undefined && (typeof args.projectId !== 'string' || !args.projectId.trim())) {
      return textResult('projectId must be a non-empty project identifier.', true);
    }
    const projectId = optionalString(args, 'projectId') || undefined;
    const sequential = args.sequential === true;
    if (args.origin !== undefined && args.origin !== 'design-mode') return textResult('origin must be `design-mode` when provided.', true);
    const origin = args.origin === 'design-mode' ? 'design-mode' as const : undefined;
    const existingBranchPolicy = parseExistingBranchPolicy(args.existingBranchPolicy);
    const useBrain = typeof args.useBrain === 'boolean' ? args.useBrain : undefined;
    const huddle = typeof args.huddle === 'boolean' ? args.huddle : undefined;
    const holdMerges = args.holdMerges === true;
    const orchestratorThreadId = optionalString(args, 'orchestratorThreadId') || undefined;
    const orchestratorTurnId = optionalString(args, 'orchestratorTurnId') || undefined;
    const parentWorkspaceId = optionalString(args, 'parentWorkspaceId') || undefined;
    const caller = optionalString(args, 'caller') || undefined;
    const readOnly = args.readOnly === true;
    const sealedTaskContract = resolveSealedMissionContract(args, inlineIssues?.length === 1 && !ghIssues);
    const candidateMode = parseMissionCandidateMode(args, huddle);
    if (!candidateMode.ok) return textResult(candidateMode.error, true);
    const { comparisonModels, qualitySearch } = candidateMode;
    if (inlineIssues) {
      // A caller retry must send the same canonical body even in a new MCP process.
      // Keep the existing random allocation for separate unkeyed creations.
      const syntheticNumbers = idempotencyKey
        ? inlineIssues.map((_, index) => 90_000_000_000 + Number.parseInt(createHash('sha256')
          .update(JSON.stringify([idempotencyKey, index])).digest('hex').slice(0, 12), 16))
        : nextInlineIssueNumbers(inlineIssues.length);
      const parsed = inlineIssues.map((entry, index) => {
        if (typeof entry !== 'object' || entry === null) throw new McpInputError('Each inline issue must be an object.');
        const e = entry as Record<string, unknown>;
        const title = typeof e.title === 'string' ? e.title.trim() : '';
        if (!title) throw new McpInputError('Each inline issue must have a title.');
        const syntheticNumber = syntheticNumbers[index]!;
        if (e.allowedFiles !== undefined
          && (!Array.isArray(e.allowedFiles) || e.allowedFiles.some((file) => typeof file !== 'string' || !file.trim()))) {
          throw new McpInputError('allowedFiles must be a list of non-empty repository-relative paths.');
        }
        const allowedFiles = (e.allowedFiles as string[] | undefined)?.map((file) => file.trim());
        return {
          number: syntheticNumber, title, body: typeof e.body === 'string' ? e.body : '',
          ...(allowedFiles?.length ? { allowedFiles } : {}),
        };
      });
      const createResult = await createMissionInline({
        issues_inline: parsed,
        idempotencyKey,
        repoPath,
        projectId,
        runtime, origin,
        workerIntent,
        requestedProvider,
        requestedRuntime: runtime,
        ...workerPinInput,
        constraints,
        dispatchOnCreate: shouldDispatch,
        sequential,
        existingBranchPolicy,
        useBrain, holdMerges,
        huddle, taskContract: parseTaskContractSetting(args.taskContract),
        comparisonModels,
        qualitySearch, sealedTaskContract,
        orchestratorThreadId, orchestratorTurnId, parentWorkspaceId, caller, readOnly,
      });
      if (shouldDispatch && createResult && !('error' in createResult) && !('replayed' in createResult && createResult.replayed === true)) {
        // Fire-and-forget: dispatch can take 30–60s on its own, and the
        // combined create+dispatch path often exceeds the MCP client's
        // tool-call timeout (~60s), which closes the transport while the
        // backend is still processing. Return the create result immediately
        // so the caller gets a clean response, and run dispatch in the
        // background. Callers can poll get_mission_status for progress.
        void dispatchMission({ missionId: createResult.missionId }).catch((err) => {
          console.error('[mcp-operator] background dispatch failed', errorText(err));
        });
        return jsonResult({
          ...createResult,
          dispatch: { queued: true, note: 'Dispatch running in background. Use get_mission_status to poll.' },
        });
      }
      if ('error' in createResult) return textResult(createResult.error, true);
      return jsonResult(createResult);
    }

    const createResult = await createMission({
      issues: parseIssueList(args.issues),
      idempotencyKey,
      repoPath,
      projectId,
      runtime, origin,
      workerIntent,
      requestedProvider,
      requestedRuntime: runtime,
      ...workerPinInput,
      constraints,
      dispatchOnCreate: shouldDispatch,
      sequential,
      existingBranchPolicy,
      useBrain, holdMerges,
      huddle, taskContract: parseTaskContractSetting(args.taskContract),
      comparisonModels,
      qualitySearch,
      orchestratorThreadId, orchestratorTurnId, parentWorkspaceId, caller, readOnly,
    });
    if (shouldDispatch && createResult && !('error' in createResult) && !('replayed' in createResult && createResult.replayed === true)) {
      void dispatchMission({ missionId: createResult.missionId }).catch((err) => {
        console.error('[mcp-operator] background dispatch failed', errorText(err));
      });
      return jsonResult({
        ...createResult,
        dispatch: { queued: true, note: 'Dispatch running in background. Use get_mission_status to poll.' },
      });
    }
    if ('error' in createResult) return textResult(createResult.error, true);
    return jsonResult(createResult);
  } catch (error) {
    console.error(`${'[mcp-operator]'} create_mission failed: ${errorText(error)}`);
    return textResult(`Failed to create mission: ${errorText(error)}`, true);
  }
}
