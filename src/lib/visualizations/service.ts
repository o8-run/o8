import 'server-only';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { RequestPrincipalContext } from '@/lib/auth/principal';
import { findLatestLaneByPacket } from '@/lib/lane/registry';
import { resolveRegisteredRepoScope } from '@/lib/llm/repo-scope';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { ORCHESTRATOR_THREAD_ID_PATTERN } from '@/lib/task-artifacts/types';
import { VisualizationError } from './errors';
import { prepareVisualizationHtml } from './prepare';
import { insertVisualization, latestVisualizationId, listVisualizations } from './store';
import { checkVisualization } from './preflight';
import { visualizationInputSource } from './templates';
import { readVisualizationMetadata } from './read';
import { VISUALIZATION_LIMITS, type VisualizationDocument } from './types';

export { readVisualization, readVisualizationMetadata } from './read';

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

export async function publishVisualization(input: Record<string, unknown>, principal: RequestPrincipalContext) {
  const target = await resolveVisualizationTarget(input, principal);
  const { html, layout } = visualizationInputSource(input);
  const parent = input.revisionOf === undefined ? undefined : readVisualizationMetadata(string(input.revisionOf), principal);
  if (parent && (parent.repoPath !== target.repoPath || parent.threadId !== target.threadId || parent.packetId !== target.packetId)) {
    throw new VisualizationError('invalid_revision_target', 'Revisions must stay in the same transcript and workspace.', 403);
  }
  if (parent && latestVisualizationId(parent.rootId ?? parent.id) !== parent.id) {
    throw new VisualizationError('revision_conflict', 'A newer revision exists. Read it before revising again.', 409);
  }
  const title = string(input.title) || layout?.title || parent?.title || '';
  if (!title || title.length > VISUALIZATION_LIMITS.titleChars) throw new VisualizationError('invalid_title', 'Provide a title of at most 120 characters.');
  const height = input.height === undefined ? VISUALIZATION_LIMITS.defaultHeight : input.height;
  if (typeof height !== 'number' || !Number.isFinite(height) || height < VISUALIZATION_LIMITS.minHeight || height > VISUALIZATION_LIMITS.maxHeight) {
    throw new VisualizationError('invalid_height', 'Height must be between 80 and 1800 pixels.');
  }
  const prepared = await prepareVisualizationHtml(html, target.assetRoot);
  const checked = await checkVisualization(prepared.html);
  const id = `vis-${randomUUID()}`;
  const document: VisualizationDocument = { kind: 'o8-visualization', id, title,
    html: checked.html, height: Math.round(height), repoPath: target.repoPath, threadId: target.threadId,
    packetId: target.packetId, createdAt: new Date().toISOString(), rootId: parent?.rootId ?? parent?.id ?? id,
    ...(parent ? { parentId: parent.id } : {}), version: (parent?.version ?? (parent ? 1 : 0)) + 1,
    source: layout ? { layout } : { html: html as string } };
  insertVisualization(document);
  return { document, warnings: [...prepared.warnings, ...checked.check.diagnostics], check: checked.check };
}

export async function listTranscriptVisualizations(input: Record<string, unknown>, principal: RequestPrincipalContext) {
  return listVisualizations(await resolveVisualizationTarget(input, principal));
}
