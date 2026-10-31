/**
 * Adapted from T3 Code (https://github.com/pingdotgg/t3code),
 * apps/server/src/orchestration-v2/Orchestrator.ts, commit
 * f58fad04162165653bf06f0c987bbfb0074a8a4b.
 * Copyright (c) 2026 T3 Tools Inc.; MIT; see licenses/t3code-MIT.txt.
 * Adapted for o8: existing operator PATCH, workspace checks and canonical lock.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { persistCanonicalChatHistoryRecord, readPersistedLlmChat, withCanonicalChatHistoryLock } from '@/lib/llm/chat-history-store';
import { matchesMutationWorkspace, mutationWorkspace } from '@/lib/repos/mutation-workspace';
import { assertInboxCanSettle, InboxMutationError, runtimeInboxIdentity, observeAgentInboxRun } from './subjects';
import { isInboxPreferenceAction, legacyInboxPin, validInboxOrderKey, type InboxPreferenceCommand } from './preferences';
import { inboxProjection, inboxSubject, mutateInboxPreferences, mutateInboxSettlement } from './store';

export async function patchInboxSettlement(request: NextRequest, body: Record<string, unknown>) {
  const action = body.inboxAction;
  const preference = isInboxPreferenceAction(action);
  const allowed = ['tabId', 'sessionKey', 'inboxAction', ...(preference ? ['inboxRevision'] : []),
    ...(['pin', 'pin-reorder', 'active-reorder'].includes(String(action)) ? ['orderKey'] : []),
    ...(action === 'auto-settle' ? ['enabled'] : [])];
  const hasChat = typeof body.tabId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(body.tabId);
  const hasRuntime = typeof body.sessionKey === 'string' && /^[A-Za-z0-9_-]+:[^\s\x00-\x1f]{1,500}$/.test(body.sessionKey);
  if ((!preference && action !== 'settle' && action !== 'unsettle') || hasChat === hasRuntime
    || (hasChat && body.sessionKey !== undefined) || (hasRuntime && body.tabId !== undefined)
    || Object.keys(body).some(key => !allowed.includes(key))
    || (preference && (!Number.isSafeInteger(body.inboxRevision) || (body.inboxRevision as number) < 0))
    || (body.orderKey !== undefined && !validInboxOrderKey(body.orderKey))
    || (['pin-reorder', 'active-reorder'].includes(String(action)) && body.orderKey === undefined)
    || (action === 'auto-settle' && typeof body.enabled !== 'boolean')) {
    return NextResponse.json({ error: 'Provide one target, a supported inboxAction, its arguments and an inboxRevision for preference changes.' }, { status: 400 });
  }
  try {
    const workspace = mutationWorkspace(request);
    const inventory = await getRuntimeInventorySnapshot({ fresh: true });
    if (hasRuntime) {
      const agent = inventory.agents.find(candidate => candidate.sessionKey === body.sessionKey);
      if (!agent) throw new InboxMutationError('Subject was not found.', 404);
      const identity = runtimeInboxIdentity(agent);
      if (!matchesMutationWorkspace(workspace, identity.inboxSubject.workspace)) throw new InboxMutationError('Subject was not found.', 404);
      if (identity.parentInboxSubject) throw new InboxMutationError('Worker is a child of a conversation. Organize its parent conversation.', 409);
      const activity = await observeAgentInboxRun(agent, identity.inboxSubject, true);
      if (preference) {
        mutateInboxPreferences(identity.inboxSubject, { action, orderKey: body.orderKey, enabled: body.enabled } as InboxPreferenceCommand, state => {
          assertPreferenceRevision(state, body);
          const current = runtimeInboxIdentity(agent);
          if (current.parentInboxSubject || JSON.stringify(current.inboxSubject) !== JSON.stringify(identity.inboxSubject)) {
            throw new InboxMutationError('Runtime subject changed. Reload before organizing it.', 409);
          }
        });
      } else mutateInboxSettlement(identity.inboxSubject, action as 'settle' | 'unsettle', () => {
        const current = runtimeInboxIdentity(agent);
        if (current.parentInboxSubject || JSON.stringify(current.inboxSubject) !== JSON.stringify(identity.inboxSubject)) {
          throw new InboxMutationError('Runtime subject changed. Reload before organizing it.', 409);
        }
        if (action === 'settle') assertInboxCanSettle(identity.inboxSubject, inventory.agents, activity);
      });
      return NextResponse.json({ ok: true, ...inboxProjection(identity.inboxSubject) });
    }
    const tabId = body.tabId as string;
    return withCanonicalChatHistoryLock(tabId, () => {
      const saved = readPersistedLlmChat(tabId);
      const record = saved?.history as (NonNullable<typeof saved>['history'] & { projectId?: string; pinned?: boolean; archivedAt?: string | null }) | undefined;
      if (!record || !matchesMutationWorkspace(workspace, record.repoPath)) throw new InboxMutationError('History was not found.', 404);
      const subject = inboxSubject('conversation', tabId, record.repoPath, record.projectId);
      if (preference) {
        mutateInboxPreferences(subject, { action, orderKey: body.orderKey, enabled: body.enabled } as InboxPreferenceCommand, state => {
          assertPreferenceRevision(state, body);
          if (record.archivedAt) throw new InboxMutationError('Archived threads cannot be organized.', 409);
          if ((action === 'pin' && !record.pinned) || (action === 'unpin' && record.pinned)) {
            persistCanonicalChatHistoryRecord(tabId, { ...record, pinned: action === 'pin' });
          }
        }, legacyInboxPin(record));
      } else mutateInboxSettlement(subject, action as 'settle' | 'unsettle', () => {
        if (action === 'settle') {
          assertInboxCanSettle(subject, inventory.agents);
          if (record.pinned) persistCanonicalChatHistoryRecord(tabId, { ...record, pinned: false });
        }
      }, record.pinned === true);
      return NextResponse.json({ ok: true, ...inboxProjection(subject, null, undefined, legacyInboxPin(record)) });
    });
  } catch (error) {
    if (error instanceof InboxMutationError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[inbox] Mutation failed', error);
    return NextResponse.json({ error: 'Unable to update inbox metadata.' }, { status: 500 });
  }
}

function assertPreferenceRevision(state: { inboxRevision?: number; pinnedAt?: string | null; settledOverride: string | null }, body: Record<string, unknown>): void {
  if ((state.inboxRevision ?? 0) !== body.inboxRevision) throw new InboxMutationError('Inbox revision changed. Reload before organizing it.', 409);
  if (body.inboxAction === 'pin-reorder' && !state.pinnedAt) throw new InboxMutationError('Thread is not pinned.', 409);
  if (body.inboxAction === 'active-reorder' && (state.pinnedAt || state.settledOverride === 'settled')) {
    throw new InboxMutationError('Thread is not active.', 409);
  }
}
/** Existing boolean PATCH callers share the same pin state; no new transcript is created. */
export function recordLegacyInboxPin(tabId: string, record: { repoPath?: string; projectId?: unknown; pinned?: unknown; savedAt?: unknown }, pinned: boolean, persist: () => void): void {
  mutateInboxPreferences(inboxSubject('conversation', tabId, record.repoPath, record.projectId),
    { action: pinned ? 'pin' : 'unpin' }, persist, legacyInboxPin(record));
}
