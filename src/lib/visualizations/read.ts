import 'server-only';
import { resolveRequestPrincipalContext, type RequestPrincipalContext } from '@/lib/auth/principal';
import path from 'node:path';
import { findLatestLaneByPacket } from '@/lib/lane/registry';
import { resolveRegisteredRepoScope } from '@/lib/llm/repo-scope';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { ORCHESTRATOR_THREAD_ID_PATTERN } from '@/lib/task-artifacts/types';
import { visualizationFailure, visualizationResponse } from './http';
import { getVisualization, getVisualizationMetadata, listVisualizations } from './store';
import type { VisualizationDocument } from './types';
import { VISUALIZATION_ID } from './types';
import { VisualizationError } from './errors';

// Reads retain packet ownership checks without loading publication/preview code.
function validateRead(id: string, principal: RequestPrincipalContext): void {
  if (principal.role !== 'operator' && principal.role !== 'worker') throw new VisualizationError('unauthorized', 'Visualization access requires an operator or packet worker credential.', 401);
  if (!VISUALIZATION_ID.test(id)) throw new VisualizationError('not_found', 'Visualization not found.', 404);
}

function authorizeRead<T extends { packetId: string | null }>(document: T | null, principal: RequestPrincipalContext): T {
  if (!document || (principal.role === 'worker' && (principal.readOnly || !principal.packetId || principal.packetId !== document.packetId))) {
    throw new VisualizationError('not_found', 'Visualization not found.', 404);
  }
  return document;
}

export function readVisualization(id: string, principal: RequestPrincipalContext): VisualizationDocument {
  validateRead(id, principal);
  return authorizeRead(getVisualization(id), principal);
}

export function readVisualizationMetadata(id: string, principal: RequestPrincipalContext) {
  validateRead(id, principal);
  return authorizeRead(getVisualizationMetadata(id), principal);
}

export interface VisualizationTarget {
  repoPath: string;
  threadId: string | null;
  packetId: string | null;
  assetRoot: string;
}

function string(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }

export async function resolveVisualizationTarget(input: Record<string, unknown>, principal: RequestPrincipalContext): Promise<VisualizationTarget> {
  const packetId = string(input.packetId);
  const threadId = string(input.threadId);
  const repoPath = string(input.repoPath);
  if (principal.role !== 'operator' && principal.role !== 'worker') throw new VisualizationError('unauthorized', 'Visualization access requires an operator or packet worker credential.', 401);
  if (principal.role === 'worker') {
    if (principal.readOnly || !principal.packetId || threadId || (packetId && packetId !== principal.packetId) || repoPath) {
      throw new VisualizationError('forbidden', 'A packet worker may address only its own packet.', 403);
    }
  }
  const targetPacket = principal.role === 'worker' ? principal.packetId : packetId;
  if (targetPacket) {
    if (threadId) throw new VisualizationError('invalid_target', 'Provide one transcript target.');
    const lane = findLatestLaneByPacket(targetPacket);
    if (!lane) throw new VisualizationError('not_found', 'The packet workspace was not found.', 404);
    return { repoPath: lane.repoPath, threadId: null, packetId: targetPacket, assetRoot: lane.worktreePath ?? lane.repoPath };
  }
  if (!ORCHESTRATOR_THREAD_ID_PATTERN.test(threadId)) throw new VisualizationError('invalid_target', 'Provide an orchestrator threadId and its repoPath.');
  const scope = await resolveRegisteredRepoScope(repoPath);
  if (!scope.repoRoot) throw new VisualizationError('invalid_target', 'The visualization workspace must be a registered project.');
  const thread = readPersistedLlmChat(threadId);
  if (thread?.history.repoPath && path.resolve(thread.history.repoPath) !== path.resolve(scope.repoRoot)) {
    throw new VisualizationError('invalid_target', 'The thread belongs to another workspace.', 403);
  }
  return { repoPath: scope.repoRoot, threadId, packetId: null, assetRoot: scope.repoRoot };
}

export async function listTranscriptVisualizations(input: Record<string, unknown>, principal: RequestPrincipalContext) {
  return listVisualizations(await resolveVisualizationTarget(input, principal));
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const visualizations = await listTranscriptVisualizations(Object.fromEntries(url.searchParams), resolveRequestPrincipalContext(request));
    return visualizationResponse({ visualizations });
  } catch (error) { return visualizationFailure(error); }
}
