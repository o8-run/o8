// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatMessageList } from './ChatMessageList';
import { createOrchestratorMessageHandler, type CurrentAssistantStreamState } from '../use-orchestrator-stream/socket';
import { deserializeStoredTranscript, serializeTranscriptForStorage } from '@/lib/transcripts/history-serde';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { OrchestratorStreamStatus } from '../use-orchestrator-stream/shared';

vi.mock('@/lib/pretext/hooks', () => ({ usePretextHeight: () => 24 }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

function transcript(backend = 'codex') {
  const messagesRef = { current: [{ id: 'u1', role: 'user', text: 'Check three files' }] as MobileTranscriptEntry[] };
  const statusRef = { current: 'busy' as OrchestratorStreamStatus };
  const currentAssistantRef = { current: null as CurrentAssistantStreamState | null };
  const ws = {} as WebSocket;
  const receive = createOrchestratorMessageHandler({
    currentWs: ws, wsRef: { current: ws }, messagesRef, statusRef, currentAssistantRef,
    captureFirstTurnPlanRef: { current: false }, eventCountRef: { current: 0 }, lastSeqRef: { current: 0 },
    firstTurnPlanChunksRef: { current: [] }, firstTurnPlanStartedRef: { current: false },
    resetEpochRef: { current: 0 }, lastEventAtRef: { current: Date.now() },
    finalizeFirstTurnPlanCapture() {}, flushCurrentAssistant() {}, scheduleFlushCurrentAssistant() {},
    setMessages(update) { messagesRef.current = typeof update === 'function' ? update(messagesRef.current) : update; },
    setStatus(update) { statusRef.current = typeof update === 'function' ? update(statusRef.current) : update; },
  });
  const render = () => act(() => root.render(createElement(ChatMessageList, {
    displayMessages: messagesRef.current, displayWaiting: statusRef.current === 'busy', isOrchestratorMode: true,
    activeTargetLabel: 'Agent', activeTargetColor: 'var(--t-accent)', thoughtsMutedGlass: 'transparent',
    thoughtsElevatedBorder: 'none', thoughtsElevatedShadow: 'none', emptyStateFallback: null,
  })));
  return { messagesRef, render, fire(event: string, data: Record<string, unknown>) {
    receive({ data: JSON.stringify({ channel: 'orchestrator', event, data: { backend, ...data } }) } as MessageEvent);
    render();
  } };
}

it('uses runtime call/result identities for parallel status, readable labels and a serializer round-trip (#4881)', () => {
  const h = transcript();
  const command = 'printf "%s\\n" ' + 'long-command-argument '.repeat(30);
  for (const id of ['one', 'two', 'three']) h.fire('tool-use', { name: 'functions.exec_command', toolUseId: id, args: { cmd: command } });
  expect(h.messagesRef.current.at(-1)?.toolCalls?.map(call => [call.id, call.status])).toEqual([
    ['one', 'running'], ['two', 'running'], ['three', 'running'],
  ]);
  expect(host.textContent).not.toContain('Planning next moves');
  expect(host.textContent).not.toContain('tool activity');
  const summary = host.querySelector('[data-tool-activity] > button')!;
  expect(summary.textContent).toContain('Running');
  h.fire('tool-result', { name: 'functions.exec_command', toolUseId: 'two', output: 'second result' });
  expect(host.querySelector('[data-tool-activity] > button')).toBe(summary);
  h.fire('tool-result', { name: 'functions.exec_command', toolUseId: 'one', output: 'exit 1: failure', isError: true });
  expect(host.textContent).toContain('failed');
  expect(host.textContent).toContain('exit 1: failure');
  expect(host.textContent).not.toContain('Planning');
  h.fire('tool-result', { name: 'functions.exec_command', toolUseId: 'three', output: 'third result' });
  h.fire('status', { status: 'ready' });
  // Serializer coverage only. Completed-turn history reload is tracked in #5015.
  h.messagesRef.current = deserializeStoredTranscript(serializeTranscriptForStorage(h.messagesRef.current));
  h.render();
  expect(h.messagesRef.current.at(-1)?.toolCalls?.map(call => call.id)).toEqual(['one', 'two', 'three']);
  act(() => (host.querySelector('[data-tool-activity] > button') as HTMLButtonElement).click());
  const rows = host.querySelectorAll('button[aria-label$="show detail"]');
  expect(rows).toHaveLength(3);
  act(() => (rows[1] as HTMLButtonElement).click());
  const detail = host.querySelector(`#${rows[1].getAttribute('aria-controls')}`)!;
  const technical = detail.querySelector('details')!;
  expect(technical.open).toBe(false);
  expect(technical.textContent).toContain('functions.exec_command');
  expect(technical.textContent).toContain('Arguments');
  expect([...detail.querySelectorAll('pre')].filter(node => !node.closest('details')).map(node => node.textContent))
    .toEqual([command.trim(), 'second result']);
  expect(host.textContent).toContain(command.trim());
  expect(host.textContent).toContain('second result');
  expect(host.textContent).toContain('two');
  expect(h.messagesRef.current.at(-1)?.toolCalls).toHaveLength(3);
});

it('does not call an unknown phase planning or infer completion from a missing tool status', () => {
  const h = transcript(); h.render();
  expect(host.textContent).not.toContain('Planning');
  h.messagesRef.current = [...h.messagesRef.current, { id: 'unknown', role: 'assistant', text: '', toolCalls: [{ id: 'opaque-id', name: 'mcp__files__inspect_workspace' }] }];
  h.render();
  expect(host.textContent).toContain('unknown');
  expect(host.textContent).not.toContain('Planning');
  expect(host.textContent).not.toContain('opaque-id');
});

it.each(['codex', 'claude', 'o8', 'pi', 'acp', 'hermes', 'openclaw', 'opencode', 'muse', 'fable'])('never shows planning while a tool runs or after its failure (%s)', backend => {
  const h = transcript(backend);
  h.fire('tool-use', { name: 'exec_command', toolUseId: 'call', args: { cmd: 'printf hello' } });
  expect(host.textContent).not.toContain('Planning next moves');
  h.fire('tool-result', { name: 'exec_command', toolUseId: 'call', output: 'failed command', isError: true });
  expect(host.textContent).toContain('failed');
  expect(host.textContent).not.toContain('Planning next moves');
});

it('does not resurrect or duplicate an identified call on replay, or settle it from an unrelated result', () => {
  const h = transcript();
  h.fire('tool-use', { name: 'exec_command', toolUseId: 'call', args: { cmd: 'printf hello' } });
  h.fire('tool-result', { name: 'exec_command', toolUseId: 'call', output: 'hello' });
  h.fire('tool-use', { name: 'exec_command', toolUseId: 'call', args: { cmd: 'printf hello' } });
  h.fire('tool-result', { name: 'exec_command', toolUseId: 'unrelated', output: 'error elsewhere', isError: true });
  expect(h.messagesRef.current.at(-1)?.toolCalls).toHaveLength(1);
  expect(h.messagesRef.current.at(-1)?.toolCalls?.[0]).toMatchObject({ id: 'call', status: 'done', result: 'hello' });
});

it('shows uncertainty when a turn ends without a result, and stops live activity on a runtime failure', () => {
  const h = transcript();
  h.fire('tool-use', { name: 'exec_command', toolUseId: 'call', args: { cmd: 'printf hello' } });
  h.fire('status', { status: 'ready' });
  expect(host.textContent).toContain('unknown');
  expect(host.textContent).not.toContain('Running');
  h.fire('tool-use', { name: 'exec_command', toolUseId: 'next', args: { cmd: 'printf next' } });
  h.fire('error', { error: 'runtime disconnected' });
  expect(host.textContent).toContain('runtime disconnected');
  expect(host.textContent).not.toContain('Running');
  expect(host.textContent).not.toContain('Planning');
});

it('renders cancellation from Stop and keeps the next turn waiting independently of old tools', () => {
  const h = transcript();
  h.messagesRef.current = [...h.messagesRef.current, { id: 'stopped', role: 'assistant', text: '',
    toolCalls: [{ id: 'stopped-call', name: 'exec_command', status: 'stopped', args: { cmd: 'sleep 90' } }] }];
  h.render();
  expect(host.textContent).toContain('Cancelled');
  h.messagesRef.current = [...h.messagesRef.current, { id: 'next-user', role: 'user', text: 'Next request' }];
  h.render();
  expect(host.textContent).toContain('Waiting for response');
});
