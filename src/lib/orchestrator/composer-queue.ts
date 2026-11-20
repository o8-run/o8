import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { isNetworkThread } from '@/lib/bots/network-store';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { isOrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { validateComposerImageAttachments, composerBackendSupportsImages } from '@/lib/mobile/composer-image-validation';
import { isOrchestratorServiceTier } from './service-tier';
import { isThinkingEffort } from './thinking-effort';
import { isComposerWireMode } from './composer-wire';
import { assertOrchestratorPermissionMode, isOrchestratorPermissionMode } from './permission-mode';
import { type ComposerMention, type ComposerQueuePayload, type ComposerQueueTarget, type QueuedComposerSendRecord } from './composer-queue-types';
import { ensureThreadScratch, threadScratchPath } from './thread-scratch';
import { composerOwnerRequest } from './composer-owner-client';
import type { ComposerWsIngress } from '@/lib/ws-server/composer-owner-rpc';

/** Durable keys remain addressable even if a checkout is offline. */
export function composerQueueRepoKey(repoPath: string): string {
  try { return realpathSync(repoPath); } catch { return resolve(repoPath); }
}

export function validateComposerQueueTarget(input: unknown, requireSaved = true): ComposerQueueTarget {
  const target = input as Partial<ComposerQueueTarget> | null;
  const scratch = noProjectScratch(target, requireSaved);
  if (scratch) return scratch;
  if (!target || typeof target.repoPath !== 'string' || !target.repoPath.startsWith('/') || target.repoPath.length > 4096
    || typeof target.threadId !== 'string' || !/^thoughts-[A-Za-z0-9_-]{1,80}$/.test(target.threadId)) throw new Error('A valid repository and chat are required.');
  if (isNetworkThread(target.threadId)) throw new Error('Network threads send through the agent bus, not the orchestrator queue.');
  const history = readPersistedLlmChat(target.threadId);
  if ((!history?.history.repoPath && requireSaved) || (history?.history.repoPath && composerQueueRepoKey(history.history.repoPath) !== composerQueueRepoKey(target.repoPath))) throw new Error('The queued message must target its saved chat repository.');
  return { repoPath: requireSaved ? realpathSync(target.repoPath) : composerQueueRepoKey(target.repoPath), threadId: target.threadId };
}

/** A saved chat with no project sends from its own scratch folder, never a repository. */
function noProjectScratch(target: Partial<ComposerQueueTarget> | null, requireSaved: boolean): ComposerQueueTarget | null {
  if (!target || typeof target.threadId !== 'string' || !/^thoughts-[A-Za-z0-9_-]{1,80}$/.test(target.threadId)
    || isNetworkThread(target.threadId)) return null;
  // Clients send no repository; a queued item carries the scratch folder it resolved to.
  if (target.repoPath !== undefined && target.repoPath !== null && target.repoPath !== ''
    && (typeof target.repoPath !== 'string' || composerQueueRepoKey(target.repoPath) !== composerQueueRepoKey(threadScratchPath(target.threadId)))) return null;
  const history = readPersistedLlmChat(target.threadId);
  if (!history || history.history.repoPath) return null;
  return { repoPath: requireSaved ? ensureThreadScratch(target.threadId) : composerQueueRepoKey(threadScratchPath(target.threadId)), threadId: target.threadId };
}

const MENTION_KINDS = ['worktree', 'script', 'terminal'];
const text = (value: unknown, max: number, empty = false): value is string =>
  typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0);

/**
 * A message's pills as saved: well-formed ones only, at most 20. Pills are
 * display state, so a malformed one is dropped rather than failing the send;
 * a terminal pill carrying terminal output is malformed.
 */
export function validateComposerMentions(input: unknown): ComposerMention[] | undefined {
  if (input === undefined) return undefined;
  const all: unknown[] = Array.isArray(input) ? input : [input];
  const kept = all.flatMap((value): ComposerMention[] => {
    const mention = value as Partial<ComposerMention> | null;
    const jump = mention?.jump;
    if (!mention || !text(mention.label, 200) || !text(mention.title, 4096)
      || !Array.isArray(mention.lines) || mention.lines.length > 6 || !mention.lines.every(line => text(line, 400, true))
      || (mention.open !== undefined && !text(mention.open, 200))
      || (jump !== undefined && (!jump || !MENTION_KINDS.includes(jump.kind) || !text(jump.target, 4096)))
      || (jump?.kind === 'terminal' && mention.lines.length > 0)) return [];
    return [{ label: mention.label, title: mention.title, lines: [...mention.lines],
      ...(mention.open !== undefined ? { open: mention.open } : {}),
      ...(jump ? { jump: { kind: jump.kind, target: jump.target } } : {}) }];
  }).slice(0, 20);
  if (kept.length < all.length) console.warn(`[composer-queue] Dropped ${all.length - kept.length} mention(s) that could not be saved.`);
  return kept;
}

export function validateComposerQueuePayload(input: unknown): ComposerQueuePayload {
  const payload = input as Partial<ComposerQueuePayload> | null;
  const routing = payload?.routing;
  if (!payload || typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 200_000
    || typeof payload.wireMessage !== 'string' || !payload.wireMessage.trim() || payload.wireMessage.length > 250_000
    || !routing || !isOrchestratorBackendId(routing.backend) || typeof routing.model !== 'string' || (routing.model !== '' && !routing.model.trim()) || routing.model.length > 500
    || !isThinkingEffort(routing.effort) || (routing.serviceTier !== undefined && !isOrchestratorServiceTier(routing.serviceTier)) || !isOrchestratorPermissionMode(routing.permissionMode)
    || !['single', 'fleet', 'fusion'].includes(routing.mode) || !isComposerWireMode(routing.pickedMode)
    || typeof routing.collide !== 'boolean' || (routing.projectId !== undefined && (typeof routing.projectId !== 'string' || routing.projectId.length > 256))) throw new Error('The queued message needs a complete routing snapshot.');
  assertOrchestratorPermissionMode(routing.collide && routing.mode !== 'single' ? 'collide' : routing.backend, routing.permissionMode);
  const images = validateComposerImageAttachments(payload.images);
  if ((payload.afterTaskId !== undefined && (typeof payload.afterTaskId !== 'string'
    || !/^[A-Za-z0-9_-]{1,160}$/.test(payload.afterTaskId) || routing.pinBackend !== true))
    || (routing.pinBackend !== undefined && routing.pinBackend !== true)
    || (routing.pinBackend && routing.collide)) throw new Error('A bound follow-up requires an exact task and runtime.');
  if (routing.handoffMode !== undefined && routing.handoffMode !== 'handoff') throw new Error('Unknown handoff mode.');
  if (images.length && !composerBackendSupportsImages(routing.backend)) throw new Error('The selected runtime cannot receive these images.');
  const mentions = validateComposerMentions(payload.mentions);
  return { text: payload.text, wireMessage: payload.wireMessage,
    ...(mentions?.length ? { mentions } : {}),
    ...(payload.afterTaskId ? { afterTaskId: payload.afterTaskId } : {}),
    images: images.map(image => ({ name: image.name ?? 'Image', dataUri: image.dataUri })),
    routing: { backend: routing.backend, model: routing.model, effort: routing.effort,
      ...(routing.pinBackend ? { pinBackend: true as const } : {}),
      ...(routing.handoffMode ? { handoffMode: routing.handoffMode } : {}),
      permissionMode: routing.permissionMode, mode: routing.mode, pickedMode: routing.pickedMode,
      collide: routing.collide, ...(routing.serviceTier ? { serviceTier: routing.serviceTier } : {}), ...(routing.projectId ? { projectId: routing.projectId } : {}) } };
}

/** All queue rows are owned by o8d. Validation remains with the existing callers. */
export async function readComposerSend(id: string): Promise<QueuedComposerSendRecord | null> {
  return (await composerOwnerRequest('get', { id })).item;
}
export async function listQueuedComposerSends(target?: ComposerQueueTarget, options: { withoutImages?: boolean } = {}): Promise<QueuedComposerSendRecord[]> {
  return (await composerOwnerRequest('list', { ...(target ? { target } : {}), ...(options.withoutImages ? { withoutImages: true } : {}) })).items;
}
export async function listComposerQueueTargets(): Promise<ComposerQueueTarget[]> {
  return (await composerOwnerRequest('listTargets', {})).targets;
}
export async function enqueueComposerSendReceipt(input: ComposerQueueTarget & {
  id: string; intent: QueuedComposerSendRecord['intent']; payload: unknown;
}, ingress?: ComposerWsIngress) {
  if (!['send-next', 'steer-now'].includes(input.intent) || typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(input.id)) throw new Error('A valid queue identity is required.');
  const target = validateComposerQueueTarget(input);
  const payload = validateComposerQueuePayload(input.payload);
  return composerOwnerRequest('enqueue', { id: input.id, target, intent: input.intent,
    payloadJson: JSON.stringify(payload), ...(ingress ? { ingress } : {}) });
}
export async function enqueueComposerSend(input: ComposerQueueTarget & {
  id: string; intent: QueuedComposerSendRecord['intent']; payload: unknown;
}): Promise<QueuedComposerSendRecord> {
  return (await enqueueComposerSendReceipt(input)).item;
}
/** Held messages fence only work that was already waiting when the hold happened. */
export async function peekNextComposerSend(target: ComposerQueueTarget): Promise<QueuedComposerSendRecord | null> {
  return nextComposerSend(await listQueuedComposerSends(target));
}
/** Next deliverable row from one listed target; held rows block older work. */
export function nextComposerSend(items: QueuedComposerSendRecord[]): QueuedComposerSendRecord | null {
  let heldAt = -Infinity;
  const first = items.find(item => {
    if (item.status !== 'held') return true;
    heldAt = Math.max(heldAt, item.updatedAt);
    return false;
  });
  return first && heldAt < first.createdAt ? first : null;
}
export function claimNextComposerSend(target: ComposerQueueTarget) {
  return composerOwnerRequest('claim', { target, intent: 'send-next' });
}
export async function promoteComposerSend(target: ComposerQueueTarget, id: string): Promise<QueuedComposerSendRecord> {
  return (await composerOwnerRequest('promote', { target, id })).item;
}
export function claimComposerSteer(id: string) {
  return composerOwnerRequest('claim', { id, intent: 'steer-now' });
}
export async function deferComposerSteer(id: string, reason: string, claimToken: string): Promise<boolean> {
  return (await composerOwnerRequest('deferSteer', { id, reason, claimToken })).changed;
}
export async function listComposerTranscriptSends(target: ComposerQueueTarget): Promise<QueuedComposerSendRecord[]> {
  return (await composerOwnerRequest('listTranscript', { target })).items;
}
export async function assertComposerSendClaim(id: string, claimToken: string): Promise<void> {
  if (!(await composerOwnerRequest('assertClaim', { id, claimToken })).live) throw new Error('The queued message was cancelled or held before execution.');
}
export async function admitComposerSend(id: string, claimToken: string): Promise<boolean> {
  return (await composerOwnerRequest('admit', { id, claimToken })).changed;
}
export async function settleComposerSend(id: string, outcome: { status: 'applied' | 'held'; reason?: string }, claimToken: string): Promise<boolean> {
  return (await composerOwnerRequest('settle', { id, claimToken, ...outcome })).changed;
}
export async function cancelComposerSend(target: ComposerQueueTarget, id: string): Promise<boolean> {
  return (await composerOwnerRequest('cancel', { target, id })).changed;
}
/** Operator Stop is intentionally target-wide; executor failures never use it. */
export async function holdComposerSends(target: ComposerQueueTarget): Promise<void> {
  await composerOwnerRequest('hold', { target });
}
