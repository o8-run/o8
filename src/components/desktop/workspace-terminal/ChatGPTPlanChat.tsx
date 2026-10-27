'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { planConnectionRequest } from '@/lib/chatgpt-plan/client';
import type { PlanStatus } from '@/lib/chatgpt-plan/types';
import type { LLMMessage, ModelOption } from '@/components/desktop/llm-chat/shared';
import { streamAssistantResponse } from '@/components/desktop/llm-chat/streaming';
import { OPEN_SETTINGS_TAB_EVENT } from '@/lib/desktop/events';
import { ChatGPTPlanChatView } from './ChatGPTPlanChatView';

interface ChatView {
  generation: number;
  status: PlanStatus | null;
  modelId: string;
  input: string;
  messages: LLMMessage[];
  stream: string;
  busy: boolean;
  notice: string | null;
}
function emptyView(generation: number): ChatView {
  return { generation, status: null, modelId: '', input: '', messages: [], stream: '', busy: false, notice: null };
}
const noop = () => {};

/** Explicit text-only plan requests; no repository, tools, fallback, or extra turns. */
export function ChatGPTPlanChat({ tabId, active = true }: { tabId: string; active?: boolean }) {
  const auth = useO8Auth();
  const owner = auth.isLoaded && auth.signedIn ? auth.user?.id ?? null : null;
  const identity = useRef({ owner, generation: 0 });
  if (identity.current.owner !== owner) identity.current = { owner, generation: identity.current.generation + 1 };
  const epoch = identity.current.generation;
  const [storedView, setView] = useState<ChatView>(() => emptyView(epoch));
  const view = storedView.generation === epoch ? storedView : emptyView(epoch);
  const request = useRef<{ generation: number; controller: AbortController } | null>(null);
  const connection = useRef<{ generation: number; key: string } | null>(null);
  const current = useCallback((generation: number) => identity.current.owner !== null && identity.current.generation === generation, []);
  const write = useCallback((generation: number, change: (value: ChatView) => ChatView) => {
    if (!current(generation)) return;
    setView((previous) => current(generation) ? change(previous.generation === generation ? previous : emptyView(generation)) : previous);
  }, [current]);
  const load = useCallback(async (generation: number) => {
    if (!current(generation)) return null;
    const status = await planConnectionRequest() as unknown as PlanStatus;
    if (!current(generation)) return null;
    const key = JSON.stringify([status.activeId, status.selection?.accountId, status.selection?.generation, status.selection?.desktopEpoch]);
    if (connection.current?.generation === generation && connection.current.key !== key) {
      request.current?.controller.abort(); request.current = null;
      const next = ++identity.current.generation;
      connection.current = { generation: next, key };
      write(next, () => ({ ...emptyView(next), status, modelId: status.models[0]?.id ?? '', notice: 'The ChatGPT connection changed. This conversation was cleared. Review the connection before sending again.' }));
      return null;
    }
    connection.current = { generation, key };
    write(generation, (previous) => ({ ...previous, status, modelId: previous.modelId || status.models[0]?.id || '', notice: status.modelLoadError ?? null }));
    return status;
  }, [current, write]);

  useEffect(() => {
    const generation = identity.current.generation;
    setView(emptyView(generation));
    const refresh = (next: number) => void load(next).catch((error: unknown) => write(next, (previous) => ({ ...previous, notice: error instanceof Error ? error.message : 'ChatGPT could not be reached.' })));
    if (owner) refresh(generation);
    const changed = () => {
      request.current?.controller.abort(); request.current = null;
      const next = ++identity.current.generation;
      setView(emptyView(next));
      if (identity.current.owner) refresh(next);
    };
    window.addEventListener('o8:chatgpt-plan-changed', changed);
    return () => {
      window.removeEventListener('o8:chatgpt-plan-changed', changed);
      request.current?.controller.abort(); request.current = null;
      identity.current.generation += 1;
    };
  }, [owner, load, write]);

  const send = async (generation: number) => {
    if (!current(generation) || request.current || view.busy || !view.input.trim() || !view.modelId || !view.status?.planEnabled) return;
    const controller = new AbortController();
    const attempt = { generation, controller }; request.current = attempt;
    const input = view.input.trim();
    write(generation, (previous) => ({ ...previous, busy: true, notice: null, stream: '' }));
    try {
      // Recheck disconnection/selection before a billed request, never route elsewhere.
      const status = await load(generation);
      if (!current(generation) || controller.signal.aborted) return;
      const selected = status?.models.find((model) => model.id === view.modelId);
      if (status?.planEnabled && !selected) throw new Error('The selected plan model is no longer available. Choose an available model and send again.');
      if (!status?.planEnabled || !status.selection || status.activeId !== view.status.activeId || !selected) throw new Error('The ChatGPT connection changed. Review the connection and send again.');
      const model: ModelOption = { id: `chatgpt:${selected.id}`, label: selected.label, provider: 'chatgpt', backend: 'api', color: 'var(--t-text)', description: 'ChatGPT plan' };
      const userMessage: LLMMessage = { id: crypto.randomUUID(), role: 'user', content: input, timestamp: Date.now() };
      write(generation, (previous) => ({ ...previous, messages: [...previous.messages, userMessage], input: previous.input === view.input ? '' : previous.input }));
      const result = await streamAssistantResponse({ controller, model, messageForModel: input, messages: view.messages, tabId, planSelection: status.selection, planTextOnly: true, approvedToolsSet: new Set(), disableTools: true, preferredRepo: null, linkedIssue: null, showTypingIndicator: false, onPendingApproval: noop, onThinking: noop, onToolCalls: noop, onTypingIndicatorChange: noop, onStreamContent: (stream) => { if (!controller.signal.aborted) write(generation, (previous) => ({ ...previous, stream })); } });
      if (controller.signal.aborted || !current(generation)) return;
      write(generation, (previous) => ({ ...previous, messages: [...previous.messages, result.assistantMessage], stream: '' }));
    } catch (error) {
      write(generation, (previous) => ({ ...previous, notice: controller.signal.aborted ? 'Request stopped.' : error instanceof Error ? error.message : 'The ChatGPT request failed.' }));
    } finally {
      if (request.current === attempt) request.current = null;
      write(generation, (previous) => ({ ...previous, busy: false }));
    }
  };

  return <ChatGPTPlanChatView
    active={active}
    signedIn={Boolean(owner)}
    loading={!auth.isLoaded || Boolean(owner && !view.status && !view.notice)}
    status={view.status}
    modelId={view.modelId}
    input={view.input}
    messages={view.messages}
    stream={view.stream}
    busy={view.busy}
    notice={view.notice}
    onSignIn={auth.signIn}
    onOpenConnection={() => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_TAB_EVENT, { detail: { tab: 'models' } }))}
    onModelChange={(modelId) => write(epoch, (previous) => ({ ...previous, modelId }))}
    onInputChange={(input) => write(epoch, (previous) => ({ ...previous, input }))}
    onSend={() => { void send(epoch); }}
    onStop={() => { if (current(epoch) && request.current?.generation === epoch) request.current.controller.abort(); }}
  />;
}
