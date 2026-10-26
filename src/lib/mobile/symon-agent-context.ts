import { resolve } from 'node:path';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import type { SymonWorkspaceMode } from '@/lib/mobile/symon-agent-registry';
import { isMobileAskEffort, type MobileAskEffort } from '@/lib/mobile/ask-model-routing';

const CONTEXT_BODY_MAX_CHARS = 4_096;
const CURRENT_ROUTE_MAX_CHARS = 160;
const REPO_PATH_MAX_CHARS = 512;
const ACTIVE_SURFACE_MAX_CHARS = 64;
const MODEL_ID_MAX_CHARS = 64;
const DISPLAY_LABEL_PATTERN = /^[A-Za-z0-9 .,_@+()/#&':-]+$/;
const PROMPT_CONTROL_PATTERN =
  /(?:ignore|disregard|override|reveal|repeat|follow)\b.{0,32}\b(?:instructions?|prompt|system|developer|assistant)|(?:system|developer|assistant)\s*:/i;

export interface SymonAgentContext {
  model?: string;
  effort?: MobileAskEffort;
  invalidEffort?: boolean;
  invalidBody?: boolean;
  workspaceMode?: 'o8' | 'code';
  launchKind?: 'repository-catch-up';
  currentRoute?: string;
  sourceRoute?: string;
  repoPath?: string;
  repoName?: string;
  branch?: string;
  threadId?: string;
  sessionKey?: string;
  threadTitle?: string;
  backend?: 'default' | 'openclaw' | 'hermes';
  agentId?: string;
  agentName?: string;
  selectedFile?: string;
  controlTab?: 'fleet' | 'review' | 'changes' | 'activity';
  runStatus?: 'idle' | 'running' | 'review' | 'blocked' | 'failed' | 'done';
  activeSurface?: string;
}

export interface ResolvedSymonAgentScope {
  context: SymonAgentContext;
  workspaceMode: SymonWorkspaceMode;
  repoId: string | null;
  repoPath: string | null;
}

function safeRoute(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const route = value.trim();
  if (!route || route.length > CURRENT_ROUTE_MAX_CHARS) return undefined;
  if (!/^\/[A-Za-z0-9._~()@+/-]*$/.test(route)) return undefined;
  if (route.split('/').some((segment) => segment === '.' || segment === '..')) return undefined;
  return route;
}

function safeRepoPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const repoPath = value.trim();
  if (repoPath.length < 2 || repoPath.length > REPO_PATH_MAX_CHARS) return undefined;
  if (!/^\/[A-Za-z0-9._@+~/-]+$/.test(repoPath) || repoPath.includes('//')) return undefined;
  if (repoPath.split('/').some((segment) => segment === '.' || segment === '..')) return undefined;
  return repoPath;
}

function safeRelativePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const file = value.trim();
  if (!file || file.length > 320 || file.startsWith('/')) return undefined;
  if (!/^[A-Za-z0-9._@+~/-]+$/.test(file) || file.includes('//')) return undefined;
  if (file.split('/').some((segment) => segment === '.' || segment === '..')) return undefined;
  return file;
}

function safeIdentifier(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const identifier = value.trim();
  if (!identifier || identifier.length > maxLength) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._:@+/-]*$/.test(identifier) ? identifier : undefined;
}

function safeBranch(value: unknown): string | undefined {
  const branch = safeIdentifier(value, 128);
  if (!branch || branch.startsWith('/') || branch.includes('//')) return undefined;
  if (branch.includes('..') || branch.includes('@{')) return undefined;
  if (branch.split('/').some((segment) => segment === '.' || segment === '..')) return undefined;
  return branch;
}

function safeDisplayLabel(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = value.trim();
  if (!label || label.length > maxLength || !DISPLAY_LABEL_PATTERN.test(label)) return undefined;
  return PROMPT_CONTROL_PATTERN.test(label) ? undefined : label;
}

function safeSurface(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const surface = value.trim();
  if (!surface || surface.length > ACTIVE_SURFACE_MAX_CHARS) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(surface) ? surface : undefined;
}

export async function readSymonAgentContext(request: Request): Promise<SymonAgentContext> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > CONTEXT_BODY_MAX_CHARS) return { invalidBody: true };
  try {
    const text = await request.text();
    if (!text) return {};
    if (text.length > CONTEXT_BODY_MAX_CHARS) return { invalidBody: true };
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { invalidBody: true };
    const record = body as Record<string, unknown>;
    const repoPath = safeRepoPath(record.repoPath);
    const threadId = safeIdentifier(record.threadId, 160);
    const agentId = safeIdentifier(record.agentId, 128);
    return {
      model: typeof record.model === 'string' && record.model.length <= MODEL_ID_MAX_CHARS
        ? record.model
        : undefined,
      effort: isMobileAskEffort(record.effort) ? record.effort : undefined,
      invalidEffort: record.effort !== undefined && !isMobileAskEffort(record.effort),
      workspaceMode: record.workspaceMode === 'o8' || record.workspaceMode === 'code' ? record.workspaceMode : undefined,
      launchKind: record.launchKind === 'repository-catch-up' ? record.launchKind : undefined,
      currentRoute: safeRoute(record.currentRoute),
      sourceRoute: safeRoute(record.sourceRoute),
      repoPath,
      repoName: repoPath ? safeDisplayLabel(record.repoName, 96) : undefined,
      branch: safeBranch(record.branch),
      threadId,
      sessionKey: safeIdentifier(record.sessionKey, 160),
      threadTitle: threadId ? safeDisplayLabel(record.threadTitle, 160) : undefined,
      backend: record.backend === 'default' || record.backend === 'openclaw' || record.backend === 'hermes' ? record.backend : undefined,
      agentId,
      agentName: agentId ? safeDisplayLabel(record.agentName, 80) : undefined,
      selectedFile: safeRelativePath(record.selectedFile),
      controlTab: record.controlTab === 'fleet' || record.controlTab === 'review' || record.controlTab === 'changes' || record.controlTab === 'activity' ? record.controlTab : undefined,
      runStatus: record.runStatus === 'idle' || record.runStatus === 'running' || record.runStatus === 'review' || record.runStatus === 'blocked' || record.runStatus === 'failed' || record.runStatus === 'done' ? record.runStatus : undefined,
      activeSurface: safeSurface(record.activeSurface),
    };
  } catch {
    return { invalidBody: true };
  }
}

export async function resolveSymonAgentScope(context: SymonAgentContext): Promise<ResolvedSymonAgentScope | null> {
  const workspaceMode: SymonWorkspaceMode = context.workspaceMode === 'code' ? 'code' : 'o8';
  if (workspaceMode !== 'code') return { context, workspaceMode, repoId: null, repoPath: null };
  if (!context.repoPath) return null;
  const repo = await findRepoByLocalPath(context.repoPath);
  if (!repo) return null;
  const repoPath = resolve(repo.localPath);
  return {
    context: { ...context, repoPath, repoName: safeDisplayLabel(repo.name, 96) },
    workspaceMode,
    repoId: repo.id,
    repoPath,
  };
}
