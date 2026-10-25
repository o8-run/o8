import { afterEach, expect, it, vi } from 'vitest';
import type { VisualInstructionDraft } from './visual-draft-store';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('keeps a same-request edit that arrives while an earlier discard is being persisted', async () => {
  const stored = new Map<string, unknown>();
  const pending: Array<() => void> = [];
  const database = {
    transaction: () => {
      const transaction = { oncomplete: null as null | (() => void), objectStore: () => ({
        put: (value: unknown, key: string) => pending.push(() => { stored.set(key, value); transaction.oncomplete?.(); }),
        delete: (key: string) => pending.push(() => { stored.delete(key); transaction.oncomplete?.(); }),
      }) };
      return transaction;
    },
  };
  vi.stubGlobal('indexedDB', { open: () => {
    const request = { result: database, onsuccess: null as null | (() => void) };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } });
  const { saveVisualDraft, removeVisualDraft, readVisualDraft } = await import('./visual-draft-store');
  const target = { repoPath: '/project', threadId: 'chat-a' };
  const original = { principal: 'local', status: 'draft', request: { id: 'same-request', target, utterance: 'Original' } } as VisualInstructionDraft;
  const save = saveVisualDraft(original);
  await vi.waitFor(() => expect(pending).toHaveLength(1)); pending.shift()!(); await save;
  const removal = removeVisualDraft('local', target, original.request.id);
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  const edited = { ...original, request: { ...original.request, utterance: 'New words after discard began' } };
  const update = saveVisualDraft(edited);
  pending.shift()!(); await removal;
  expect(readVisualDraft('local', target)?.request.utterance).toBe(edited.request.utterance);
  await vi.waitFor(() => expect(pending).toHaveLength(1)); pending.shift()!(); await update;
  expect([...stored.values()]).toEqual([edited]);
});

it('restores a bounded accepted meaning receipt from persisted draft state', async () => {
  const { visualMeaningKey } = await import('./visual-meaning');
  const routing = { backend: 'codex' as const, model: 'selected', effort: 'low' as const, permissionMode: 'plan' as const, mode: 'single' as const, pickedMode: 'solo' as const, collide: false };
  const target = { threadId: 'restore-meaning', repoPath: '/fixture' };
  const draft: VisualInstructionDraft = { principal: 'fixture', status: 'draft', template: { text: '', wireMessage: '', images: [], routing },
    request: { version: 1, id: 'restored-meaning', createdAt: '2026-10-24T12:00:00Z', target, utterance: 'Make it bigger.', frames: [] } };
  draft.meaningCheck = { key: visualMeaningKey(draft), status: 'accepted', selectedValue: 'text-size', latencyMs: 2,
    resolution: { kind: 'choice', id: 'restored-choice', question: 'What should be bigger?', aodlPath: 'intent.size',
      options: [{ label: 'Button size', value: 'button-size' }, { label: 'Text size', value: 'text-size' }] } };
  let persisted: unknown;
  vi.stubGlobal('indexedDB', { open: () => {
    const opening = { result: { transaction: () => {
      const transaction = { oncomplete: null as (() => void) | null, objectStore: () => ({
        put: (value: unknown) => { persisted = structuredClone(value); queueMicrotask(() => transaction.oncomplete?.()); },
        get: () => { const request = { result: structuredClone(persisted), onsuccess: null as (() => void) | null }; queueMicrotask(() => request.onsuccess?.()); return request; },
      }) }; return transaction;
    } }, onsuccess: null as (() => void) | null };
    queueMicrotask(() => opening.onsuccess?.()); return opening;
  } });
  await (await import('./visual-draft-store')).saveVisualDraft(draft);
  vi.resetModules();
  const restored = await import('./visual-draft-store');
  await restored.restoreVisualDraft(draft.principal, target);
  const value = restored.readVisualDraft(draft.principal, target)!;
  expect(value.meaningCheck).toEqual(draft.meaningCheck);
  expect((await import('./visual-meaning')).visualMeaningContext(value)).toContain('intent.size = "text-size"');
  value.request.utterance = 'Make it blue.';
  expect((await import('./visual-meaning')).visualMeaningContext(value)).toBe('');
});

it.each(['same send', 'later send', 'after dismissal', 'after choice'])('keeps a slow receipt write out of actual dispatch: %s', async mode => {
  vi.useFakeTimers();
  const persisted = new Map<string, VisualInstructionDraft>();
  vi.stubGlobal('indexedDB', { open: () => {
    const opening = { result: { transaction: () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const transaction = { oncomplete: null as (() => void) | null, onabort: null as (() => void) | null,
        abort: () => { clearTimeout(timer); transaction.onabort?.(); }, objectStore: () => ({
        put: (value: VisualInstructionDraft, key: string) => {
          const write = () => { persisted.set(key, structuredClone(value)); transaction.oncomplete?.(); };
          if (value.status === 'draft' && value.meaningCheck) timer = setTimeout(write, 3100);
          else queueMicrotask(write);
        },
      }) }; return transaction;
    } }, onsuccess: null as (() => void) | null };
    queueMicrotask(() => opening.onsuccess?.()); return opening;
  } });
  const { sampleObservation } = await import('./visual-inspection.test-fixture');
  const observation = sampleObservation();
  const routing = { backend: 'codex' as const, model: 'selected', effort: 'low' as const, permissionMode: 'plan' as const, mode: 'single' as const, pickedMode: 'solo' as const, collide: false };
  const target = { threadId: 'bounded-receipt', repoPath: '/fixture' };
  const draft: VisualInstructionDraft = { principal: 'fixture', status: 'draft', template: { text: '', wireMessage: '[o8-visual-instruction]', images: [], routing },
    request: { version: 1, id: 'bounded-receipt', createdAt: '2026-10-24T12:00:00Z', target, utterance: 'Set the button width to 160px.',
      frames: [{ id: 'button-frame', atMs: 0, width: 320, height: 280, observation, image: observation.image, strokes: [], pins: [], transcript: '',
        candidates: [{ id: 'button', name: 'Save', role: 'button', rect: [0.1, 0.2, 0.1, 0.1] }] }] } };
  const store = await import('./visual-draft-store');
  const { commitVisualInstruction } = await import('./visual-instruction-commit');
  await store.saveVisualDraft(draft);
  const dispatch = vi.fn(async (_url: unknown, init?: RequestInit) => Response.json({ item: { ...JSON.parse(String(init?.body)), status: 'queued' } }));
  const choice = { kind: 'choice', id: 'receipt-choice', question: 'What should be bigger?', aodlPath: 'intent.size',
    options: [{ label: 'Button size', value: 'button-size' }, { label: 'Text size', value: 'text-size' }] };
  const closesQuestion = mode === 'after dismissal' || mode === 'after choice';
  const transport: typeof fetch = async (url, init) => url === '/api/mobile/ripple/resolve'
    ? Response.json(closesQuestion ? choice : { kind: 'none' }) : dispatch(url, init);
  if (mode !== 'same send') {
    const { checkVisualMeaning } = await import('./visual-meaning');
    await checkVisualMeaning(draft, () => true, transport);
    await vi.advanceTimersByTimeAsync(0);
    if (closesQuestion) {
      const { confirmVisualQuestion, dismissVisualQuestion } = await import('./visual-clarification');
      const pending = store.readVisualDraft(draft.principal, target)!;
      void (mode === 'after choice' ? confirmVisualQuestion(pending, 'text-size') : dismissVisualQuestion(pending)).catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
    }
  }
  const sending = commitVisualInstruction(store.readVisualDraft(draft.principal, target)!, () => true, transport);
  try {
    await vi.advanceTimersByTimeAsync(1500);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect([...persisted.values()][0]).toMatchObject({ status: 'saved', meaningCheck: {
      status: mode === 'after choice' ? 'accepted' : mode === 'after dismissal' ? 'dismissed' : 'none',
    } });
    await vi.advanceTimersByTimeAsync(1600);
    await sending;
    expect([...persisted.values()][0]?.status).toBe('saved');
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally { await vi.advanceTimersByTimeAsync(3100); await sending.catch(() => {}); vi.useRealTimers(); }
});
