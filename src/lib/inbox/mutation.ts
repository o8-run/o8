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
import { inboxProjection, inboxSubject, mutateInboxSettlement } from './store';

export async function patchInboxSettlement(request: NextRequest, body: Record<string, unknown>) {
  const action = body.inboxAction;
  const hasChat = typeof body.tabId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(body.tabId);
  const hasRuntime = typeof body.sessionKey === 'string' && /^[A-Za-z0-9_-]+:[^\s\x00-\x1f]{1,500}$/.test(body.sessionKey);
  if ((action !== 'settle' && action !== 'unsettle') || hasChat === hasRuntime
    || (hasChat && body.sessionKey !== undefined) || (hasRuntime && body.tabId !== undefined)
    || Object.keys(body).some(key => !['tabId', 'sessionKey', 'inboxAction'].includes(key))) {
    return NextResponse.json({ error: 'Provide one tabId or sessionKey and inboxAction: settle or unsettle.' }, { status: 400 });
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
      mutateInboxSettlement(identity.inboxSubject, action, () => {
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
      const record = saved?.history as (NonNullable<typeof saved>['history'] & { projectId?: string; pinned?: boolean }) | undefined;
      if (!record || !matchesMutationWorkspace(workspace, record.repoPath)) throw new InboxMutationError('History was not found.', 404);
      const subject = inboxSubject('conversation', tabId, record.repoPath, record.projectId);
      mutateInboxSettlement(subject, action, () => {
        if (action === 'settle') {
          assertInboxCanSettle(subject, inventory.agents);
          if (record.pinned) persistCanonicalChatHistoryRecord(tabId, { ...record, pinned: false });
        }
      }, record.pinned === true);
      return NextResponse.json({ ok: true, ...inboxProjection(subject) });
    });
  } catch (error) {
    if (error instanceof InboxMutationError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[inbox] Mutation failed', error);
    return NextResponse.json({ error: 'Unable to update inbox settlement.' }, { status: 500 });
  }
}
