#!/usr/bin/env node
/**
 * o8 MCP Server — stdio JSON-RPC 2.0 server that exposes
 * Cortex operations as tools for the orchestrator Claude Code process.
 *
 * Spawned as a child process by orchestrator-session.ts via --mcp-config.
 * Communicates over stdin/stdout with newline-delimited JSON.
 *
 * Environment:
 *   CORTEX_API_BASE  — e.g. http://localhost:47100 (required)
 *   CORTEX_REPO_PATH — workspace repo path (optional, for context)
 *   CORTEX_REPO_SLUG — e.g. owner/repo (optional, for GitHub queries)
 */

// MUST run before imports that initialize SQLite or create the WS token.
import './stdio-console';
import './orphan-exit-bootstrap';

// Neutralizes the `server-only` marker so this standalone Node
// process (launched via `tsx` on the TS source in dev) doesn't crash when a
// shared library module transitively imports `server-only`. See the module's
// header for the full rationale.
import './neutralize-server-only';

import { apiError, McpInputError, O8ApiError, safeErrorText } from '@/lib/mcp/api-error';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_API_PORT } from '@/lib/panel/api-port';
import { CORTEX_READONLY_TOOLS } from './cortex-readonly-tools';
import { parseMcpConfigInput, type ParsedMcpServer } from './parse-config';
import { getOrCreateWsToken } from '../ws-auth';
import {
  addRepoToProject,
  createProject,
  deleteProject,
  listProjects,
  recordDismissedSuggestion,
  removeRepoFromProject,
  setRepoRole,
} from '../projects/store';
import type { ProjectRole } from '../projects/types';
import {
  getCachedSuggestion,
  removeSuggestionFromCache,
  suggestProjects,
} from '../projects/suggest';
import { getDataDir } from '@/lib/data-dir-migration';
import { packetStatusWriteRejection } from '@/lib/orchestrator/packet-patch-policy';
import { pollCorrelatedMcpApiMutation } from '@/lib/mcp/correlated-mutation';
import { createCortexDelegationHandlers } from '@/lib/mcp/cortex-delegation-handlers';
import { CORTEX_WORKER_TOOLS } from './cortex-worker-tools';
import { createWorkerObservationHandlers } from './worker-observation';
import { TRANSCRIPT_READ_TOOL } from './transcript-read-tool';
import { deferredMcpRequest } from './deferred-tools';
import type { McpTool, McpToolResult } from './operator-handlers/shared';

/**
 * Resolve the backend base URL from env, port file, or legacy default.
 * The Tauri sidecar writes ~/.o8/api-port after probing for a free
 * port, so MCP servers spawned long after the Tauri shell picked a port
 * still land on the live backend.
 */
function resolveApiBase(): string {
  if (process.env.CORTEX_API_BASE) return process.env.CORTEX_API_BASE;
  if (process.env.O8_API_PORT) return `http://127.0.0.1:${process.env.O8_API_PORT}`;
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
  return `http://127.0.0.1:${DEFAULT_API_PORT}`;
}

// ── Types ──

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

// ── Config ──

const API_BASE = resolveApiBase();
const REPO_PATH = process.env.CORTEX_REPO_PATH || '';
const PARENT_THREAD_ID = process.env.CORTEX_THREAD_ID || '';
const FAST_CAPABILITY = process.env.CORTEX_FAST_CAPABILITY || '';
const REPO_SLUG = process.env.CORTEX_REPO_SLUG || '';
const WS_TOKEN = process.env.WS_TOKEN?.trim() || getOrCreateWsToken();
const { handleWorkerCatalog, handleLaunchAgent, handleSharedTeamStatus, handleFinishSharedTeam, handleReconcileSharedTeam, handleCorrectWorkers, handleInterruptAgent } = createCortexDelegationHandlers({
  apiFetch,
  apiBase: API_BASE,
  repoPath: REPO_PATH,
  parentThreadId: PARENT_THREAD_ID,
  fastCapability: FAST_CAPABILITY,
  wsToken: WS_TOKEN,
});

// ── Read-only profile (Collide proposer / #1075 dispatch lockout) ──
//
// cortex is a MIXED surface: read tools (ask, read_packets, …) live alongside
// MUTATORS — most dangerously `cortex_launch_agent`, whose handler POSTs
// /api/orchestrator/delegate and dispatches a Codex worker. A read-only Collide
// proposer must NOT be handed any of that. When CORTEX_READONLY=1 this server
// advertises + accepts ONLY the allowlisted read tools; everything else (incl.
// any cortex tool added later, and every mutator) FAILS CLOSED. Allowlist, not
// denylist — new tools must opt IN to being proposer-safe, never fall through.
const CORTEX_READONLY = process.env.CORTEX_READONLY === '1';

// ── Tool Definitions ──

const TOOLS: McpTool[] = [
  {
    name: 'cortex_fleet_status',
    description:
      'List registered runtime sessions with exact handles, observed ownership and capabilities. ' +
      'relatedWorkers lists persisted workers for this parent conversation, including archived shared teams. Discovery grants no mutation authority.',
    inputSchema: {
      type: 'object',
      properties: {
        fresh: {
          type: 'boolean',
          description: 'Force a fresh fetch instead of using cache. Default false.',
        },
      },
    },
  },
  {
    name: 'cortex_list_issues',
    description:
      'List open GitHub issues for a repository. Returns a bounded summary per issue (number, title, state, author, labels, comments, created) — not the body. Use `gh issue view` for full text.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository slug (e.g. "owner/repo"). Uses the current repo if omitted.',
        },
        limit: {
          type: 'number',
          description: 'Max issues to return (default 30).',
        },
      },
    },
  },
  {
    name: 'cortex_list_prs',
    description:
      'List open pull requests for a repository. Returns PR number, title, author, branches, and review status.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository slug (e.g. "owner/repo"). Uses the current repo if omitted.',
        },
        limit: {
          type: 'number',
          description: 'Max PRs to return (default 30).',
        },
      },
    },
  },
  {
    name: 'cortex_ci_status',
    description:
      'Get recent CI/CD pipeline runs (GitHub Actions) for a repository. Returns workflow name, status, conclusion, and branch.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository slug (e.g. "owner/repo"). Uses the current repo if omitted.',
        },
      },
    },
  },
  {
    name: 'cortex_read_packets',
    description:
      'Read the current orchestrator mission state — the planned work packets. ' +
      'Returns the mission prompt, summary, and all packets with their status, dependencies, and lane bindings.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'lane_touches',
    description:
      'Read active lanes touching one or more repo-relative files. Pass `path` for direct lookup or `packet` to find sibling lanes touching any file in that packet diff.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repo-relative path or comma-separated paths to check.',
        },
        packet: {
          type: 'string',
          description: 'Packet ID whose diff files should be checked against sibling lanes.',
        },
        repo: {
          type: 'string',
          description: 'Optional repo slug or local repo path to narrow the lookup.',
        },
      },
    },
  },
  {
    name: 'cortex_update_packet',
    description:
      'Update mutable metadata on a single work packet by ID. Status is lane-derived; status writes are rejected with the correct lifecycle verb.',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'The packet ID to update.',
        },
        updates: {
          type: 'object',
          description: 'Fields to update on the packet.',
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            queueState: { type: 'string', enum: ['draft', 'queued', 'held'] },
            branchTarget: { type: 'string' },
            blockedReason: { type: 'string' },
          },
        },
      },
      required: ['packetId', 'updates'],
    },
  },
  {
    name: 'cortex_list_approvals',
    description:
      'List pending approval requests from AI agents. Returns approval ID, title, risk level, tool name, and description.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionKey: {
          type: 'string',
          description: 'Filter approvals by session key. Returns all pending if omitted.',
        },
      },
    },
  },
  {
    name: 'cortex_resolve_approval',
    description:
      'Approve or reject a pending approval request.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The approval ID to resolve.' },
        action: { type: 'string', enum: ['approve', 'reject'], description: 'Whether to approve or reject.' },
      },
      required: ['id', 'action'],
    },
  },
  {
    name: 'cortex_propose_spec',
    description:
      'Propose an updated packet spec.md body for the operator to approve. ' +
      'The proposal is queued in the approval surface — the spec only changes if the operator approves; rejecting leaves the spec untouched. ' +
      'Approved updates take effect on the next dispatch of the packet, never an in-flight agent.',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'The packet ID whose spec.md you are proposing to update.',
        },
        proposedSpec: {
          type: 'string',
          description: 'The full new spec.md body (markdown). Replaces the existing content if approved.',
        },
        rationale: {
          type: 'string',
          description: 'Short explanation of why this update is needed. Surfaced in the approval card.',
        },
      },
      required: ['packetId', 'proposedSpec', 'rationale'],
    },
  },
  // ── Delegation tools ──
  ...CORTEX_WORKER_TOOLS,
  {
    name: 'cortex_steer_agent',
    description:
      'Send a follow-up message to a running Codex agent session. Use this to redirect, clarify, or give additional instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        surfaceId: {
          type: 'string',
          description: 'The surfaceId of the agent session (returned by cortex_launch_agent or cortex_fleet_status).',
        },
        message: {
          type: 'string',
          description: 'The follow-up instruction or message to send to the agent.',
        },
      },
      required: ['surfaceId', 'message'],
    },
  },
  {
    name: 'cortex_read_transcript',
    ...TRANSCRIPT_READ_TOOL,
  },
  {
    name: 'cortex_interrupt_agent',
    description:
      'Interrupt/stop a running Codex agent session. Use when an agent is going off-track or needs to be halted.',
    inputSchema: {
      type: 'object',
      properties: {
        surfaceId: {
          type: 'string',
          description: 'The surfaceId of the agent session to interrupt.',
        },
      },
      required: ['surfaceId'],
    },
  },
  {
    name: 'register_mcp',
    description:
      'Register an external MCP server in o8. After registering, the orchestrator session will reload so the new tools become available on the next turn — your transcript is preserved via --resume. ' +
      'Pass either a JSON config block (from a server README) OR discrete fields. ' +
      'Accepts the standard Claude Desktop / Cursor shape: {"mcpServers":{"name":{...}}}, a map of servers, or a single {"command","args"} entry.',
    inputSchema: {
      type: 'object',
      properties: {
        configJson: {
          type: 'string',
          description:
            'Optional: paste the full JSON config from the server README. Accepts {"mcpServers":{...}}, a map of servers, or a single server object. If provided, the discrete fields below are ignored.',
        },
        name: {
          type: 'string',
          description: 'Server identifier (e.g. "filesystem", "slack"). Required unless configJson supplies names.',
        },
        command: {
          type: 'string',
          description: 'Executable for stdio transport (e.g. "npx", "node"). Required unless configJson or transport=http with url.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Command-line arguments for stdio transport.',
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Environment variables passed to the MCP server subprocess.',
        },
        transport: {
          type: 'string',
          enum: ['stdio', 'http'],
          description: 'Transport protocol. Defaults to "stdio".',
        },
        url: {
          type: 'string',
          description: 'For transport="http": the MCP endpoint URL.',
        },
      },
    },
  },
  // ── Projects (epic #899) ──
  {
    name: 'cortex_create_project',
    description:
      'Create a new Project — an operator-curated grouping of repos that share product/team boundaries. ' +
      'Optionally seed with repos and per-repo roles (frontend/backend/shared/etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name for the project.' },
        description: { type: 'string', description: 'Optional description.' },
        repoIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of repo IDs (from the repo registry) to add at creation time.',
        },
        roles: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional roles as a parallel array matching repoIds order (same length). ' +
            'Curated roles: frontend, backend, fullstack, mobile, library, service, infra, docs, site, shared.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'cortex_add_repo_to_project',
    description: 'Link a repo into an existing project, optionally with a role tag.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID returned by cortex_create_project.' },
        repoId: { type: 'string', description: 'Repo ID from the repo registry (~/.o8/repos.json).' },
        role: {
          type: 'string',
          description: 'Optional role tag. Curated values: frontend, backend, fullstack, mobile, library, service, infra, docs, site, shared.',
        },
      },
      required: ['projectId', 'repoId'],
    },
  },
  {
    name: 'cortex_remove_repo_from_project',
    description: 'Unlink a repo from a project. The repo itself is left intact in the registry.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        repoId: { type: 'string' },
      },
      required: ['projectId', 'repoId'],
    },
  },
  {
    name: 'cortex_set_repo_role',
    description: 'Update the role tag on an existing project ↔ repo link.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        repoId: { type: 'string' },
        role: {
          type: 'string',
          description: 'Curated role. Pass empty string to clear the role.',
        },
      },
      required: ['projectId', 'repoId', 'role'],
    },
  },
  {
    name: 'cortex_list_projects',
    description: 'List every project the operator has defined, with their member repos and roles.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'cortex_delete_project',
    description: 'Delete a project. The repos themselves are not removed from the registry; only the grouping goes away.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'cortex_suggest_projects',
    description:
      'Run AI Stage 2: read every registered repo fingerprint and ask Gemini Flash to group them into Projects. ' +
      'Returns cached suggestions when nothing has changed; otherwise recomputes. Two-tier confidence: confident or plausible.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'cortex_refresh_project_suggestions',
    description: 'Force a fresh AI Stage 2 run, bypassing the suggestion cache. Use when a fingerprint changed and the cache key did not yet invalidate.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'cortex_create_project_from_suggestion',
    description:
      'Accept an AI suggestion and turn it into a real Project. Creates the project with the suggested name + detected roles per repo and tags every link as suggestion_origin="ai-semantic". Removes the suggestion from the live cache after acceptance.',
    inputSchema: {
      type: 'object',
      properties: {
        suggestionId: { type: 'string', description: 'Suggestion id returned by cortex_suggest_projects.' },
        name: { type: 'string', description: 'Optional override for the project name (defaults to the suggested name).' },
      },
      required: ['suggestionId'],
    },
  },
  {
    name: 'cortex_dismiss_project_suggestion',
    description:
      'Reject an AI suggestion. The suggestion is removed from the live cache and recorded so it will not be re-suggested.',
    inputSchema: {
      type: 'object',
      properties: {
        suggestionId: { type: 'string', description: 'Suggestion id returned by cortex_suggest_projects.' },
        reason: { type: 'string', description: 'Optional dismissal reason (free text, stored alongside the dismissal record).' },
      },
      required: ['suggestionId'],
    },
  },
  {
    name: 'cortex_ask',
    description:
      'Ask the Engineering Brain a natural-language question. Joins session_outcomes + directives + symbol_graph + GitHub PRs across the operator\'s projects, classifies the question (Class A factual / Class B narrative), retrieves via SQL + FTS5 + graph, and composes an answer with citations back to source rows. Non-streaming JSON result. Use for: "who owns X", "how does Y get reviewed", "what changed in Z this week", "have we tried this before".',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The natural-language question. Plain English, complete sentence.',
        },
        repoPath: {
          type: 'string',
          description: 'Absolute path to the repo whose context to bias toward. Optional — defaults to the current repo if the MCP session is repo-scoped.',
        },
        projectId: {
          type: 'string',
          description: 'Project id to scope the answer to. Optional — defaults to the active project for repoPath.',
        },
        bypassCache: {
          type: 'boolean',
          description: 'Skip the 30s in-process answer cache. Default false. Use when iterating on the same question against fresh data.',
        },
      },
      required: ['question'],
    },
  },
];

// ── Tool Handlers ──

async function apiFetch(path: string, options?: RequestInit): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json', 'x-o8-agent-tool': '1', // #3740: agent tool calls, see /api/panel/approvals
      Authorization: `Bearer ${WS_TOKEN}`,
      ...(options?.headers ?? {}),
    },
  }).catch((error) => { throw apiError(path, null, '', error); });
  try {
    const body = await res.text();
    if (!res.ok) throw apiError(path, res.status, body);
    if (!body) return {};
    try {
      return JSON.parse(body);
    } catch (error) {
      throw apiError(path, res.status, body, error);
    }
  } catch (error) {
    if (error instanceof O8ApiError) throw error;
    throw apiError(path, res.status, '', error);
  }
}

// Clamp a caller-supplied list limit so list tools stay token-bounded.
function resolveLimit(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.min(Math.floor(value), 200);
  }
  return fallback;
}

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], isError };
}

function jsonResult(data: unknown, isError = false): McpToolResult {
  return textResult(JSON.stringify(data), isError);
}

const { handleFleetStatus, handleReadTranscript, handleWaitWorkers } = createWorkerObservationHandlers({
  repoPath: REPO_PATH, parentThreadId: PARENT_THREAD_ID,
}, apiFetch);

async function handleListIssues(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const repo = (args.repo as string) || REPO_SLUG;
    const limit = resolveLimit(args.limit, 30);
    const qs = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    const data = await apiFetch(`/api/panel/issues${qs}`) as Record<string, unknown>;
    const issues = (data.issues ?? []) as Array<Record<string, unknown>>;
    const summary = issues.slice(0, limit).map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      author: (i.author as Record<string, unknown>)?.login ?? null,
      labels: ((i.labels ?? []) as Array<Record<string, unknown>>).map((l) => l.name),
      comments: i.comments,
      created: i.createdAt,
    }));
    return jsonResult({ count: issues.length, returned: summary.length, repo: data.repo, issues: summary });
  } catch (err) {
    return textResult(`Failed to fetch issues: ${safeErrorText(err)}`, true);
  }
}

async function handleListPrs(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const repo = (args.repo as string) || REPO_SLUG;
    const limit = resolveLimit(args.limit, 30);
    const qs = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    const data = await apiFetch(`/api/panel/prs${qs}`) as Record<string, unknown>;
    const prs = (data.prs ?? []) as Array<Record<string, unknown>>;
    const summary = prs.slice(0, limit).map((p) => ({
      number: p.number,
      title: p.title,
      author: (p.author as Record<string, unknown>)?.login ?? null,
      head: p.headRefName,
      base: p.baseRefName,
      additions: p.additions,
      deletions: p.deletions,
      reviewDecision: p.reviewDecision,
      created: p.createdAt,
    }));
    return jsonResult({ count: prs.length, returned: summary.length, repo: data.repo, prs: summary, error: data.error ? safeErrorText({ error: data.error }) : null, stale: data.stale ?? false }, Boolean(data.error));
  } catch (err) {
    return textResult(`Failed to fetch PRs: ${safeErrorText(err)}`, true);
  }
}

async function handleCiStatus(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const repo = (args.repo as string) || REPO_SLUG;
    const qs = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    const data = await apiFetch(`/api/panel/ci${qs}`) as Record<string, unknown>;
    const runs = (data.runs ?? []) as Array<Record<string, unknown>>;
    const summary = runs.map((r) => ({
      workflow: r.workflowName,
      title: r.displayTitle,
      branch: r.headBranch,
      status: r.status,
      conclusion: r.conclusion,
      updated: r.updatedAt,
    }));
    return jsonResult({ count: runs.length, repo: data.repo, runs: summary });
  } catch (err) {
    return textResult(`Failed to fetch CI status: ${safeErrorText(err)}`, true);
  }
}

async function handleReadPackets(): Promise<McpToolResult> {
  try {
    const data = await apiFetch('/api/orchestrator/state') as Record<string, unknown>;
    const mission = data.mission as Record<string, unknown> | undefined;
    if (!mission) return jsonResult({ packets: [], prompt: '', summary: '' });
    const packets = (mission.packets ?? []) as Array<Record<string, unknown>>;
    const summary = packets.map((p) => ({
      id: p.id,
      ref: p.referenceLabel,
      title: p.title,
      status: p.status,
      queueState: p.queueState,
      runtime: p.runtime,
      branch: p.branchTarget,
      dependencies: p.dependencyLabels,
      blocked: p.blockedReason,
      lastEvent: p.lastEventLabel,
    }));
    return jsonResult({
      prompt: mission.prompt,
      summary: mission.summary,
      packetCount: packets.length,
      packets: summary,
      updatedAt: mission.updatedAt,
    });
  } catch (err) {
    return textResult(`Failed to read packets: ${safeErrorText(err)}`, true);
  }
}

async function handleLaneTouches(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const path = typeof args.path === 'string' ? args.path.trim() : '';
    const packet = typeof args.packet === 'string' ? args.packet.trim() : '';
    const repo = typeof args.repo === 'string' ? args.repo.trim() : '';
    if (!path && !packet) {
      return textResult('path or packet is required', true);
    }

    const qs = new URLSearchParams();
    if (path) qs.set('path', path);
    if (packet) qs.set('packet', packet);
    if (repo) qs.set('repo', repo);
    const data = await apiFetch(`/api/lanes/touches?${qs.toString()}`) as Record<string, unknown>;
    return jsonResult(data);
  } catch (err) {
    return textResult(`Failed to read lane touches: ${safeErrorText(err)}`, true);
  }
}

async function handleUpdatePacket(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const packetId = args.packetId as string;
    const updates = (args.updates ?? {}) as Record<string, unknown>;
    if (!packetId) return textResult('packetId is required', true);

    const statusRejection = packetStatusWriteRejection(updates);
    if (statusRejection) return jsonResult({ ok: false, error: statusRejection }, true);
    // Apply the delta atomically server-side — PATCH does the read-modify-write
    // inside the control-plane lock, so concurrent packet edits aren't reverted.
    const result = await apiFetch('/api/orchestrator/state', {
      method: 'PATCH',
      body: JSON.stringify({ packetId, updates }),
    }) as Record<string, unknown>;

    const mission = (result.mission ?? {}) as Record<string, unknown>;
    const packets = (mission.packets ?? []) as Array<Record<string, unknown>>;
    const packet = packets.find((p) => p.id === packetId);
    return jsonResult({ ok: true, packet, updatedAt: mission.updatedAt });
  } catch (err) {
    return textResult(`Failed to update packet: ${safeErrorText(err)}`, true);
  }
}

async function handleListApprovals(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const sessionKey = args.sessionKey as string | undefined;
    const qs = sessionKey ? `?sessionKey=${encodeURIComponent(sessionKey)}` : '';
    const data = await apiFetch(`/api/panel/approvals${qs}`) as Record<string, unknown>;
    const approvals = (data.approvals ?? []) as Array<Record<string, unknown>>;
    const pending = approvals.filter((a) => a.status === 'pending');
    const summary = pending.map((a) => ({
      id: a.id,
      title: a.title,
      risk: a.risk,
      tool: a.toolName,
      agent: a.agent,
      description: a.description,
      created: a.createdAt,
    }));
    return jsonResult({ pendingCount: pending.length, approvals: summary });
  } catch (err) {
    return textResult(`Failed to fetch approvals: ${safeErrorText(err)}`, true);
  }
}

async function handleProposeSpec(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const packetId = typeof args.packetId === 'string' ? args.packetId.trim() : '';
    if (!packetId) return textResult('packetId is required', true);

    const proposedSpec = typeof args.proposedSpec === 'string' ? args.proposedSpec : '';
    if (!proposedSpec.trim()) return textResult('proposedSpec is required', true);

    const rationale = typeof args.rationale === 'string' ? args.rationale.trim() : '';
    if (!rationale) return textResult('rationale is required', true);

    const result = await apiFetch('/api/orchestrator/propose-spec', {
      method: 'POST',
      body: JSON.stringify({ packetId, proposedSpec, rationale }),
    }) as Record<string, unknown>;

    if (result.ok) {
      const inner = (result.result ?? {}) as Record<string, unknown>;
      const approvalId = typeof inner.approvalId === 'string' ? inner.approvalId : '';
      return jsonResult({
        ok: true,
        approvalId,
        note: 'Spec proposal enqueued. The operator must approve before the spec changes; rejecting leaves the spec untouched. Approved updates apply on the NEXT dispatch of the packet, not in-flight agents.',
      });
    }
    return textResult(`Propose spec failed: ${safeErrorText(result)}`, true);
  } catch (err) {
    return textResult(`Failed to propose spec: ${safeErrorText(err)}`, true);
  }
}

async function handleResolveApproval(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const id = args.id as string;
    const action = args.action as string;
    if (!id || !action) return textResult('id and action are required', true);
    if (action !== 'approve' && action !== 'reject') return textResult('action must be "approve" or "reject"', true);

    const result = await apiFetch('/api/panel/approvals', {
      method: 'POST',
      body: JSON.stringify({ id, action }),
    }) as Record<string, unknown>;

    if (result.ok) {
      return jsonResult({ ok: true, resolved: result.resolved, note: result.note });
    }
    return textResult(`Failed: ${safeErrorText(result)}`, true);
  } catch (err) {
    return textResult(`Failed to resolve approval: ${safeErrorText(err)}`, true);
  }
}

// ── Delegation Handlers ──

async function handleSteerAgent(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const surfaceId = args.surfaceId as string;
    const message = args.message as string;
    if (!surfaceId || !message) return textResult('surfaceId and message are required', true);

    const result = await pollCorrelatedMcpApiMutation<Record<string, unknown>>({
      url: `${API_BASE}/api/runtime/action`,
      authorization: `Bearer ${WS_TOKEN}`,
      body: { action: 'steer', surfaceId, message },
      parseError: (response, payload) => apiError('/api/runtime/action', response.status, JSON.stringify(payload)),
      correlationField: 'clientMutationId',
    });

    if (result.ok) {
      return jsonResult({
        ok: true,
        status: result.status,
        note: result.note,
      });
    }
    return textResult(`Steer failed: ${safeErrorText(result)}`, true);
  } catch (err) {
    return textResult(`Failed to steer agent: ${safeErrorText(err)}`, true);
  }
}

// ── Conversational MCP registration ──

function serversFromDiscreteArgs(args: Record<string, unknown>): ParsedMcpServer[] {
  const transportRaw = typeof args.transport === 'string' ? args.transport.toLowerCase() : 'stdio';
  const transport: 'stdio' | 'http' = transportRaw === 'http' ? 'http' : 'stdio';
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) {
    throw new McpInputError('name is required when configJson is not provided');
  }

  const envRecord: Record<string, string> = {};
  if (args.env && typeof args.env === 'object' && !Array.isArray(args.env)) {
    for (const [key, value] of Object.entries(args.env as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      const trimmedKey = key.trim();
      if (!trimmedKey) continue;
      envRecord[trimmedKey] = value;
    }
  }

  if (transport === 'http') {
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    if (!url) {
      throw new McpInputError('url is required for transport="http"');
    }
    return [{
      name,
      transport: 'http',
      command: url,
      args: [],
      env: envRecord,
      url,
    }];
  }

  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) {
    throw new McpInputError('command is required for transport="stdio"');
  }
  const serverArgs = Array.isArray(args.args)
    ? (args.args as unknown[])
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean)
    : [];

  return [{
    name,
    transport: 'stdio',
    command,
    args: serverArgs,
    env: envRecord,
  }];
}

async function handleRegisterMcp(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const configJson = typeof args.configJson === 'string' ? args.configJson.trim() : '';
    let servers: ParsedMcpServer[];

    if (configJson) {
      const parsed = parseMcpConfigInput(configJson);
      servers = parsed.servers;
      const unnamed = servers.findIndex((server) => !server.name);
      if (unnamed !== -1) {
        const discreteName = typeof args.name === 'string' ? args.name.trim() : '';
        if (!discreteName) {
          return textResult(
            'The pasted config does not include a server name. Re-send with an outer {"mcpServers":{"<name>":{...}}} wrapper, or pass `name` alongside `configJson`.',
            true,
          );
        }
        // Fill in any unnamed single entries using the discrete `name` hint
        servers = servers.map((server) => server.name ? server : { ...server, name: discreteName });
      }
    } else {
      servers = serversFromDiscreteArgs(args);
    }

    const registered: string[] = [];
    const failures: Array<{ name: string; error: string }> = [];

    for (const server of servers) {
      if (!server.name) continue;
      const body = server.transport === 'http'
        ? {
            name: server.name,
            transport: 'http' as const,
            command: server.url ?? server.command,
            args: [],
            env: Object.keys(server.env).length > 0 ? server.env : null,
            enabled: true,
          }
        : {
            name: server.name,
            transport: 'stdio' as const,
            command: server.command,
            args: server.args,
            env: Object.keys(server.env).length > 0 ? server.env : null,
            enabled: true,
          };

      try {
        const payload = await apiFetch('/api/setup/mcp-servers', {
          method: 'POST',
          body: JSON.stringify(body),
        }) as { ok?: boolean };
        if (!payload.ok) {
          failures.push({ name: server.name, error: safeErrorText(payload) });
          continue;
        }
        registered.push(server.name);
      } catch (err) {
        failures.push({ name: server.name, error: safeErrorText(err) });
      }
    }

    if (registered.length === 0) {
      return jsonResult({
        ok: false,
        registered: [],
        failures,
        note: failures.length > 0
          ? `Could not register any MCP server: ${failures.map((f) => `${f.name} — ${f.error}`).join('; ')}`
          : 'No servers were registered. Check the input.',
      }, true);
    }

    // Schedule an orchestrator reload so the next user turn spawns with the
    // new MCP config. Best-effort — the next turn will pick up the new server
    // even if this call fails, because ensureMcpConfig() rebuilds the file
    // on every send. We still want to surface a UI banner on success.
    let reloadScheduled = false;
    let reloadError: string | null = null;
    try {
      const reloadBody = await apiFetch('/api/orchestrator/reload', {
        method: 'POST',
        body: JSON.stringify({
          repoPath: REPO_PATH || undefined,
          registered,
          message: registered.length === 1
            ? `Registered ${registered[0]}. Reloading so the new tools are available...`
            : `Registered ${registered.length} MCP servers. Reloading so the new tools are available...`,
        }),
      }) as { ok?: boolean };
      reloadScheduled = Boolean(reloadBody.ok);
      if (!reloadScheduled) reloadError = safeErrorText(reloadBody);
    } catch (err) {
      reloadError = safeErrorText(err);
    }

    return jsonResult({
      ok: true,
      registered,
      failures: failures.length > 0 ? failures : undefined,
      reloadScheduled,
      reloadError: reloadScheduled ? undefined : reloadError,
      message: registered.length === 1
        ? `Registered ${registered[0]}. ${reloadScheduled ? 'Reloading so the new tools are available — your transcript will resume automatically.' : 'New tools will be available on the next orchestrator turn.'}`
        : `Registered ${registered.length} MCP servers: ${registered.join(', ')}. ${reloadScheduled ? 'Reloading so the new tools are available — your transcript will resume automatically.' : 'New tools will be available on the next orchestrator turn.'}`,
    });
  } catch (err) {
    return textResult(`Failed to register MCP server: ${safeErrorText(err)}`, true);
  }
}

// ── Projects handlers (epic #899) ──
//
// These call the storage layer directly rather than going through HTTP. The
// MCP server runs in its own node process but shares the SQLite file with the
// Next backend; better-sqlite3 + WAL mode is multi-process safe. This keeps
// project mutations atomic and avoids the panel-auth round-trip.

function resolveRoleArg(value: unknown): ProjectRole | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? (trimmed as ProjectRole) : null;
}

async function handleCreateProject(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return textResult('name is required.', true);
    const description = typeof args.description === 'string' ? args.description : null;

    const project = createProject({ name, description });

    const repoIds = Array.isArray(args.repoIds)
      ? args.repoIds.filter((value): value is string => typeof value === 'string' && Boolean(value))
      : [];
    const roles = args.roles;

    for (let index = 0; index < repoIds.length; index += 1) {
      const repoId = repoIds[index];
      let role: ProjectRole | null = null;
      if (Array.isArray(roles)) {
        role = resolveRoleArg(roles[index]);
      } else if (roles && typeof roles === 'object') {
        role = resolveRoleArg((roles as Record<string, unknown>)[repoId]);
      }
      addRepoToProject(project.id, repoId, role, 'manual');
    }

    return jsonResult({ projectId: project.id, slug: project.slug });
  } catch (err) {
    return textResult(`Failed to create project: ${safeErrorText(err)}`, true);
  }
}

async function handleAddRepoToProject(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const projectId = typeof args.projectId === 'string' ? args.projectId : '';
    const repoId = typeof args.repoId === 'string' ? args.repoId : '';
    if (!projectId || !repoId) {
      return textResult('projectId and repoId are required.', true);
    }
    const role = resolveRoleArg(args.role);
    addRepoToProject(projectId, repoId, role, 'manual');
    return jsonResult({ ok: true });
  } catch (err) {
    return textResult(`Failed to add repo: ${safeErrorText(err)}`, true);
  }
}

async function handleRemoveRepoFromProject(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const projectId = typeof args.projectId === 'string' ? args.projectId : '';
    const repoId = typeof args.repoId === 'string' ? args.repoId : '';
    if (!projectId || !repoId) {
      return textResult('projectId and repoId are required.', true);
    }
    const removed = removeRepoFromProject(projectId, repoId);
    return jsonResult({ ok: removed });
  } catch (err) {
    return textResult(`Failed to remove repo: ${safeErrorText(err)}`, true);
  }
}

async function handleSetRepoRole(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const projectId = typeof args.projectId === 'string' ? args.projectId : '';
    const repoId = typeof args.repoId === 'string' ? args.repoId : '';
    if (!projectId || !repoId) {
      return textResult('projectId and repoId are required.', true);
    }
    const role = resolveRoleArg(args.role);
    const link = setRepoRole(projectId, repoId, role);
    if (!link) {
      return textResult('Project repo link not found.', true);
    }
    return jsonResult({ ok: true });
  } catch (err) {
    return textResult(`Failed to set role: ${safeErrorText(err)}`, true);
  }
}

async function handleListProjects(): Promise<McpToolResult> {
  try {
    const projects = listProjects();
    return jsonResult({ projects });
  } catch (err) {
    return textResult(`Failed to list projects: ${safeErrorText(err)}`, true);
  }
}

async function handleDeleteProject(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const projectId = typeof args.projectId === 'string' ? args.projectId : '';
    if (!projectId) return textResult('projectId is required.', true);
    const deleted = deleteProject(projectId);
    return jsonResult({ ok: deleted });
  } catch (err) {
    return textResult(`Failed to delete project: ${safeErrorText(err)}`, true);
  }
}

// ── AI suggestions (epic #899 wave 2) ──

async function handleSuggestProjects(): Promise<McpToolResult> {
  try {
    const result = await suggestProjects();
    return jsonResult(result);
  } catch (err) {
    return textResult(`Failed to compute suggestions: ${safeErrorText(err)}`, true);
  }
}

async function handleRefreshProjectSuggestions(): Promise<McpToolResult> {
  try {
    const result = await suggestProjects({ force: true });
    return jsonResult(result);
  } catch (err) {
    return textResult(`Failed to refresh suggestions: ${safeErrorText(err)}`, true);
  }
}

async function handleCreateProjectFromSuggestion(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const suggestionId = typeof args.suggestionId === 'string' ? args.suggestionId : '';
    if (!suggestionId) return textResult('suggestionId is required.', true);

    const suggestion = getCachedSuggestion(suggestionId);
    if (!suggestion) {
      return textResult(`Suggestion not found: ${suggestionId}. Run cortex_suggest_projects first or refresh the cache.`, true);
    }

    const overrideName = typeof args.name === 'string' ? args.name.trim() : '';
    const project = createProject({
      name: overrideName || suggestion.suggestedName,
      description: suggestion.rationale,
    });

    for (const repoId of suggestion.repoIds) {
      const role = suggestion.detectedRoles[repoId] ?? null;
      addRepoToProject(project.id, repoId, role, 'ai-semantic');
    }

    removeSuggestionFromCache(suggestionId);

    return jsonResult({
      projectId: project.id,
      slug: project.slug,
      memberCount: suggestion.repoIds.length,
    });
  } catch (err) {
    return textResult(`Failed to create project from suggestion: ${safeErrorText(err)}`, true);
  }
}

async function handleDismissProjectSuggestion(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const suggestionId = typeof args.suggestionId === 'string' ? args.suggestionId : '';
    if (!suggestionId) return textResult('suggestionId is required.', true);
    const reason = typeof args.reason === 'string' ? args.reason : null;
    recordDismissedSuggestion(suggestionId, reason);
    const removed = removeSuggestionFromCache(suggestionId);
    return jsonResult({ ok: true, removedFromCache: removed });
  } catch (err) {
    return textResult(`Failed to dismiss suggestion: ${safeErrorText(err)}`, true);
  }
}

async function handleAsk(args: Record<string, unknown>): Promise<McpToolResult> {
  const question = typeof args.question === 'string' ? args.question.trim() : '';
  if (!question) return textResult('question is required.', true);

  const body: Record<string, unknown> = { question };
  if (typeof args.repoPath === 'string' && args.repoPath.trim()) {
    body.repoPath = args.repoPath.trim();
  } else if (REPO_PATH) {
    // Default to the MCP session's bound repo (if launched repo-scoped).
    body.repoPath = REPO_PATH;
  }
  if (typeof args.projectId === 'string' && args.projectId.trim()) {
    body.projectId = args.projectId.trim();
  }
  if (args.bypassCache === true) {
    body.bypassCache = true;
  }

  try {
    const data = await apiFetch('/api/cortex/ask/answer', {
      method: 'POST',
      body: JSON.stringify(body),
    }) as { ok?: boolean; answer?: string; citations?: unknown[]; class?: string; retrievalMs?: number; classifyMs?: number; error?: string };

    if (!data?.ok) {
      return textResult(`cortex_ask error: ${safeErrorText(data)}`, true);
    }

    return jsonResult({
      answer: data.answer ?? '',
      citations: data.citations ?? [],
      class: data.class ?? null,
      retrievalMs: data.retrievalMs ?? null,
      classifyMs: data.classifyMs ?? null,
    });
  } catch (err) {
    return textResult(`cortex_ask failed: ${safeErrorText(err)}`, true);
  }
}

const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  cortex_fleet_status: handleFleetStatus,
  cortex_list_issues: handleListIssues,
  cortex_list_prs: handleListPrs,
  cortex_ci_status: handleCiStatus,
  cortex_read_packets: handleReadPackets,
  cortex_update_packet: handleUpdatePacket,
  cortex_list_approvals: handleListApprovals,
  cortex_resolve_approval: handleResolveApproval,
  cortex_propose_spec: handleProposeSpec,
  lane_touches: handleLaneTouches,
  cortex_worker_catalog: handleWorkerCatalog,
  cortex_wait_workers: handleWaitWorkers,
  cortex_launch_agent: handleLaunchAgent,
  cortex_shared_team_status: handleSharedTeamStatus,
  cortex_finish_shared_team: handleFinishSharedTeam,
  cortex_reconcile_shared_team: handleReconcileSharedTeam,
  cortex_steer_agent: handleSteerAgent,
  cortex_correct_workers: handleCorrectWorkers,
  cortex_read_transcript: handleReadTranscript,
  cortex_interrupt_agent: handleInterruptAgent,
  register_mcp: handleRegisterMcp,
  cortex_create_project: handleCreateProject,
  cortex_add_repo_to_project: handleAddRepoToProject,
  cortex_remove_repo_from_project: handleRemoveRepoFromProject,
  cortex_set_repo_role: handleSetRepoRole,
  cortex_list_projects: handleListProjects,
  cortex_delete_project: handleDeleteProject,
  cortex_suggest_projects: handleSuggestProjects,
  cortex_refresh_project_suggestions: handleRefreshProjectSuggestions,
  cortex_create_project_from_suggestion: handleCreateProjectFromSuggestion,
  cortex_dismiss_project_suggestion: handleDismissProjectSuggestion,
  cortex_ask: handleAsk,
};

// ── JSON-RPC Server ──

function send(msg: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleMessage(msg: JsonRpcRequest): Promise<void> {
  const projected = await deferredMcpRequest(msg, () => CORTEX_READONLY ? TOOLS.filter(tool => CORTEX_READONLY_TOOLS.has(tool.name)) : TOOLS);
  if (projected.response) { send(projected.response); return; }
  msg = projected.message;
  const { method, id, params } = msg;

  // Notifications (no id) — just acknowledge
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'o8', version: '1.0.0' },
        },
      });
      break;

    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        // Read-only profile advertises ONLY the allowlisted read tools — the
        // dispatch/mutator tools (launch_agent, steer_agent, …) never reach a
        // Collide proposer's MCP config in the first place.
        result: { tools: CORTEX_READONLY ? TOOLS.filter((t) => CORTEX_READONLY_TOOLS.has(t.name)) : TOOLS },
      });
      break;

    case 'tools/call': {
      const toolName = (params as Record<string, unknown>)?.name as string;
      const toolArgs = ((params as Record<string, unknown>)?.arguments ?? {}) as Record<string, unknown>;
      // Fail-closed: even if a client calls a non-advertised tool by name, a
      // read-only server rejects anything outside the allowlist (#1075).
      if (CORTEX_READONLY && !CORTEX_READONLY_TOOLS.has(toolName)) {
        send({ jsonrpc: '2.0', id, result: textResult(`Tool '${toolName}' is not available in read-only mode.`, true) });
        break;
      }
      const handler = TOOL_HANDLERS[toolName];
      if (!handler) {
        send({ jsonrpc: '2.0', id, result: textResult(`Unknown tool: ${toolName}`, true) });
        break;
      }
      try {
        const result = await handler(toolArgs);
        send({ jsonrpc: '2.0', id, result });
      } catch (err) {
        send({ jsonrpc: '2.0', id, result: textResult(`Tool error: ${safeErrorText(err)}`, true) });
      }
      break;
    }

    default:
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
  }
}

// ── Main Loop ──

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line) as JsonRpcRequest;
    handleMessage(msg).catch((err) => {
      if (msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: safeErrorText(err) } });
      }
    });
  } catch {
    // Malformed JSON — ignore
  }
});

rl.on('close', () => process.exit(0));
