// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LiveBackend, LiveSession } from '@/lib/voice/managed-live/session';

const fixture = vi.hoisted(() => ({ backend: null as LiveBackend | null, socket: null as EventTarget | null,
  close: vi.fn(), invoke: vi.fn(), listeners: new Map<string, (event: { payload: Record<string, unknown> }) => void>() }));
vi.mock('@/components/desktop/thoughts/use-orchestrator-stream/shared', () => ({ openOrchestratorWebSocket: () => fixture.socket }));
vi.mock('@/lib/tauri/bridge', () => ({ canUseTauriEvents: () => true }));
vi.mock('@/lib/mobile/ws-token-client', () => ({ getMobileWsToken: () => 'fixture' }));
vi.mock('@/lib/tauri/events', () => ({ subscribeTauriEvent: (name: string, callback: (event: { payload: Record<string, unknown> }) => void) => {
  fixture.listeners.set(name, callback); return () => fixture.listeners.delete(name);
} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixture.invoke }));
vi.mock('@/lib/voice/managed-live/symon-backend', () => ({ subscribeManagedSymonConfirmation: () => () => {} }));
vi.mock('@/lib/voice/managed-live/session', () => ({ startManagedLive: vi.fn(async (backend: LiveBackend, state: (value: string) => void) => {
  await backend.ready?.(); fixture.backend = backend; state('live');
  return { close: async () => { fixture.close(); state('closed'); }, state: 'live', usage: {} } as unknown as LiveSession;
}) }));
import { ChatLiveHost } from './ChatLiveHost';
import { managedChatVoiceTargets } from '@/lib/voice/managed-live/chat-targets';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let hostId = '';
let posted: Array<{ kind?: string; payload?: Record<string, unknown>; action?: string }>;
const target = { binding: 'chat', nonce: 'nonce', threadId: 'thread', repoPath: '/repo' };
async function frame(payload: Record<string, unknown>) {
  await act(async () => {
    fixture.socket!.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'ui-command', kind: 'voice-host-state', payload: { hostId, ...payload } }) }));
  });
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  (window as Window & { __O8_VOICE_HOST__?: boolean }).__O8_VOICE_HOST__ = true;
  fixture.backend = null; fixture.socket = Object.assign(new EventTarget(), { close: vi.fn() }); fixture.close.mockReset(); fixture.invoke.mockReset(); posted = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    posted.push(body);
    if (body.action === 'ready') hostId = body.hostId;
    return Response.json(url === '/api/voice/live' ? { byokAvailable: true } : { ok: true });
  }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(createElement(ChatLiveHost)));
  await act(async () => fixture.socket!.dispatchEvent(new Event('open')));
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
  // Each fixture closes its standalone owner before a subsequent host mounts.
  Object.assign(managedChatVoiceTargets, { owner: null });
});
it('starts without a composer and speaks only the correlated authoritative terminal', async () => {
  await frame({ action: 'start', ...target, source: 'byok' });
  expect(fixture.backend?.source).toBe('byok');
  const update = vi.fn(async () => {}); const submitted = vi.fn();
  let completion!: Promise<void>;
  await act(async () => { completion = fixture.backend!.delegate('Check the build', 'delegate', update, submitted); });
  expect(posted).toContainEqual(expect.objectContaining({ kind: 'voice-delegate', payload: expect.objectContaining({ ...target, delegationId: 'delegate', text: 'Check the build' }) }));
  const second = vi.fn(async () => {});
  await act(async () => { await fixture.backend!.delegate('Also change another file', 'second', second); });
  expect(posted.filter(item => item.kind === 'voice-delegate')).toHaveLength(1);
  expect(second).toHaveBeenCalledWith(expect.stringContaining('have not changed the task'));
  await frame({ action: 'accepted', ...target, nonce: 'old', delegationId: 'delegate', userMessageId: 'wrong' });
  expect(submitted).not.toHaveBeenCalled();
  await frame({ action: 'accepted', ...target, delegationId: 'delegate', userMessageId: 'user' });
  expect(submitted).toHaveBeenCalledWith('user');
  await frame({ action: 'terminal', ...target, voiceTerminal: { userMessageId: 'other', outcome: 'completed', text: 'Wrong result' } });
  expect(update).not.toHaveBeenCalledWith('Wrong result', true);
  await frame({ action: 'terminal', ...target, voiceTerminal: { userMessageId: 'user', outcome: 'unconfirmed', text: 'Partial' } });
  expect(update).not.toHaveBeenCalledWith('Partial', true);
  await frame({ action: 'terminal', ...target, voiceTerminal: { userMessageId: 'user', outcome: 'completed', text: 'Verified build' } });
  await completion;
  expect(update).toHaveBeenCalledWith('Verified build');
  await frame({ action: 'stop', ...target }); expect(fixture.close).toHaveBeenCalledOnce();
});
it('relays the native gate identity visibly and calls its existing exact decision command', async () => {
  const gate = { confirmationId: 'gate', taskId: 'task', tool: 'write', summary: 'Confirm write', expiresAt: Date.now() + 60_000 };
  await act(async () => fixture.listeners.get('o8:agent-confirm')!({ payload: gate }));
  expect(posted).toContainEqual(expect.objectContaining({ kind: 'voice-host-state', payload: expect.objectContaining({ action: 'confirmation', confirmation: { ...gate, source: 'native' } }) }));
  await frame({ action: 'decision', confirmationId: 'unknown', allow: true }); expect(fixture.invoke).not.toHaveBeenCalled();
  await frame({ action: 'decision', confirmationId: 'gate', allow: false });
  expect(fixture.invoke).toHaveBeenCalledWith('agent_confirm_exact', { confirmationId: 'gate', taskId: 'task', allow: false });
});
