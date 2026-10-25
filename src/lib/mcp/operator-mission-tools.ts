import { execFile } from '@/lib/providers/child-process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { apiError, McpInputError, O8ApiError, unreachableApiError } from '@/lib/mcp/api-error';
import { DEFAULT_API_PORT } from '@/lib/panel/api-port';
import { pollCorrelatedMcpMutation } from '@/lib/mcp/correlated-mutation';
import type { CorrelatedActionPayload } from '@/lib/orchestrator/action-receipt';

/**
 * Resolve the backend base URL from env, port file, or legacy default.
 * Kept inline (small dupe with operator-mcp-server.ts) because this file
 * is also imported from the Next server where getApiBase() is available,
 * but the MCP-spawn path needs a plain function without Next-specific deps.
 */
function resolveApiBase(): string {
  // Precedence: api-port FILE first (always reflects the running app),
  // then env vars (Tauri sidecar children), then legacy default.
  // The file is the only signal that survives env staleness across dev /
  // prod port swaps, app restarts, and Claude Code parent shells whose
  // O8_API_BASE was set before a port change. Env-var-first was the old
  // order and stuck MCP on dead ports across the dev-frontend swap.
  try {
    const dataDir = getDataDir();
    const portFile = join(dataDir, 'api-port');
    if (existsSync(portFile)) {
      const n = parseInt(readFileSync(portFile, 'utf-8').trim(), 10);
      if (Number.isInteger(n) && n > 0 && n < 65536) {
        return `http://127.0.0.1:${n}`;
      }
    }
  } catch { /* fall through */ }
  const envBase = process.env.O8_API_BASE?.trim();
  if (envBase) return envBase;
  const envPort = process.env.O8_API_PORT?.trim();
  if (envPort) return `http://127.0.0.1:${envPort}`;
  return `http://localhost:${DEFAULT_API_PORT}`;
}

// ── Panel Bearer token ──
//
// Same pattern as operator-handlers/shared.ts: the middleware's loopback
// bypass doesn't trigger reliably for plain Node fetch from this MCP path
// (no Origin / sec-fetch-site headers). Adding `Authorization: Bearer
// <ws-token>` is belt-and-suspenders. Without this, MCP create_mission /
// dispatch / status calls return 401 from the gated /api/orchestrator/*
// routes even though the loopback origin should pass.
let _cachedPanelToken: { value: string; readAt: number } | null = null;
const PANEL_TOKEN_TTL_MS = 30_000;

function readPanelToken(): string | null {
  const now = Date.now();
  if (_cachedPanelToken && now - _cachedPanelToken.readAt < PANEL_TOKEN_TTL_MS) {
    return _cachedPanelToken.value || null;
  }
  try {
    const dataDir = getDataDir();
    const tokenPath = join(dataDir, 'ws-token');
    if (!existsSync(tokenPath)) {
      _cachedPanelToken = { value: '', readAt: now };
      return null;
    }
    const value = readFileSync(tokenPath, 'utf-8').trim();
    _cachedPanelToken = { value, readAt: now };
    return value || null;
  } catch {
    return null;
  }
}
/** Keep native mission reads behind this client's credential-rotation window. */
export function nativeMissionReadCredentialMatches(token: string): boolean {
  return readPanelToken() === token;
}
import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import type {
  ApproveAndMergeInput as ApproveAndMergeRequest,
  CreateMissionInput as CreateMissionRequest,
  DispatchMissionInput,
  ExistingBranchPolicy,
  LoadedIssue,
  MissionStatusInput,
  ResetPacketInput,
  RerunWithFeedbackInput,
  SubmitReviewInput,
} from '@/lib/orchestrator/operator-mission-service';
import type { OrchestratorRuntime, PacketTaskContract, WorkerIntent, WorkerProvider } from '@/lib/orchestrator/types';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { ClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import { getDataDir } from '@/lib/data-dir-migration';

const execFileAsync = promisify(execFile);
const GH_MAX_BUFFER = 10 * 1024 * 1024;
const LOG_PREFIX = '[mcp-operator]';

// Re-resolve API base on every call (with a 1s cache to avoid file-stat
// hammering inside hot fetch loops). The constant-at-boot pattern was a
// trap: when the prod app rewrites api-port AFTER the MCP server boots
// (e.g. dev-bridge launching, prod app port-probing past 3001), the
// cached value is stale and every fetch hits a dead port.
let _cachedApiBase: { value: string; ts: number } | null = null;
function getApiBaseLive(): string {
  const now = Date.now();
  if (_cachedApiBase && now - _cachedApiBase.ts < 1000) return _cachedApiBase.value;
  const value = resolveApiBase();
  _cachedApiBase = { value, ts: now };
  return value;
}

interface CreateMissionInput {
  idempotencyKey?: string;
  issues: string[];
  repoPath: string;
  projectId?: string | null;
  runtime: OrchestratorRuntime;
  origin?: 'design-mode';
  workerIntent?: WorkerIntent;
  requestedProvider?: WorkerProvider | null;
  requestedRuntime?: OrchestratorRuntime | null;
  requestedModel?: string | null;
  requestedEffort?: ThinkingEffort | null;
  claudeCodeCarrier?: ClaudeCodeModelSource | null;
  constraints: string;
  dispatchOnCreate?: boolean;
  sequential?: boolean;
  existingBranchPolicy?: ExistingBranchPolicy;
  useBrain?: boolean;
  holdMerges?: boolean;
  huddle?: boolean;
  taskContract?: 'off';
  sealedTaskContract?: PacketTaskContract;
  /** Best-of-N (item 3) — forwarded to the create-mission API, clamped ≤4 there. */
  comparisonModels?: string[];
  qualitySearch?: { taskContract: PacketTaskContract };
  /** #1329 — the orchestrator's active thread id, so workers inherit its session rules. */
  orchestratorThreadId?: string;
  /** Exact assistant transcript entry whose receipt owns launched workers. */
  orchestratorTurnId?: string;
  parentWorkspaceId?: string;
  caller?: string;
  readOnly?: boolean;
}

interface InlineIssue {
  number: number;
  title: string;
  body?: string;
}

interface CreateMissionInlineInput {
  idempotencyKey?: string;
  issues_inline: InlineIssue[];
  repoPath: string;
  projectId?: string | null;
  runtime: OrchestratorRuntime;
  origin?: 'design-mode';
  workerIntent?: WorkerIntent;
  requestedProvider?: WorkerProvider | null;
  requestedRuntime?: OrchestratorRuntime | null;
  requestedModel?: string | null;
  requestedEffort?: ThinkingEffort | null;
  claudeCodeCarrier?: ClaudeCodeModelSource | null;
  constraints: string;
  dispatchOnCreate?: boolean;
  sequential?: boolean;
  existingBranchPolicy?: ExistingBranchPolicy;
  useBrain?: boolean;
  holdMerges?: boolean;
  huddle?: boolean;
  taskContract?: 'off';
  sealedTaskContract?: PacketTaskContract;
  /** Best-of-N (item 3) — forwarded to the create-mission API, clamped ≤4 there. */
  comparisonModels?: string[];
  qualitySearch?: { taskContract: PacketTaskContract };
  /** #1329 — the orchestrator's active thread id, so workers inherit its session rules. */
  orchestratorThreadId?: string;
  /** Exact assistant transcript entry whose receipt owns launched workers. */
  orchestratorTurnId?: string;
  parentWorkspaceId?: string;
  caller?: string;
  readOnly?: boolean;
}

interface ApiSuccessResponse<T> {
  ok: true;
  result: T;
}

interface ApiErrorResponse {
  ok: false;
  error: {
    code?: string;
    message?: string;
  } | string;
}

type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;
type MissionToolError = { error: string; code?: string };

function log(message: string, details?: unknown) {
  if (details === undefined) {
    console.log(`${LOG_PREFIX} ${message}`);
    return;
  }
  console.log(`${LOG_PREFIX} ${message}`, details);
}

function ensureRepoPath(repoPath: string) {
  const normalized = repoPath.trim();
  if (!normalized) {
    throw new McpInputError('repoPath is required.');
  }
  if (!existsSync(normalized) || !statSync(normalized).isDirectory()) {
    throw new Error(`Repository path not found: ${normalized}`);
  }

  // The authenticated operator MCP is allowed to dispatch against an explicit
  // local path without mutating Projects. The server still owns worktree,
  // runtime, and governance validation for the resulting transient mission.
  return normalized;
}

function missionLaunchContext(input: {
  orchestratorThreadId?: string;
  parentWorkspaceId?: string;
  caller?: string;
  readOnly?: boolean;
}) {
  const inAppOrchestrator = Boolean(input.orchestratorThreadId?.trim());
  return {
    source: inAppOrchestrator ? 'desktop' as const : 'mcp' as const,
    presentation: inAppOrchestrator ? 'tab' as const : 'split' as const,
    repoContext: inAppOrchestrator ? 'registered' as const : 'transient' as const,
    ...(input.readOnly ? { workMode: 'read-only' as const } : {}),
    caller: input.caller?.trim() || (inAppOrchestrator ? 'orchestrator' : 'external agent'),
    ...(input.parentWorkspaceId?.trim() ? { parentWorkspaceId: input.parentWorkspaceId.trim() } : {}),
    ...(input.orchestratorThreadId?.trim() ? { parentThreadId: input.orchestratorThreadId.trim() } : {}),
  };
}

function normalizeIssueRef(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return '';
  }

  const urlMatch = normalized.match(/\/issues\/(\d+)(?:\/)?$/i);
  if (urlMatch?.[1]) {
    return urlMatch[1];
  }

  const hashMatch = normalized.match(/^#?(\d+)$/);
  if (hashMatch?.[1]) {
    return hashMatch[1];
  }

  return normalized;
}

async function loadIssue(repoPath: string, issueRef: string): Promise<LoadedIssue> {
  const normalizedIssueRef = normalizeIssueRef(issueRef);
  if (!normalizedIssueRef) {
    throw new McpInputError('Issue references must be non-empty.');
  }

  const { stdout } = await execFileAsync(
    'gh',
    ['issue', 'view', normalizedIssueRef, '--json', 'number,title,body,url'],
    { windowsHide: true, cwd: repoPath, maxBuffer: GH_MAX_BUFFER },
  );

  const parsed = JSON.parse(stdout) as Partial<LoadedIssue>;
  if (typeof parsed.number !== 'number' || typeof parsed.title !== 'string') {
    throw new Error(`Unable to load issue ${normalizedIssueRef}.`);
  }

  return {
    number: parsed.number,
    title: parsed.title,
    body: typeof parsed.body === 'string' ? parsed.body : '',
    url: typeof parsed.url === 'string' ? parsed.url : '',
  };
}

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [500, 1500, 4000];
const FETCH_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
      log(`API retry ${attempt}/${MAX_RETRIES} for ${path} in ${delay}ms`);
      await sleep(delay);
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const panelToken = readPanelToken();
      const baseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (panelToken) baseHeaders.Authorization = `Bearer ${panelToken}`;
      try {
        response = await fetch(`${getApiBaseLive()}${path}`, {
          ...init,
          signal: controller.signal,
          headers: { ...baseHeaders, ...init?.headers },
        });
      } finally {
        clearTimeout(timer);
      }
      break;
    } catch (error) {
      console.error('[mcp] API request failed:', { path }, error);
      response = undefined;
    }
  }

  // A network failure after every retry usually means the backend is not running.
  if (!response) throw unreachableApiError();
  const status = response.status;
  const body = await response.text().catch((error) => { throw apiError(path, status, '', error); });
  if (!response.ok) throw apiError(path, response.status, body);
  let payload: ApiResponse<T> | null;
  try {
    payload = JSON.parse(body) as ApiResponse<T> | null;
  } catch (error) {
    throw apiError(path, response.status, body, error);
  }
  if (payload?.ok === true && 'result' in payload) return payload.result;
  throw apiError(path, response.status, body);
}

async function correlatedApiRequest<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const payload = await pollCorrelatedMcpMutation<ApiResponse<T> & CorrelatedActionPayload>({
    body,
    correlationField: 'idempotencyKey',
    send: async (requestBody) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const panelToken = readPanelToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (panelToken) headers.Authorization = `Bearer ${panelToken}`;
      try {
        const response = await fetch(`${getApiBaseLive()}${path}`, {
          method: 'POST',
          headers,
          body: requestBody,
          signal: controller.signal,
        });
        if (!response.ok) apiError(path, response.status, await response.clone().text());
        return response;
      } catch (error) {
        throw apiError(path, null, '', error);
      } finally {
        clearTimeout(timer);
      }
    },
    parseError: (response, responsePayload) => apiError(path, response.status, JSON.stringify(responsePayload)),
  });
  if (payload.ok === true && 'result' in payload) return payload.result as T;
  throw apiError(path, 200, JSON.stringify(payload));
}

function missionToolError(action: string, error: unknown, fallback: string): MissionToolError {
  console.error(`${LOG_PREFIX} ${action} failed`, error);
  return {
    error: error instanceof O8ApiError ? error.summary : error instanceof McpInputError ? error.message : fallback,
    ...(error instanceof O8ApiError && error.routeError ? { code: error.routeError.code } : {}),
  };
}

export async function createMission(input: CreateMissionInput) {
  try {
    const repoPath = ensureRepoPath(input.repoPath);
    const loadedIssues = await Promise.all(input.issues.map((issueRef) => loadIssue(repoPath, issueRef)));

    log(`Loaded ${loadedIssues.length} issue${loadedIssues.length === 1 ? '' : 's'} locally; delegating mission creation to Next.js API.`);

    return await correlatedApiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').createMission>>>(
      '/api/orchestrator/create-mission',
      {
          issues: loadedIssues,
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          repoPath,
          projectId: input.projectId,
          runtime: input.runtime,
          origin: input.origin,
          workerIntent: input.workerIntent,
          requestedProvider: input.requestedProvider,
          requestedRuntime: input.requestedRuntime,
          requestedModel: input.requestedModel,
          requestedEffort: input.requestedEffort,
          claudeCodeModel: input.requestedModel,
          claudeCodeCarrier: input.claudeCodeCarrier,
          constraints: input.constraints,
          dispatchOnCreate: input.dispatchOnCreate,
          sequential: input.sequential,
          existingBranchPolicy: input.existingBranchPolicy,
          useBrain: input.useBrain,
          holdMerges: input.holdMerges,
          huddle: input.huddle,
          taskContract: input.taskContract,
          sealedTaskContract: input.sealedTaskContract,
          comparisonModels: input.comparisonModels,
          qualitySearch: input.qualitySearch,
          orchestratorThreadId: input.orchestratorThreadId,
          orchestratorTurnId: input.orchestratorTurnId,
          dispatcher: { surface: 'orchestrator', id: input.orchestratorThreadId ?? 'operator-mcp' },
          launchContext: missionLaunchContext(input),
        } satisfies CreateMissionRequest,
    );
  } catch (error) {
    return missionToolError('createMission', error, 'Failed to create mission.');
  }
}

/**
 * #453 — Create a mission from inline issue objects, bypassing `gh issue view`.
 * Use when GitHub API is rate-limited or issues are ad-hoc/synthetic.
 */
export async function createMissionInline(input: CreateMissionInlineInput) {
  try {
    const repoPath = ensureRepoPath(input.repoPath);

    const loadedIssues: LoadedIssue[] = input.issues_inline.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      url: '',
    }));

    log(`Creating mission from ${loadedIssues.length} inline issue${loadedIssues.length === 1 ? '' : 's'} (no GitHub fetch).`);

    return await correlatedApiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').createMission>>>(
      '/api/orchestrator/create-mission',
      {
          issues: loadedIssues,
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          repoPath,
          projectId: input.projectId,
          runtime: input.runtime,
          origin: input.origin,
          workerIntent: input.workerIntent,
          requestedProvider: input.requestedProvider,
          requestedRuntime: input.requestedRuntime,
          requestedModel: input.requestedModel,
          requestedEffort: input.requestedEffort,
          claudeCodeModel: input.requestedModel,
          claudeCodeCarrier: input.claudeCodeCarrier,
          constraints: input.constraints,
          dispatchOnCreate: input.dispatchOnCreate,
          sequential: input.sequential,
          existingBranchPolicy: input.existingBranchPolicy,
          useBrain: input.useBrain,
          holdMerges: input.holdMerges,
          huddle: input.huddle,
          taskContract: input.taskContract,
          sealedTaskContract: input.sealedTaskContract,
          comparisonModels: input.comparisonModels,
          qualitySearch: input.qualitySearch,
          orchestratorThreadId: input.orchestratorThreadId,
          orchestratorTurnId: input.orchestratorTurnId,
          dispatcher: { surface: 'orchestrator', id: input.orchestratorThreadId ?? 'operator-mcp' },
          launchContext: missionLaunchContext(input),
        } satisfies CreateMissionRequest,
    );
  } catch (error) {
    return missionToolError('createMissionInline', error, 'Failed to create mission.');
  }
}

export async function dispatchMission(input: DispatchMissionInput) {
  try {
    return await correlatedApiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').dispatchMission>>>(
      '/api/orchestrator/dispatch',
      { missionId: input.missionId, runtime: input.runtime },
    );
  } catch (error) {
    return missionToolError('dispatchMission', error, 'Failed to dispatch mission.');
  }
}

export async function getMissionStatus(input: MissionStatusInput) {
  try {
    const params = new URLSearchParams();
    if (input.missionId?.trim()) {
      params.set('missionId', input.missionId.trim());
    }
    if (input.includeCost) {
      params.set('includeCost', 'true');
    }
    if (input.includeTiming) {
      params.set('includeTiming', 'true');
    }

    const suffix = params.toString() ? `?${params.toString()}` : '';
    return await apiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').getMissionStatus>>>(
      `/api/orchestrator/status${suffix}`,
    );
  } catch (error) {
    return missionToolError('getMissionStatus', error, 'Failed to read mission status.');
  }
}

export async function submitPacketReview(input: SubmitReviewInput) {
  try {
    return await correlatedApiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').submitPacketReview>>>(
      '/api/orchestrator/review',
      {
        packetId: input.packetId,
        findings: input.findings,
        approved: input.approved,
        reviewedHeadSha: input.reviewedHeadSha,
        contractCoverageEvidence: input.contractCoverageEvidence,
      },
    );
  } catch (error) {
    return missionToolError('submitPacketReview', error, 'Failed to submit review.');
  }
}

export async function approveAndMergePacket(input: ApproveAndMergeRequest) {
  try {
    return await correlatedApiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').approveAndMergePacket>>>(
      '/api/orchestrator/merge',
      {
        packetId: input.packetId,
        commitMessage: input.commitMessage,
        expectedHeadSha: input.expectedHeadSha,
      },
    );
  } catch (error) {
    return missionToolError('approveAndMergePacket', error, 'Failed to approve and merge packet.');
  }
}

export async function resetPacket(input: ResetPacketInput) {
  try {
    return await correlatedApiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').resetPacket>>>(
      '/api/orchestrator/reset-packet',
      {
        packetId: input.packetId,
        reason: input.reason,
        clearWorktree: input.clearWorktree,
      },
    );
  } catch (error) {
    return missionToolError('resetPacket', error, 'Failed to reset packet.');
  }
}

export async function rerunWithFeedback(input: RerunWithFeedbackInput) {
  try {
    return await correlatedApiRequest<Awaited<ReturnType<typeof import('@/lib/orchestrator/operator-mission-service').rerunWithFeedback>>>(
      '/api/orchestrator/rerun-with-feedback',
      {
        packetId: input.packetId,
        feedback: input.feedback,
      },
    );
  } catch (error) {
    return missionToolError('rerunWithFeedback', error, 'Failed to rerun packet with feedback.');
  }
}

export type { OrchestratorReviewFinding };
