import 'server-only';
import { randomUUID } from 'node:crypto';
import type { RequestPrincipalContext } from '@/lib/auth/principal';
import { VisualizationError } from './errors';
import { prepareVisualizationHtml } from './prepare';
import { insertVisualization, latestVisualizationId } from './store';
import { checkVisualization } from './preflight';
import { visualizationInputSource } from './templates';
import { readVisualizationMetadata, resolveVisualizationTarget } from './read';
import { VISUALIZATION_LIMITS, type VisualizationDocument } from './types';

export { readVisualization, readVisualizationMetadata, resolveVisualizationTarget, listTranscriptVisualizations } from './read';
export type { VisualizationTarget } from './read';

function string(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }

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
