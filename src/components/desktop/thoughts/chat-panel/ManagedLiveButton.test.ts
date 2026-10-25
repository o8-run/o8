/** @vitest-environment jsdom */
import { act, createElement, type ComponentProps } from 'react';
import type { QueuedComposerSendRecord } from '@/lib/orchestrator/composer-queue-types';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { LiveBackend, LiveState } from '@/lib/voice/managed-live/session';
import { useManagedVoicePresentation } from './useManagedVoicePresentation';
import type { VisualInstructionDraft } from '@/lib/composer/visual-draft-store';
import { visualMeaningKey } from '@/lib/composer/visual-meaning';
import { answerVisualQuestion, visualQuestionContext, dismissVisualQuestion } from '@/lib/composer/visual-clarification';
import { sampleObservation } from '@/lib/composer/visual-inspection.test-fixture';
const marked = vi.hoisted(() => ({ draft: null as VisualInstructionDraft | null }));
vi.mock('@/lib/composer/visual-draft-store', () => ({ readVisualDraft: () => marked.draft,
  saveVisualDraft: async (draft: VisualInstructionDraft) => { marked.draft = draft; } }));
const fixture = vi.hoisted(() => ({ backend: null as LiveBackend | null, native: false, invoke: vi.fn() }));
vi.mock('@/lib/tauri/bridge', () => ({ canUseTauriEvents: () => fixture.native, isTauri: () => fixture.native }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixture.invoke }));
vi.mock('@/lib/mobile/ws-token-client', () => ({ getMobileWsToken: () => 'fixture' }));
vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => ({ user: { id: 'fixture' }, isLoaded: true }) }));
vi.mock('@/lib/voice/managed-live/session', () => ({ startManagedLive: async (backend: LiveBackend, onState: (state: string) => void) => {
  await backend.ready?.();
  let state = 'live'; fixture.backend = backend; onState(state); return { get state() { return state; }, close: async () => { state = 'closed'; onState(state); }, activity() {} };
} }));
import { ManagedLiveButton as VoiceButton } from './ManagedLiveButton';
import { ManagedChatVoiceEntry } from './ManagedChatVoiceEntry';
import { voiceFollowupReceipt } from './managed-voice-followup';
const queues = new Map<string, QueuedComposerSendRecord[]>();
const saved = vi.fn();
function ManagedLiveButton(props: ComponentProps<typeof VoiceButton>) {
  return createElement(VoiceButton, { ...props, followup: {
    ready: true, items: queues.get(props.binding) ?? [],
    enqueue: async (id, text, afterTaskId) => {
      saved(id, text, afterTaskId, props.binding);
      queues.set(props.binding, [{ id, sequence: 1, threadId: props.binding, repoPath: '/repo', intent: 'send-next',
        status: 'queued', reason: null, createdAt: 1, updatedAt: 1, admittedAt: null,
        payload: { text, wireMessage: text, afterTaskId, images: [], routing: { backend: 'codex', model: 'model',
          effort: 'high', permissionMode: 'plan', mode: 'fleet', pickedMode: 'multitask', collide: false, pinBackend: true } } }]);
      return voiceFollowupReceipt(queues.get(props.binding)![0]);
    },
    cancel: async () => { queues.delete(props.binding); return 'Queued voice follow-up canceled before submission. The running task is unchanged.'; },
  } });
}
let root: Root; let container: HTMLDivElement;
async function chooseManaged() {
  const action = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Start managed voice');
  if (action) await act(async () => action.click());
}
async function toggleVoice() {
  await act(async () => container.querySelector('button')!.click());
  await chooseManaged();
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  queues.clear(); saved.mockClear(); fixture.backend = null; marked.draft = null;
  fixture.native = false; fixture.invoke.mockReset();
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ enabled: true, entitled: true })));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('dismisses the desktop presentation on unknown state or chat unmount without claiming provider closure', async () => {
  vi.useFakeTimers(); fixture.native = true; fixture.invoke.mockResolvedValue(3);
  const stateRef = { current: 'live' as LiveState };
  function Presentation() {
    useManagedVoicePresentation({ state: stateRef.current, stateRef, session: { current: null }, level: { current: 0.5 }, label: 'Fixture chat' });
    return null;
  }
  await act(async () => root.render(createElement(Presentation)));
  expect(fixture.invoke).toHaveBeenLastCalledWith('managed_voice_overlay_update', { presentation: expect.objectContaining({ phase: 'live', dismissed: false }) });
  stateRef.current = 'unknown';
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(fixture.invoke).toHaveBeenLastCalledWith('managed_voice_overlay_update', { presentation: expect.objectContaining({ phase: 'unknown' }) });
  const count = fixture.invoke.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(fixture.invoke).toHaveBeenCalledTimes(count);
  stateRef.current = 'live';
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  await act(async () => root.render(null));
  expect(fixture.invoke).toHaveBeenLastCalledWith('managed_voice_overlay_update', { presentation: expect.objectContaining({ phase: 'live', dismissed: true }) });
  expect(stateRef.current).toBe('live');
  expect(vi.getTimerCount()).toBe(0);
});
it('retains the existing CLI discussion when live captions fill the recent transcript', async () => {
  const props: ComponentProps<typeof VoiceButton> = {
    binding: 'existing-chat', busy: false, terminals: {}, send: vi.fn(), interrupt: vi.fn(),
    messages: [
      { id: 'task', role: 'user', text: 'Check the repository version without changing files.' },
      { id: 'answer', role: 'assistant', text: 'The repository version is 1.2.3.' },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `speech-${i}`, role: 'user' as const, text: `Can you hear me ${i}?`,
        voice: { sessionId: 'voice-one', direction: 'input' as const, revision: 1, startMs: i * 100, endMs: (i + 1) * 100 },
      })),
    ],
  };
  await act(async () => root.render(createElement(ManagedLiveButton, props)));
  await toggleVoice();
  expect(fixture.backend!.context()).toContain('Check the repository version without changing files.');
  expect(fixture.backend!.context()).toContain('The repository version is 1.2.3.');
  expect(fixture.backend!.context()).toContain('Earlier voice exchange');
  expect(props.send).not.toHaveBeenCalled();

  const beforeSpeech = fixture.backend!.context();
  await act(async () => root.render(createElement(ManagedLiveButton, { ...props, messages: [
    ...props.messages, { id: 'live-reply', role: 'assistant', text: 'A new spoken reply.',
      voice: { sessionId: 'voice-two', direction: 'output', revision: 1, startMs: 0, endMs: 100 } },
  ] })));
  expect(fixture.backend!.context()).toBe(beforeSpeech);
  expect(fixture.backend!.context()).not.toContain('A new spoken reply.');
  // Automatic reconnect runs readiness again before opening the new provider
  // session, which needs the just-ended conversation without live caption echo.
  await fixture.backend!.ready?.();
  expect(fixture.backend!.context()).toContain('A new spoken reply.');

  await act(async () => root.render(createElement(ManagedLiveButton, { ...props, messages: [
    ...props.messages, { id: 'next-task', role: 'user', text: 'Now check the package name.' },
  ] })));
  expect(fixture.backend!.context()).toContain('Now check the package name.');
  expect(fixture.backend!.context()).toContain('The repository version is 1.2.3.');
  await act(async () => root.render(createElement(ManagedLiveButton, { ...props,
    messages: props.messages.map(message => ({ ...message, text: message.text.repeat(1000) })),
    terminals: { task: { outcome: 'unconfirmed', text: 'Partial output'.repeat(1000) } },
  })));
  const bounded = fixture.backend!.context();
  expect(bounded.length).toBeLessThanOrEqual(2400);
  expect(bounded).toContain('unconfirmed');
  expect(bounded).toContain('Recent CLI discussion:');
  expect(bounded).toContain('Earlier voice exchange');
});
it('keeps late restored history out of current CLI progress', async () => {
  const props: ComponentProps<typeof VoiceButton> = { binding: 'ordered-chat', busy: false, send: vi.fn(), interrupt: vi.fn(),
    terminals: { current: { outcome: 'completed', text: 'Current result.' } }, messages: [
      { id: 'previous', role: 'user', text: 'Previous request.', timestamp: 10 },
      { id: 'previous-answer', role: 'assistant', text: 'Previous result.', timestamp: 11 },
      { id: 'current', role: 'user', text: 'Current request.', timestamp: 20 },
      { id: 'current-answer', role: 'assistant', text: 'Current result.', timestamp: 21 },
    ] };
  await act(async () => root.render(createElement(ManagedLiveButton, props)));
  await toggleVoice();
  const beforeRestore = fixture.backend!.context();
  await act(async () => root.render(createElement(ManagedLiveButton, { ...props, messages: [...props.messages,
    { id: 'old-task', role: 'user', text: 'An old request.', timestamp: 1 },
    { id: 'old-error', role: 'assistant', text: 'An old backend error.', timestamp: 2 },
  ] })));
  expect(fixture.backend!.context()).toBe(beforeRestore);
  expect(beforeRestore).toContain('completed: Current result.');
});
it('rechecks admission when a mounted composer outlives its test window and can retry after restoration', async () => {
  const fetch = vi.mocked(globalThis.fetch);
  fetch.mockResolvedValueOnce(Response.json({ enabled: true, entitled: true, transport: 'personal-webrtc' }))
    .mockResolvedValueOnce(Response.json({ enabled: false, error: 'personal_voice_unavailable' }, { status: 503 }));
  const props = { binding: 'same-chat', messages: [], busy: false, terminals: {}, send: vi.fn(), interrupt: vi.fn() };
  await act(async () => root.render(createElement(ManagedLiveButton, props)));
  await toggleVoice();
  expect(fixture.backend).toBeNull();
  expect(props.send).not.toHaveBeenCalled();
  expect(container.querySelector('button')!.disabled).toBe(false);
  expect(container.querySelector('button')!.title).toContain('Live voice availability could not be checked');
  expect(fetch.mock.calls.every(([_url, init]) => init?.method !== 'POST')).toBe(true);
  await toggleVoice();
  expect(fixture.backend!.binding).toBe('same-chat');
  expect(container.querySelector('button')!.getAttribute('aria-pressed')).toBe('true');
});
it('projects captions only into their bound chat and links accepted sends without treating voice output as completion', async () => {
  const transcript = vi.fn(); const submitted = vi.fn();
  const props = { key: 'a', binding: 'a', messages: [], busy: false, terminals: {}, transcript, send: vi.fn(() => ({ userMessageId: 'orch-user-a' })), interrupt: vi.fn() };
  await act(async () => root.render(createElement(ManagedLiveButton, props)));
  await toggleVoice();
  const old = fixture.backend!;
  old.transcript!([{ id: 'spoken', role: 'user', text: 'Check this' }]);
  expect(transcript).toHaveBeenCalledOnce();
  void old.delegate('Check this', 'd', vi.fn(async () => {}), submitted);
  expect(submitted).toHaveBeenCalledWith('orch-user-a');
  await act(async () => root.render(createElement(ManagedLiveButton, { ...props, key: 'b', binding: 'b' })));
  old.transcript!([{ id: 'late', role: 'assistant', text: 'Old voice' }]);
  expect(transcript).toHaveBeenCalledOnce();
});
it('serializes same-poll delegations and waits for correlated terminal even if append acknowledgement is delayed or rejected', async () => {
  const send = vi.fn(() => ({ userMessageId: 'user-1' }));
  const props = { binding: 'repo:thread:claude:model', messages: [], busy: false, terminals: {}, send, interrupt: vi.fn() };
  await act(async () => root.render(createElement(ManagedLiveButton, props)));
  await toggleVoice();
  const update = vi.fn(async (): Promise<void> => { throw new Error('append unavailable'); });
  const blocked = vi.fn(async () => {});
  const task = fixture.backend!.delegate('Do this', 'one', update);
  await fixture.backend!.delegate('Another task', 'two', blocked);
  expect(send).toHaveBeenCalledOnce();
  expect(blocked).toHaveBeenCalledWith(expect.stringContaining('cannot apply an immediate correction'));
  // Optimistic ready and a partial assistant bubble are not terminal evidence.
  await act(async () => root.render(createElement(ManagedLiveButton, { ...props, messages: [
    { id: 'user-1', role: 'user', text: 'Do this' }, { id: 'assistant', role: 'assistant', text: 'partial' },
  ] })));
  expect(update).toHaveBeenCalledTimes(1);
  update.mockResolvedValue(undefined);
  await act(async () => root.render(createElement(ManagedLiveButton, { ...props,
    terminals: { 'user-1': { outcome: 'unconfirmed', text: 'partial' } } })));
  await fixture.backend!.delegate('Try again', 'three', blocked);
  expect(send).toHaveBeenCalledOnce();
  expect(update).toHaveBeenLastCalledWith(expect.stringContaining('has not confirmed'));

  await act(async () => root.render(createElement(ManagedLiveButton, { ...props,
    terminals: { 'user-1': { outcome: 'interrupted', text: 'partial' } } })));
  await task;
  expect(update).toHaveBeenLastCalledWith('The backend confirmed interruption.');
});

it('allows voice restart when the app remounts with the new binding key', async () => {
  const props = { key: 'repo:thread:claude:model', binding: 'repo:thread:claude:model', messages: [], busy: false, terminals: {}, send: vi.fn(), interrupt: vi.fn() };
  await act(async () => root.render(createElement(ManagedLiveButton, props)));
  await toggleVoice();
  expect(container.querySelector('button')!.getAttribute('aria-pressed')).toBe('true');
  await act(async () => root.render(createElement(ManagedLiveButton, {...props, key:'repo:other-thread:codex:model', binding:'repo:other-thread:codex:model'})));
  await toggleVoice();
  expect(container.querySelector('button')!.disabled).toBe(false);
  expect(fixture.backend!.binding).toBe('repo:other-thread:codex:model');
});

it('offers explicit resume after closure without reconnecting itself', async () => {
  const props = { binding: 'repo:thread:claude:model', messages: [], busy: false, terminals: {}, send: vi.fn(), interrupt: vi.fn() };
  await act(async () => root.render(createElement(ManagedLiveButton, props)));
  await toggleVoice();
  const previous = fixture.backend;
  await toggleVoice();
  expect(container.querySelector('button')!.getAttribute('aria-label')).toBe('Resume managed voice for this conversation');
  expect(fixture.backend).toBe(previous);
  await toggleVoice();
  expect(container.querySelector('button')!.getAttribute('aria-label')).toBe('Disconnect managed voice');
  expect(fixture.backend!.binding).toBe(props.binding);
});

it('persists explicit follow-up consent through the shared queue and never drains it from the voice component', async () => {
  const send = vi.fn().mockReturnValueOnce({userMessageId:'user-one'}).mockReturnValueOnce({userMessageId:'user-two'});
  const props = {binding:'same-thread',messages:[],busy:false,terminals:{},send,interrupt:vi.fn()};
  await act(async()=>root.render(createElement(ManagedLiveButton,props)));
  await toggleVoice();
  const update = vi.fn(async()=>{});
  const first = fixture.backend!.delegate('Start task','first',update);
  await fixture.backend!.delegate('Actually change it','correction',update);
  expect(send).toHaveBeenCalledTimes(1);
  await fixture.backend!.delegate('queue check the tests','follow-up',update);
  expect(update).toHaveBeenLastCalledWith(expect.stringContaining('Saving it does not confirm backend acceptance or completion'));
  const messages = [{id:'user-one',role:'user' as const,text:'Start task'}];
  await act(async()=>root.render(createElement(ManagedLiveButton,{...props,messages,terminals:{'user-one':{outcome:'unconfirmed',text:''}}})));
  expect(send).toHaveBeenCalledTimes(1);
  await toggleVoice();
  await toggleVoice();
  const resumed = vi.fn(async()=>{}); fixture.backend!.subscribe!(resumed);
  await act(async()=>root.render(createElement(ManagedLiveButton,{...props,messages,terminals:{'user-one':{outcome:'completed',text:'Verified original result'}}})));
  await first;
  expect(saved).toHaveBeenCalledWith(expect.stringMatching(/^voice-/), 'check the tests', 'user-one', 'same-thread');
  expect(send).toHaveBeenCalledTimes(1);
  expect(resumed).toHaveBeenCalledWith('Verified original result',true);
  await act(async()=>root.render(createElement(ManagedLiveButton,{...props,messages,terminals:{'user-one':{outcome:'completed',text:'Verified original result'}}})));
  expect(send).toHaveBeenCalledTimes(1); expect(props.interrupt).not.toHaveBeenCalled();
});

it('cancels deliberate queue without interrupting the doer', async () => {
  const props = {binding:'same-thread',messages:[{id:'running',role:'user' as const,text:'Work'}],busy:true,terminals:{},send:vi.fn(),interrupt:vi.fn()};
  await act(async()=>root.render(createElement(ManagedLiveButton,props)));
  await toggleVoice();
  const update=vi.fn(async()=>{});
  await fixture.backend!.delegate('queue next step','queue',update);
  await fixture.backend!.delegate('cancel queued','cancel',update);
  await act(async()=>root.render(createElement(ManagedLiveButton,{...props,busy:false,terminals:{running:{outcome:'completed',text:'done'}}})));
  expect(props.send).not.toHaveBeenCalled(); expect(props.interrupt).not.toHaveBeenCalled();
});

it('does not auto-submit a follow-up after the same utterance withdraws queue consent', async () => {
  const props={binding:'same',messages:[{id:'running',role:'user' as const,text:'Work'}],busy:true,terminals:{},send:vi.fn(()=>({userMessageId:'next'})),interrupt:vi.fn()};
  await act(async()=>root.render(createElement(ManagedLiveButton,props)));
  await toggleVoice();
  await fixture.backend!.delegate('queue check tests, actually do not queue that','q',vi.fn(async()=>{}));
  await act(async()=>root.render(createElement(ManagedLiveButton,{...props,busy:false,terminals:{running:{outcome:'completed',text:'done'}}})));
  expect(props.send).not.toHaveBeenCalled();
});

it('leaves the persisted queue with its originating chat across a keyed remount', async () => {
  const props={key:'a',binding:'a',messages:[{id:'running',role:'user' as const,text:'Work'}],busy:true,terminals:{},send:vi.fn(()=>({userMessageId:'next'})),interrupt:vi.fn()};
  await act(async()=>root.render(createElement(ManagedLiveButton,props)));
  await toggleVoice();
  const oldBackend=fixture.backend!;
  await oldBackend.delegate('queue check tests','q',vi.fn(async()=>{}));
  await act(async()=>root.render(createElement(ManagedLiveButton,{...props,key:'b',binding:'b',busy:false,terminals:{running:{outcome:'completed',text:'done'}}})));
  await toggleVoice();
  expect(fixture.backend!.binding).toBe('b'); expect(props.send).not.toHaveBeenCalled();
  expect(queues.get('a')?.[0].payload.afterTaskId).toBe('running'); expect(queues.get('b')).toBeUndefined();
});

it('does not drain a follow-up when a different user turn owns current conversation', async () => {
  const props={binding:'same',messages:[{id:'running',role:'user' as const,text:'Work'}],busy:true,terminals:{},send:vi.fn(()=>({userMessageId:'next'})),interrupt:vi.fn()};
  await act(async()=>root.render(createElement(ManagedLiveButton,props)));
  await toggleVoice();
  await fixture.backend!.delegate('queue check tests','q',vi.fn(async()=>{}));
  const messages=[...props.messages,{id:'external',role:'user' as const,text:'Other work'}];
  await act(async()=>root.render(createElement(ManagedLiveButton,{...props,messages,busy:false,terminals:{running:{outcome:'completed',text:'done'}}})));
  expect(props.send).not.toHaveBeenCalled();
});


it('Caps Lock uses the focused composer and a second tap closes voice without stopping backend work', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const interrupt = vi.fn();
  const props = { messages: [], busy: false, terminals: {}, send: vi.fn(), interrupt };
  await act(async () => root.render(createElement('div', null,
    ...['first-chat', 'second-chat'].map(binding => createElement('section', { key: binding, 'data-voice-chat-root': true },
      createElement('div', null, 'Transcript'), createElement(ManagedLiveButton, { ...props, binding }), createElement('textarea'))))));
  const buttons = container.querySelectorAll('button');
  await act(async () => container.querySelectorAll('textarea')[1].focus());
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'CapsLock' })));
  await chooseManaged();
  expect(fixture.backend!.binding).toBe('second-chat');
  expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
  expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
  await act(async () => buttons[0].focus());
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'CapsLock', repeat: true })));
  expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'CapsLock' })));
  expect(buttons[1].getAttribute('aria-pressed')).toBe('false');
  expect(interrupt).not.toHaveBeenCalled();
});

it('does not accept a stale delegation after the same chat starts a new voice activation', async () => {
  const send = vi.fn(() => ({ userMessageId: 'new' }));
  const props = { binding: 'same', messages: [], busy: false, terminals: {}, send, interrupt: vi.fn() };
  await act(async () => root.render(createElement(ManagedLiveButton, props)));
  await toggleVoice();
  const old = fixture.backend!;
  await toggleVoice();
  await toggleVoice();
  expect(fixture.backend).not.toBe(old);
  await old.delegate('Late old request', 'old', vi.fn(async () => {}));
  expect(send).not.toHaveBeenCalled();
});

it('invalidates the actual visual pre-dispatch guard when Live closes during a pending save', async () => {
  let release!: () => void; const saving = new Promise<void>(done => { release = done; });
  const dispatched = vi.fn();
  const sendVisual: NonNullable<ComponentProps<typeof VoiceButton>['sendVisual']> = async (_text, _after, sessionCurrent) => {
    await saving;
    if (!sessionCurrent()) throw new Error('Voice closed before dispatch.');
    dispatched(); return null;
  };
  await act(async () => root.render(createElement(ManagedLiveButton, { binding: 'close-during-save', messages: [], terminals: {}, busy: false,
    send: vi.fn(), sendVisual, interrupt: vi.fn() })));
  await toggleVoice();
  const request = fixture.backend!.delegate('Adjust the marked button.', 'visual-request', vi.fn(async () => {})); void request.catch(() => {});
  await toggleVoice();
  release();
  await expect(request).rejects.toThrow('Voice closed before dispatch');
  expect(dispatched).not.toHaveBeenCalled();
});

it('keeps no-key and signed-out voice choices visible and Caps Lock opens the focused chat chooser without starting Live', async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json({ enabled: false, entitled: false, byokAvailable: false }));
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const props = { binding: 'no-key-chat', messages: [], terminals: {}, busy: false, send: vi.fn(), interrupt: vi.fn() };
  await act(async () => root.render(createElement('section', { 'data-voice-chat-root': true }, createElement(ManagedLiveButton, props), createElement('textarea'))));
  expect(fixture.backend).toBeNull();
  await act(async () => container.querySelector('textarea')!.focus());
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'CapsLock' })));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Turn-by-turn · Edge voice');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Browser dictation may require');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Open OpenAI key settings');
  expect(fixture.backend).toBeNull(); expect(props.send).not.toHaveBeenCalled();
});

it('starts personal-key Live only after explicit selection and rechecks the key immediately before connection', async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json({ enabled: false, entitled: false, byokAvailable: true }));
  const props = { binding: 'personal-key-chat', messages: [], terminals: {}, busy: false, send: vi.fn(), interrupt: vi.fn() };
  await act(async () => root.render(createElement(ManagedLiveButton, props)));
  expect(fixture.backend).toBeNull();
  await act(async () => container.querySelector('button')!.click());
  expect(fixture.backend).toBeNull();
  const start = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Start Live with my key')!;
  expect(start.disabled).toBe(false);
  await act(async () => start.click());
  expect(fixture.backend?.source).toBe('byok'); expect(fixture.backend?.binding).toBe('personal-key-chat');
  expect(fetch).toHaveBeenCalledTimes(3); expect(props.send).not.toHaveBeenCalled();
});

it('preserves managed pilot direct start and exposes alternate modes on the same waveform', async () => {
  const props = { binding: 'pilot-chat', messages: [], terminals: {}, busy: false, send: vi.fn(), interrupt: vi.fn() };
  await act(async () => root.render(createElement(ManagedLiveButton, props)));
  await act(async () => container.querySelector('button')!.click());
  expect(fixture.backend?.source).toBe('managed');
  await act(async () => container.querySelector('button')!.click());
  await act(async () => container.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Turn-by-turn');
  expect(container.querySelectorAll('button')).toHaveLength(1);
});

it('keeps personal-key readiness independent when an expired pilot returns 503', async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json({ enabled: false, entitled: false, error: 'personal_voice_unavailable', byokAvailable: true }, { status: 503 }));
  const props = { binding: 'expired-pilot', messages: [], terminals: {}, busy: false, send: vi.fn(), interrupt: vi.fn() };
  await act(async () => root.render(createElement(ManagedLiveButton, props)));
  await act(async () => container.querySelector('button')!.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Start managed voice');
  const start = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Start Live with my key')!;
  expect(start.disabled).toBe(false); await act(async () => start.click());
  expect(fixture.backend?.source).toBe('byok');
});

it('does not fall back to a managed provider when the personal key disappears after the chooser opens', async () => {
  let byokAvailable = true;
  vi.mocked(fetch).mockImplementation(async () => Response.json({ enabled: false, entitled: false, byokAvailable }));
  const props = { binding: 'key-removed', messages: [], terminals: {}, busy: false, send: vi.fn(), interrupt: vi.fn() };
  await act(async () => root.render(createElement(ManagedLiveButton, props)));
  await act(async () => container.querySelector('button')!.click());
  byokAvailable = false;
  const start = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Start Live with my key')!;
  await act(async () => start.click());
  expect(fixture.backend).toBeNull();
  expect(container.querySelector('button')!.title).toContain('personal Live key is unavailable');
  expect(props.send).not.toHaveBeenCalled();
});

it('keeps an explicit personal-key choice from silently reverting to the managed pilot after stop', async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json({ enabled: true, entitled: true, byokAvailable: true }));
  const props = { binding: 'pilot-personal-choice', messages: [], terminals: {}, busy: false, send: vi.fn(), interrupt: vi.fn() };
  await act(async () => root.render(createElement(ManagedLiveButton, props)));
  await act(async () => container.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  const start = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Start Live with my key')!;
  await act(async () => start.click());
  expect(container.querySelector('button')!.getAttribute('aria-label')).toBe('Disconnect personal-key Live');
  expect(container.querySelector('button')!.title).toContain('billed to your key');
  const previous = fixture.backend;
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('button')!.getAttribute('aria-label')).toBe('Continue GPT Live for this conversation');
  await act(async () => container.querySelector('button')!.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(fixture.backend).not.toBe(previous);
  expect(fixture.backend).toMatchObject({ binding: previous!.binding, source: 'byok' });
});

it('selects a matching spoken Ripple option through an active Live delegate without dispatching', async () => {
  const routing = { backend: 'codex' as const, model: 'selected', effort: 'low' as const, permissionMode: 'plan' as const, mode: 'single' as const, pickedMode: 'solo' as const, collide: false };
  const target = { threadId: 'meaning-chat', repoPath: '/fixture' };
  const scope = { principal: 'fixture', target, routing };
  const draft: VisualInstructionDraft = { principal: 'fixture', status: 'draft', template: { text: '', wireMessage: '', images: [], routing },
    request: { version: 1, id: 'spoken-meaning', createdAt: '2026-10-24T12:00:00Z', target, utterance: 'Make it bigger.', frames: [] } };
  draft.meaningCheck = { key: visualMeaningKey(draft), status: 'choice', latencyMs: 1, resolution: { id: 'meaning-choice', kind: 'choice', question: 'What should be bigger?', aodlPath: 'intent.size',
    options: [{ label: 'Button size', value: 'button-size' }, { label: 'Text size', value: 'text-size' }] } };
  marked.draft = draft;
  const send = vi.fn(); const sendVisual = vi.fn(); const reply = vi.fn(async () => {});
  await act(async () => root.render(createElement(ManagedLiveButton, { binding: 'meaning-chat', messages: [], busy: false, terminals: {}, send, sendVisual, interrupt: vi.fn(),
    visualContext: () => visualQuestionContext(scope), answerVisual: text => answerVisualQuestion(scope, text) })));
  await toggleVoice();
  expect(fixture.backend!.context()).toContain('What should be bigger?');
  await act(async () => fixture.backend!.delegate('Text size.', 'spoken-option', reply));
  expect(marked.draft?.meaningCheck).toMatchObject({ status: 'accepted', selectedValue: 'text-size' });
  expect(reply).toHaveBeenCalledWith(expect.stringContaining('has not been sent'));
  expect(send).not.toHaveBeenCalled(); expect(sendVisual).not.toHaveBeenCalled(); expect(saved).not.toHaveBeenCalled();
  marked.draft = null;
});

it.each(['none', 'failure'].flatMap(result => ['draft', 'saved'].map(status => ({ result, status }))))('keeps a late dismissed option out of the real Live send path: $result / $status', async ({ result, status }) => {
  const routing = { backend: 'codex' as const, model: 'selected', effort: 'low' as const, permissionMode: 'plan' as const, mode: 'single' as const, pickedMode: 'solo' as const, collide: false };
  const target = { threadId: 'dismissed-meaning-chat', repoPath: '/fixture' };
  const observation = sampleObservation();
  const draft: VisualInstructionDraft = { principal: 'fixture', status: 'draft', template: { text: '', wireMessage: '[o8-visual-instruction]', images: [], routing },
    request: { version: 1, id: crypto.randomUUID(), createdAt: '2026-10-24T12:00:00Z', target, utterance: 'Make it bigger.',
      frames: [{ id: 'marked-button', atMs: 0, width: 320, height: 280, image: observation.image, observation, strokes: [], pins: [], transcript: '',
        candidates: [{ id: 'button', name: 'Save', role: 'button', rect: [0.1, 0.2, 0.1, 0.1] }] }] } };
  draft.meaningCheck = { key: visualMeaningKey(draft), status: 'choice', latencyMs: 1, resolution: { id: 'dismissed-choice', kind: 'choice', question: 'What should be bigger?', aodlPath: 'intent.size',
    options: [{ label: 'Button size', value: 'button-size' }, { label: 'Text size', value: 'text-size' }] } };
  marked.draft = draft;
  const resolver = vi.fn(async () => result === 'none' ? Response.json({ kind: 'none' }) : Response.json({ error: 'Fixture unavailable' }, { status: 503 }));
  const dispatch = vi.fn(async (_url: unknown, init?: RequestInit) => Response.json({ item: { ...JSON.parse(String(init?.body)), status: 'queued' } }));
  vi.mocked(fetch).mockImplementation(async (url, init) => url === '/api/mobile/ripple/resolve' ? resolver()
    : url === '/api/orchestrator/composer-queue' ? dispatch(url, init) : Response.json({ enabled: true, entitled: true }));
  const send = vi.fn(); const reply = vi.fn(async () => {});
  const queue = { items: [], ready: true, error: null } as unknown as ComponentProps<typeof ManagedChatVoiceEntry>['queue'];
  await act(async () => root.render(createElement(ManagedChatVoiceEntry, { identity: [target.threadId], visualTarget: target, queue,
    capture: () => draft.template, messages: [], busy: false, terminals: {}, send, interrupt: vi.fn() })));
  await toggleVoice();
  await act(async () => dismissVisualQuestion(marked.draft!));
  const { commitVisualInstruction } = await import('@/lib/composer/visual-instruction-commit');
  if (status === 'saved') {
    await act(async () => { await commitVisualInstruction(marked.draft!); });
    dispatch.mockClear();
  }
  await act(async () => { void fixture.backend!.delegate('Text size.', 'late-dismissed-option', reply).catch(() => {}); });
  expect(resolver).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  expect(marked.draft?.request.utterance).toBe('Make it bigger.');
  expect(marked.draft?.meaningCheck?.status).toBe('dismissed');
  expect(reply).toHaveBeenCalledWith(expect.stringContaining(status === 'saved' ? 'No new instruction' : 'has not been sent'));
  if (status === 'draft') {
    await act(async () => { await commitVisualInstruction(marked.draft!); });
    expect(dispatch).toHaveBeenCalledTimes(1);
  }
});

it.each(['none', 'failure'])('requires a composer Send after Live meaning resolution returns %s', async result => {
  const routing = { backend: 'codex' as const, model: 'selected', effort: 'low' as const, permissionMode: 'plan' as const, mode: 'single' as const, pickedMode: 'solo' as const, collide: false };
  const target = { threadId: 'unresolved-meaning-chat', repoPath: '/fixture' };
  const observation = sampleObservation();
  const draft: VisualInstructionDraft = { principal: 'fixture', status: 'draft', template: { text: '', wireMessage: '[o8-visual-instruction]', images: [], routing },
    request: { version: 1, id: crypto.randomUUID(), createdAt: '2026-10-24T12:00:00Z', target, utterance: 'Make it bigger.',
      frames: [{ id: 'marked-button', atMs: 0, width: 320, height: 280, image: observation.image, observation, strokes: [], pins: [], transcript: '',
        candidates: [{ id: 'button', name: 'Save', role: 'button', rect: [0.1, 0.2, 0.1, 0.1] }] }] } };
  marked.draft = draft;
  const resolver = vi.fn(async () => result === 'none' ? Response.json({ kind: 'none' }) : Response.json({ error: 'Fixture unavailable' }, { status: 503 }));
  const dispatch = vi.fn(async (_url: unknown, init?: RequestInit) => Response.json({ item: { ...JSON.parse(String(init?.body)), status: 'queued' } }));
  vi.mocked(fetch).mockImplementation(async (url, init) => url === '/api/mobile/ripple/resolve' ? resolver()
    : url === '/api/orchestrator/composer-queue' ? dispatch(url, init) : Response.json({ enabled: true, entitled: true }));
  const queue = { items: [], ready: true, error: null } as unknown as ComponentProps<typeof ManagedChatVoiceEntry>['queue'];
  const ordinary = vi.fn();
  await act(async () => root.render(createElement(ManagedChatVoiceEntry, { identity: [target.threadId], visualTarget: target, queue,
    capture: () => draft.template, messages: [], busy: false, terminals: {}, send: ordinary, interrupt: vi.fn() })));
  await toggleVoice();
  await act(async () => { void fixture.backend!.delegate('Make it bigger.', 'unresolved-voice-request', vi.fn(async () => {})).catch(() => {}); });
  expect(resolver).toHaveBeenCalledTimes(1);
  expect(dispatch).not.toHaveBeenCalled(); expect(ordinary).not.toHaveBeenCalled();
  expect(marked.draft?.status).toBe('draft');
  const { commitVisualInstruction } = await import('@/lib/composer/visual-instruction-commit');
  await act(async () => { await commitVisualInstruction(marked.draft!); });
  expect(dispatch).toHaveBeenCalledTimes(1);
});
