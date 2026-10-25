// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sampleObservation } from '@/lib/composer/visual-inspection.test-fixture';
import type { VisualInstructionDraft } from '@/lib/composer/visual-draft-store';
import { claimVisualCapture, releaseVisualCapture } from '@/lib/composer/visual-capture-state';
import { DictationHost } from '@/components/desktop/dictation/DictationHost';
import type { DictationStartOptions, DictationState } from '@/components/desktop/dictation/types';
const test = vi.hoisted(() => ({ principal: 'a', rows: new Map<string, VisualInstructionDraft>(), listeners: new Set<() => void>(), hold: null as Promise<void> | null,
  removal: null as Promise<void> | null, remove: vi.fn(), receipt: null as Promise<void> | null, receiptEdit: null as (() => void) | null,
  dictation: 'idle' as DictationState, words: null as DictationStartOptions | null, cancel: vi.fn() }));
vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => ({ user: { id: test.principal }, isLoaded: true }) }));
vi.mock('@/lib/tauri/bridge', () => ({ canUseTauriEvents: () => false, isTauri: () => false }));
vi.mock('@/components/desktop/thoughts/InputButtons', () => ({
  InputButtons: ({ inlineLeadingExtras }: { inlineLeadingExtras?: React.ReactNode }) => React.createElement('div', null, inlineLeadingExtras), RepoTargetChip: () => null,
}));
vi.mock('@/components/desktop/dictation/useDictation', () => ({ useDictation: () => ({
  snapshot: { state: test.dictation, audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' },
  start: async (options: DictationStartOptions) => { test.words = options; test.dictation = 'recording'; },
  stopAndSubmit: () => {}, cancel: test.cancel,
}) }));
vi.mock('@/components/desktop/dictation/useNativeDictation', () => ({ isNativeDictationAvailable: () => false, useNativeDictation: () => ({ snapshot: { state: 'idle' } }) }));
vi.mock('@/components/desktop/dictation/DictationPill', () => ({ DictationPill: () => null }));
vi.mock('@/components/desktop/dictation/useSymonEditBridge', () => ({ useSymonEditBridge: () => {} }));
vi.mock('@/lib/tts/dictation-barge-in', () => ({ stopPlaybackForDictation: () => false }));
vi.mock('@/components/desktop/thoughts/chat-panel/SlashCommandPicker', () => ({ SlashCommandPicker: () => null }));
vi.mock('@/components/desktop/thoughts/chat-panel/ComposerStatusBar', () => ({ ComposerStatusBar: () => null }));
const inference = vi.hoisted(() => ({ route: vi.fn(), provider: vi.fn() }));
vi.mock('@/lib/cortex/qa/llm/inference-route', () => ({ resolveOpenRouterRoute: inference.route }));
vi.mock('@/lib/composer/visual-draft-store', () => ({
  readVisualDraft: (principal: string) => test.rows.get(principal) ?? null,
  subscribeVisualDrafts: (listener: () => void) => { test.listeners.add(listener); return () => test.listeners.delete(listener); },
  restoreVisualDraft: async () => {}, removeVisualDraft: async () => { await test.remove(); await test.removal; test.rows.delete('a'); test.listeners.forEach(listener => listener()); },
  saveVisualDraft: async (draft: VisualInstructionDraft) => {
    test.rows.set(draft.principal, draft); test.listeners.forEach(listener => listener());
    if (draft.status === 'draft' && draft.meaningCheck) {
      const edit = test.receiptEdit; test.receiptEdit = null;
      if (edit) queueMicrotask(edit);
      await test.receipt;
    }
    if (draft.status === 'saving') await test.hold;
  },
}));
const { VisualComposerArea } = await import('./VisualComposerArea');
const { POST: resolveRipple } = await import('@/app/api/mobile/ripple/resolve/route');
const target = { threadId: 'thoughts-a', repoPath: '/project' };
const sample = (): VisualInstructionDraft => ({ principal: 'a', status: 'draft', template: {
  text: '[o8-visual-instruction]', wireMessage: '[o8-visual-instruction]', images: [],
  routing: { backend: 'codex', model: 'selected', effort: 'low', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false } },
  request: { version: 1, id: 'request-a', createdAt: '2026-10-19T12:00:00Z', target, utterance: 'Keep this button.',
    frames: [{ id: 'frame-a', atMs: 0, width: 80, height: 60, transcript: '', strokes: [], pins: [], image: { name: 'frame.png', dataUri: 'data:image/png;base64,iVBORw0KGgo=' } }] } });
let root: Root; let node: HTMLDivElement;
const fetcher = vi.fn<typeof fetch>();
const ordinarySend = vi.fn();
const ordinaryChange = vi.fn();
async function dictate() {
  await act(async () => {
    node.querySelector('textarea')!.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
  });
}
function mount(scope = 'chat-a') { root.render(React.createElement(DictationHost, null, React.createElement(VisualComposerArea, {
  visual: { active: true, target, label: 'current chat', capture: () => sample().template },
  activeComposer: true, dictationScopeKey: scope, showBrain: false, input: 'Unsent ordinary message', onInputChange: ordinaryChange, isOrchestratorMode: true,
  displayWaiting: false, chatMessages: [], activeTargetLabel: 'Codex', targetAgentExists: true, thoughtsBodyBackground: 'var(--t-chat-surface-bg)',
  enhancing: false, preEnhanceInput: null, onEnhance: () => {}, onUndoEnhance: () => {}, onSubmit: ordinarySend, onSlashCommand: () => {},
  modelLabel: 'Codex', effort: 'low', onEffortChange: () => {}, adaptiveEnabled: false, displayMessagesCount: 0, hasAssistantActivity: false,
}))); }
const send = () => node.querySelector<HTMLButtonElement>('[data-testid="composer-send-control"]')!;
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  test.principal = 'a'; test.rows.clear(); test.rows.set('a', sample()); test.hold = null; test.removal = null; test.receipt = null; test.receiptEdit = null; test.remove.mockClear(); test.listeners.clear(); fetcher.mockReset();
  inference.route.mockReset(); inference.provider.mockReset();
  inference.route.mockResolvedValue({ url: 'https://model.example.test/resolve', headers: {}, via: 'direct' });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', (url: RequestInfo | URL, options?: RequestInit) => {
    if (url === '/api/mobile/ripple/resolve') return resolveRipple(new NextRequest('http://localhost/api/mobile/ripple/resolve', { ...options, signal: options?.signal ?? undefined }));
    if (url === 'https://model.example.test/resolve') return inference.provider(url, options);
    if (url === '/api/orchestrator/visual-inspection') return Promise.resolve(Response.json({ status: 'unavailable' }));
    return options?.method === 'POST' ? fetcher(url, options) : Promise.resolve(Response.json({}));
  });
  ordinarySend.mockClear(); localStorage.clear(); node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  ordinaryChange.mockClear(); test.cancel.mockClear(); test.dictation = 'idle'; test.words = null;
  await act(async () => mount());
});
afterEach(async () => { await act(async () => { releaseVisualCapture('capture'); root.unmount(); }); node.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('does not dispatch the old principal after a pending durable save', async () => {
  let release!: () => void; test.hold = new Promise<void>(done => { release = done; });
  await act(async () => send().click()); test.principal = 'b'; await act(async () => mount());
  await act(async () => release());
  expect(fetcher).not.toHaveBeenCalled(); expect(test.rows.get('a')?.status).toBe('draft');
  expect(test.rows.get('b')).toBeUndefined();
});
it('leaves a known rejected request editable with its actual frame retained', async () => {
  fetcher.mockResolvedValueOnce(Response.json({ error: 'Selected runtime unavailable.' }, { status: 400 }));
  await act(async () => send().click());
  expect(test.rows.get('a')).toMatchObject({ status: 'draft', error: 'Selected runtime unavailable.' });
  expect(node.querySelector<HTMLTextAreaElement>('textarea[aria-label="Visual instruction"]')?.disabled).toBe(false);
  expect(test.rows.get('a')?.request.frames).toHaveLength(1);
});
it('retains an ambiguous dispatch and only retries its original identity', async () => {
  fetcher.mockRejectedValueOnce(new Error('Response lost'));
  await act(async () => send().click());
  expect(test.rows.get('a')?.status).toBe('unknown'); expect(node.textContent).toContain('Check delivery');
  expect(node.querySelector<HTMLTextAreaElement>('textarea[aria-label="Visual instruction"]')?.disabled).toBe(true);
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).id).toBe('visual-request-a');
  fetcher.mockResolvedValueOnce(Response.json({ error: 'Runtime became unavailable.' }, { status: 400 }));
  await act(async () => send().click());
  expect(test.rows.get('a')?.status).toBe('unknown');
  expect(fetcher.mock.calls[1][1]?.body).toBe(fetcher.mock.calls[0][1]?.body);
});
it('cannot send or clear a draft while its next frame is still recording or transcribing', async () => {
  await act(async () => claimVisualCapture('capture', 'a', target, 'request-a'));
  expect(send().disabled).toBe(true);
  expect(node.querySelector<HTMLButtonElement>('[aria-label="Discard visual draft"]')?.disabled).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});
it('locks the marked draft until confirmed discard finishes persisting', async () => {
  let release!: () => void;
  test.removal = new Promise<void>(done => { release = done; });
  await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Discard visual draft"]')!.click());
  const button = (text: string) => [...node.querySelectorAll('button')].find(value => value.textContent === text)!;
  await act(async () => button('Discard').click());
  expect(test.remove).toHaveBeenCalledTimes(1);
  expect(node.querySelector('textarea')!.disabled).toBe(true);
  expect(send().disabled).toBe(true);
  expect(button('Keep draft').disabled).toBe(true);
  await act(async () => { button('Discard').click(); send().click(); });
  expect(test.remove).toHaveBeenCalledTimes(1);
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => release());
  expect(node.querySelector('textarea')!.value).toBe('Unsent ordinary message');
});
it('retains an editable visual draft when confirmed discard cannot persist', async () => {
  test.remove.mockRejectedValueOnce(new Error('Draft storage is unavailable.'));
  await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Discard visual draft"]')!.click());
  await act(async () => [...node.querySelectorAll('button')].find(value => value.textContent === 'Discard')!.click());
  expect(node.textContent).toContain('Draft storage is unavailable.');
  expect(node.querySelector('textarea')!.value).toBe('Keep this button.');
  expect(node.querySelector('textarea')!.disabled).toBe(false);
  expect(test.rows.get('a')?.request.frames).toHaveLength(1);
  expect(fetcher).not.toHaveBeenCalled();
});
it('uses one actual composer, preserves the ordinary draft on close, and resumes its marked draft', async () => {
  expect(node.querySelectorAll('textarea')).toHaveLength(1);
  expect(node.querySelector('textarea')?.value).toBe('Keep this button.');
  await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Close visual draft"]')?.click());
  expect(node.querySelectorAll('textarea')).toHaveLength(1);
  expect(node.querySelector('textarea')?.value).toBe('Unsent ordinary message');
  expect(test.rows.get('a')?.request.frames).toHaveLength(1);
  await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Resume visual instruction"]')?.click());
  expect(node.querySelector('textarea')?.value).toBe('Keep this button.');
  expect(ordinarySend).not.toHaveBeenCalled();
});
it('sends through the shared composer Enter path and returns to the preserved ordinary input only after acknowledgement', async () => {
  fetcher.mockImplementationOnce(async (_url, init) => { const body = JSON.parse(String(init?.body)); return Response.json({ item: { ...body, status: 'queued' } }); });
  await act(async () => node.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(fetcher).toHaveBeenCalledTimes(1); expect(ordinarySend).not.toHaveBeenCalled();
  expect(node.querySelectorAll('textarea')).toHaveLength(1);
  expect(node.querySelector('textarea')?.value).toBe('Unsent ordinary message');
  expect(test.rows.get('a')?.status).toBe('saved');
  expect(node.textContent).toContain('queued in this chat');
});

it('coalesces Send and deliberate voice delegation into the same frozen queue request', async () => {
  const { commitVisualInstruction } = await import('@/lib/composer/visual-instruction-commit');
  let release!: (response: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise(done => { release = done; }));
  const draft = test.rows.get('a')!;
  await act(async () => send().click());
  const voice = commitVisualInstruction(draft);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const accepted = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
  await act(async () => { release(Response.json({ item: { ...accepted, status: 'queued' } })); await voice; });
  expect(fetcher).toHaveBeenCalledTimes(1); expect(test.rows.get('a')?.status).toBe('saved');
  expect(accepted.payload.images).toEqual(draft.request.frames.map(frame => frame.image));
});

it('delivers composer dictation to the visible marked draft without changing the ordinary draft or submitting', async () => {
  await dictate();
  await act(async () => test.words!.onComplete('Make it smaller.'));
  expect(test.rows.get('a')?.request.utterance).toBe('Keep this button. Make it smaller.');
  expect(ordinaryChange).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});
it.each(['close visual', 'switch chat'])('rejects late dictation when its visible draft changes: %s', async change => {
  await dictate();
  const recording = test.words!;
  if (change === 'close visual') await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Close visual draft"]')!.click());
  else await act(async () => mount('chat-b'));
  await act(async () => recording.onComplete('Late words for an old draft.'));
  expect(test.cancel).toHaveBeenCalled(); expect(test.rows.get('a')?.request.utterance).toBe('Keep this button.');
  expect(ordinaryChange).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

const labelledButton = (label: string) => node.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const removalPrompt = () => node.querySelector<HTMLElement>('[aria-label="Confirm frame removal"]');
async function markedFrames() {
  const draft = sample();
  draft.request.frames = ['a', 'b', 'c'].map((id, index) => ({ ...draft.request.frames[0], id: `frame-${id}`, atMs: index * 1_000,
    transcript: `Annotation ${id}`, pins: [{ n: 1, x: 0.5, y: 0.5, text: `Keep mark ${id}` }] }));
  await act(async () => { test.rows.set('a', draft); test.listeners.forEach(listener => listener()); });
  return draft.request.frames;
}
it('keeps marked frames until confirmation and cancels from the same inline controls', async () => {
  const frames = await markedFrames();
  await act(async () => labelledButton('Remove frame 2').click());
  expect(test.rows.get('a')?.request.frames).toEqual(frames);
  expect(removalPrompt()?.textContent).toContain('Remove frame 2?');
  await act(async () => labelledButton('Keep frame').click());
  expect(test.rows.get('a')?.request.frames).toEqual(frames);
  expect(removalPrompt()).toBeNull();
  expect(document.activeElement).toBe(labelledButton('Remove frame 2'));
  expect(fetcher).not.toHaveBeenCalled();
});
it('confirms the selected frame only, preserves annotated order, and restores nearby focus', async () => {
  const frames = await markedFrames();
  await act(async () => labelledButton('Remove frame 2').click());
  await act(async () => labelledButton('Confirm remove frame 2').click());
  expect(test.rows.get('a')?.request.frames).toEqual([frames[0], frames[2]]);
  expect(removalPrompt()).toBeNull();
  expect(document.activeElement).toBe(labelledButton('Annotate frame 2'));
});
it('cancels a keyboard-opened removal with Escape without dropping annotations', async () => {
  const frames = await markedFrames();
  await act(async () => { labelledButton('Remove frame 1').focus(); labelledButton('Remove frame 1').click(); });
  await act(async () => labelledButton('Keep frame').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(removalPrompt()).toBeNull();
  expect(test.rows.get('a')?.request.frames).toEqual(frames);
  expect(document.activeElement).toBe(labelledButton('Remove frame 1'));
});
it.each(['capture', 'send'] as const)('keeps frame confirmation locked during %s', async mode => {
  const frames = await markedFrames();
  let release: (() => void) | undefined;
  await act(async () => labelledButton('Remove frame 2').click());
  if (mode === 'capture') await act(async () => claimVisualCapture('capture', 'a', target, 'request-a'));
  else {
    test.hold = new Promise<void>(done => { release = done; });
    fetcher.mockResolvedValueOnce(Response.json({ error: 'Not sent.' }, { status: 400 }));
    await act(async () => send().click());
  }
  expect(labelledButton('Confirm remove frame 2').disabled).toBe(true);
  await act(async () => labelledButton('Confirm remove frame 2').click());
  expect(test.rows.get('a')?.request.frames).toEqual(frames);
  expect(fetcher).not.toHaveBeenCalled();
  if (release) await act(async () => release!());
});
it('does not carry a removal confirmation into a replacement draft', async () => {
  await markedFrames();
  await act(async () => labelledButton('Remove frame 2').click());
  await act(async () => { test.rows.set('a', { ...sample(), request: { ...sample().request, id: 'replacement' } }); test.listeners.forEach(listener => listener()); });
  expect(removalPrompt()).toBeNull();
  expect(test.rows.get('a')?.request.frames).toHaveLength(1);
});
it('returns focus to a surviving control after confirming the final frame removal', async () => {
  await act(async () => labelledButton('Remove frame 1').click());
  await act(async () => labelledButton('Confirm remove frame 1').click());
  expect(test.rows.get('a')?.request.frames).toHaveLength(0);
  expect(document.activeElement).toBe(labelledButton('Discard visual draft'));
  expect(send().disabled).toBe(true);
});

const meaningChoice = { kind: 'choice', question: 'What should be bigger?', aodlPath: 'intent.size', options: [
  { label: 'Button size', value: 'button-size' }, { label: 'Text size', value: 'text-size' }, { label: 'Spacing', value: 'spacing' },
] };
const providerResult = (value: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
const questionSurface = () => document.querySelector<HTMLElement>('[aria-label="Clarify visual intent"]');
const optionButton = (label: string) => [...document.querySelectorAll('button')].find(button => button.textContent === label)!;
async function meaningDraft(words = 'Make it bigger.', candidates = 1) {
  const observation = sampleObservation();
  const draft = sample(); draft.request.id = crypto.randomUUID(); draft.request.utterance = words;
  draft.request.frames = [{ ...draft.request.frames[0], width: 320, height: 280, image: observation.image, observation,
    candidates: Array.from({ length: candidates }, (_, index) => ({ id: `button-${index}`, name: 'Save', role: 'button', rect: [index * 0.5, 0.2, 0.2, 0.1] })) }];
  fetcher.mockImplementation(async (_url, init) => Response.json({ item: { ...JSON.parse(String(init?.body)), status: 'queued' } }));
  await act(async () => { test.rows.set('a', draft); test.listeners.forEach(listener => listener()); });
}
function sentInstruction() { return JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body)).payload; }
it.each(['click', 'keyboard', 'Live voice'])('asks one meaning question through Send; a %s answer only edits until the next Send', async answer => {
  inference.provider.mockImplementation(async () => providerResult(meaningChoice));
  await meaningDraft();
  await act(async () => send().click());
  expect(questionSurface()?.textContent).toContain('What should be bigger?');
  expect(document.querySelectorAll('[aria-label="Clarify visual intent"]')).toHaveLength(1);
  expect(fetcher).not.toHaveBeenCalled();
  const prompt = JSON.parse(String(inference.provider.mock.calls[0][1]?.body)).messages;
  expect(JSON.parse(prompt[1].content)).toMatchObject({ utterance: 'Make it bigger.', markedTarget: { name: 'Save', role: 'button' } });
  await act(async () => {
    if (answer === 'click') optionButton('Text size').click();
    else if (answer === 'keyboard') questionSurface()!.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }));
    else {
      const { answerVisualQuestion } = await import('@/lib/composer/visual-clarification');
      expect(await answerVisualQuestion({ principal: 'a', target, routing: sample().template.routing }, 'Text size.')).toContain('has not been sent');
    }
  });
  expect(fetcher).not.toHaveBeenCalled(); expect(questionSurface()).toBeNull();
  expect(node.querySelector('textarea')!.value).toBe('Make it bigger.');
  await act(async () => send().click());
  expect(fetcher).toHaveBeenCalledTimes(1); expect(inference.provider).toHaveBeenCalledTimes(1);
  expect(sentInstruction().text).toBe('Make it bigger.');
  expect(sentInstruction().wireMessage).toContain('intent.size = "text-size"');
});
it('sends a clear marked ask unchanged without a question', async () => {
  inference.provider.mockImplementation(async () => providerResult({ kind: 'none' }));
  await meaningDraft('Set this button width to 160px.');
  await act(async () => send().click());
  expect(inference.provider).toHaveBeenCalledTimes(1); expect(questionSurface()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1); expect(sentInstruction().text).toBe('Set this button width to 160px.');
});
it('bounds a hung resolver at 1500ms, records the timeout, sends unchanged, and ignores a late choice', async () => {
  vi.useFakeTimers();
  let late!: (value: Response) => void;
  inference.provider.mockImplementation(() => new Promise<Response>(resolve => { late = resolve; }));
  await meaningDraft();
  await act(async () => send().click());
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1499)); expect(fetcher).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(fetcher).toHaveBeenCalledTimes(1); expect(sentInstruction().text).toBe('Make it bigger.');
  expect(inference.provider.mock.calls[0][1].signal.aborted).toBe(true);
  expect(test.rows.get('a')).toMatchObject({ meaningCheck: { status: 'timeout', latencyMs: 1500 } });
  await act(async () => late(providerResult(meaningChoice)));
  expect(questionSurface()).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('resolves meaning only after the marked target has been chosen, retaining both answers', async () => {
  inference.provider.mockImplementation(async () => providerResult(meaningChoice));
  await meaningDraft('Make it bigger.', 2);
  await act(async () => send().click());
  expect(questionSurface()?.textContent).toContain('Which marked component'); expect(inference.provider).not.toHaveBeenCalled();
  await act(async () => optionButton('Left: Save').click());
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => send().click());
  expect(questionSurface()?.textContent).toContain('What should be bigger?');
  await act(async () => optionButton('Button size').click());
  await act(async () => send().click());
  expect(sentInstruction().wireMessage).toContain('button-0'); expect(sentInstruction().wireMessage).toContain('intent.size = "button-size"');
});
it.each(['Skip', 'Escape'])('dismisses a meaning question with %s and sends only on the next Send', async dismissal => {
  inference.provider.mockImplementation(async () => providerResult(meaningChoice));
  await meaningDraft(); await act(async () => send().click());
  expect(questionSurface()).not.toBeNull();
  await act(async () => {
    if (dismissal === 'Skip') optionButton('Skip').click();
    else questionSurface()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  expect(questionSurface()).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
  await act(async () => send().click());
  expect(fetcher).toHaveBeenCalledTimes(1); expect(inference.provider).toHaveBeenCalledTimes(1);
  expect(sentInstruction().wireMessage).not.toContain('intent.size =');
});
it('ignores a late resolver after switching the composer account', async () => {
  let late!: (value: Response) => void;
  inference.provider.mockImplementation(() => new Promise<Response>(resolve => { late = resolve; }));
  await meaningDraft(); await act(async () => send().click());
  test.principal = 'b'; await act(async () => mount());
  await act(async () => late(providerResult(meaningChoice)));
  expect(fetcher).not.toHaveBeenCalled(); expect(questionSurface()).toBeNull();
});
it('fails open on a forbidden resolver patch without changing routing or permissions', async () => {
  inference.provider.mockImplementation(async () => providerResult({ ...meaningChoice, aodlPath: 'authority.deploy' }));
  await meaningDraft(); await act(async () => send().click());
  expect(inference.provider).toHaveBeenCalledTimes(1); expect(questionSurface()).toBeNull();
  expect(sentInstruction().routing).toEqual(sample().template.routing);
  expect(sentInstruction().wireMessage).not.toContain('authority.deploy');
});

it('measures resolver p50 and p95 through the composer on 40 deterministic model fixtures', async ({ annotate }) => {
  inference.provider.mockImplementation(async () => providerResult({ kind: 'none' }));
  const latencies: number[] = [];
  for (let index = 0; index < 40; index += 1) {
    await meaningDraft('Set this button width to 160px.');
    await act(async () => send().click());
    latencies.push(test.rows.get('a')!.meaningCheck!.latencyMs);
  }
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.ceil(latencies.length * 0.5) - 1];
  const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];
  expect(inference.provider).toHaveBeenCalledTimes(40);
  expect(p95).toBeLessThan(1500);
  await annotate(`n=40 resolver p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms (fixture transport and model; no provider call)`, 'ripple-fixture');
});
it('drops a confirmed meaning after the words or marked pixels change', async () => {
  inference.provider.mockImplementation(async () => providerResult(meaningChoice));
  await meaningDraft(); await act(async () => send().click());
  await act(async () => optionButton('Text size').click());
  const confirmed = test.rows.get('a')!;
  await act(async () => {
    test.rows.set('a', { ...confirmed, request: { ...confirmed.request, utterance: 'Make the button blue.', frames: confirmed.request.frames.map(frame => ({ ...frame, id: 'new-pixels' })) } });
    test.listeners.forEach(listener => listener());
  });
  inference.provider.mockImplementation(async () => providerResult({ kind: 'none' }));
  await act(async () => send().click());
  expect(inference.provider).toHaveBeenCalledTimes(2);
  expect(sentInstruction().wireMessage).not.toContain('intent.size =');
});

it.each(['none', 'timeout'])('does not add a 3100ms receipt write to the resolver deadline: %s', async result => {
  vi.useFakeTimers();
  inference.provider.mockImplementation(() => result === 'none'
    ? Promise.resolve(providerResult({ kind: 'none' })) : new Promise<Response>(() => {}));
  await meaningDraft('Set this button width to 160px.');
  let persisted = false;
  test.receipt = new Promise<void>(resolve => setTimeout(() => { persisted = true; resolve(); }, 3100));
  await act(async () => send().click());
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(persisted).toBe(false);
  expect(test.rows.get('a')?.status).toBe('saved');
  await act(async () => vi.advanceTimersByTimeAsync(1600));
  expect(persisted).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(test.rows.get('a')?.status).toBe('saved');
});

it('retains a newer draft edit arriving between advisory receipt publication and dispatch', async () => {
  inference.provider.mockImplementation(async () => providerResult({ kind: 'none' }));
  await meaningDraft('Set this button width to 160px.');
  test.receiptEdit = () => {
    const current = test.rows.get('a')!;
    test.rows.set('a', { ...current, request: { ...current.request, utterance: 'Keep these newer words unsent.' } });
    test.listeners.forEach(listener => listener());
  };
  await act(async () => send().click());
  expect(fetcher).not.toHaveBeenCalled();
  expect(test.rows.get('a')).toMatchObject({ status: 'draft', request: { utterance: 'Keep these newer words unsent.' } });
});
