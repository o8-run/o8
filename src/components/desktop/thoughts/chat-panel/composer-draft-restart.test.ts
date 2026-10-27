// @vitest-environment jsdom

import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThoughtsChatPanel, type ThoughtsChatPanelHandle } from '../ThoughtsChatPanel';
import { resetComposerDraftMemoryForTests } from './composer-draft-store';

vi.mock('@/components/desktop/hooks/DesktopWebSocketContext', () => ({ useSharedDesktopWs: () => undefined }));
vi.mock('@/components/desktop/onboarding/useRuntimeInventory', () => ({
  useRuntimeInventory: () => ({ inventory: [], loading: false, error: null, refresh: () => {} }),
}));
vi.mock('./ProfiledChatMessageList', async () => {
  const { createElement: element, forwardRef } = await import('react');
  return { ProfiledChatMessageList: forwardRef<HTMLDivElement>(() => element('div')) };
});
const backendChoice = vi.hoisted(() => ({ forcePending: false }));
vi.mock('../useBackendSwitchChoice', async original => {
  const actual = await original<typeof import('../useBackendSwitchChoice')>();
  return { ...actual, useBackendSwitchChoice: (options: Parameters<typeof actual.useBackendSwitchChoice>[0]) => {
    const choice = actual.useBackendSwitchChoice(options);
    return backendChoice.forcePending ? { ...choice, pending: { backend: 'codex' as const, model: 'fixture-model', label: 'Codex' } } : choice;
  } };
});

let root: Root;
let host: HTMLDivElement;
const panelRef = createRef<ThoughtsChatPanelHandle>();
const draft = 'Keep this unsent plan.\n  Preserve spacing and caf\u00e9 \ud83c\udf19.';

async function mount(repoPath = '/repo/alpha', scopeTabId = 'workspace-alpha', expectsThreadLoad = false, draftConversationId?: string) {
  await act(async () => {
    root.render(createElement(ThoughtsChatPanel, {
      ref: panelRef, open: true, agents: [], sessionTargets: [], workspaceTargets: [],
      repoPath, scopeTabId, expectsThreadLoad, draftConversationId, initialMode: 'fleet', preferredRuntime: 'codex',
      missionState: { version: 2, prompt: '', summary: '', packets: [], updatedAt: new Date(0).toISOString() },
      suppressAutoRestore: true, suppressRuntimePrewarm: true,
      thoughtsBodyBackground: 'var(--t-bg)', thoughtsElevatedSurface: 'var(--t-panel)',
      thoughtsElevatedBorder: 'var(--t-border)', thoughtsElevatedShadow: 'none', thoughtsMutedGlass: 'var(--t-muted)',
      onMissionStateChange: () => {}, onChromeChange: () => {},
    }));
  });
}

function input() { return host.querySelector<HTMLTextAreaElement>('textarea')!; }
function dropImage() {
  const event = new Event('drop', { bubbles: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [new File(['image bytes'], 'draft.png', { type: 'image/png' })] } });
  host.querySelector('[data-composer-center]')!.dispatchEvent(event);
}
async function settleFiles() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
}
async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(input().value).toBe(text);
}
async function reopen() {
  await act(async () => root.unmount());
  sessionStorage.clear();
  resetComposerDraftMemoryForTests();
  root = createRoot(host);
  await mount();
}

beforeEach(() => {
  backendChoice.forcePending = false;
  localStorage.clear(); sessionStorage.clear();
  resetComposerDraftMemoryForTests();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:fixture'; } static revokeObjectURL() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url);
    if (path.startsWith('/api/v2/chat-history?')) return Response.json({ messages: [], repoPath: '/repo/alpha' });
    if (path.includes('composer-queue')) return Response.json({ items: [] });
    if (path.includes('operator-defaults')) return Response.json({ orchestratorBackend: 'codex', orchestratorModel: 'fixture-model' });
    return Response.json({ agents: [], conversations: [] });
  }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  if (vi.isFakeTimers()) { vi.clearAllTimers(); vi.useRealTimers(); }
  localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  resetComposerDraftMemoryForTests();
});

describe('ordinary workspace drafts through the mounted composer', () => {
  it('migrates a saved thread draft across pane and repository aliases without reviving cleared text', async () => {
    // Keep debounced history saves inside this case's fetch fixture.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const legacyKey = 'o8:composer-draft:v1:' + JSON.stringify(['/repo/previous', ['thread', 'thoughts-moved']]);
    localStorage.setItem(legacyKey, JSON.stringify({ input: draft, images: [], files: [] }));
    await mount('/repo/current', 'reopened-pane', true, 'thoughts-moved');
    expect.soft(input().value).toBe(draft);
    await act(async () => panelRef.current!.loadThread('thoughts-moved'));
    expect.soft(input().value).toBe(draft);
    await type('');
    await act(async () => root.unmount()); resetComposerDraftMemoryForTests(); root = createRoot(host);
    await mount('/repo/previous', 'restored-pane', true, 'thoughts-moved');
    expect(input().value).toBe('');
  });

  it('restores the image bytes alongside the unsent text', async () => {
    await mount(); await type(draft);
    await act(async () => dropImage()); await settleFiles();
    const source = host.querySelector<HTMLImageElement>('img[alt="draft.png"]')?.getAttribute('src');
    expect(source).toContain('data:image/png;base64,');
    await reopen();
    expect(input().value).toBe(draft);
    expect(host.querySelector<HTMLImageElement>('img[alt="draft.png"]')?.getAttribute('src')).toBe(source);
    await type('');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Remove draft.png"]')!.click());
    await reopen();
    expect(input().value).toBe(''); expect(host.querySelector('img[alt="draft.png"]')).toBeNull();
  });
  it('restores input events after a fresh window session without sending', async () => {
    await mount(); await type(draft);
    await reopen();
    expect(input().value).toBe(draft);
    const writes = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(writes.filter(([url]) => /send|runtime\/launch|chat-history/.test(String(url)))).toEqual([]);
  });

  it('keeps repositories, tabs and explicitly selected conversations separate', async () => {
    await mount(); await type(draft);
    await mount('/repo/beta', 'workspace-alpha'); expect(input().value).toBe(''); await type('Beta only');
    await mount('/repo/alpha', 'workspace-other'); expect(input().value).toBe('');
    await mount(); expect(input().value).toBe(draft);
    await act(async () => panelRef.current!.loadThread('thoughts-other'));
    expect(input().value).toBe(''); await type('Other conversation');
    await act(async () => panelRef.current!.loadThread('thoughts-first'));
    expect(input().value).toBe('');
    await act(async () => panelRef.current!.loadThread('thoughts-other'));
    expect(input().value).toBe('Other conversation');
  });

  it('does not resurrect text that was explicitly deleted', async () => {
    await mount(); await type(draft); await type(''); await reopen();
    expect(input().value).toBe('');
  });

  it('rehydrates the selected conversation after delayed history loading without overwriting it', async () => {
    await mount(); await act(async () => panelRef.current!.loadThread('thoughts-kept')); await type(draft);
    await act(async () => root.unmount()); resetComposerDraftMemoryForTests(); sessionStorage.clear(); root = createRoot(host);
    await mount('/repo/alpha', 'workspace-alpha', true, 'thoughts-kept');
    await act(async () => panelRef.current!.loadThread('thoughts-kept'));
    expect(input().value).toBe(draft);
  });

  it('keeps the full newest input in memory and warns when storage rejects it', async () => {
    await mount(); await type('Saved before the failure');
    const original = Storage.prototype.setItem;
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith('o8:composer-draft:')) throw new Error('Storage unavailable');
      original.call(this, key, value);
    });
    await type(draft);
    expect(host.textContent).toContain('latest draft changes could not be saved');
    storage.mockRestore(); await type(draft + '\nSaved after recovery'); await reopen();
    expect(input().value).toBe(draft + '\nSaved after recovery');
  });

  it('does not put a delayed image read into a newly selected workspace', async () => {
    let finish: (() => void) | undefined;
    vi.stubGlobal('FileReader', class extends FileReader {
      readAsDataURL(blob: Blob) { finish = () => super.readAsDataURL(blob); }
    });
    await mount(); await act(async () => dropImage());
    await mount('/repo/beta', 'workspace-beta');
    await act(async () => finish!()); await settleFiles();
    expect(host.querySelector('img[alt="draft.png"]')).toBeNull();
    expect(input().value).toBe('');
  });

  it('keeps text and attachments typed before bound history finishes loading', async () => {
    await mount('/repo/alpha', 'workspace-alpha', true, 'thoughts-loading');
    await type(draft); await act(async () => dropImage()); await settleFiles();
    await act(async () => panelRef.current!.loadThread('thoughts-loading'));
    expect(input().value).toBe(draft);
    expect(host.querySelector('img[alt="draft.png"]')).not.toBeNull();
    await act(async () => root.unmount()); resetComposerDraftMemoryForTests(); root = createRoot(host);
    await mount('/repo/alpha', 'different-pane', true, 'thoughts-loading');
    expect(input().value).toBe(draft);
  });

  it('keeps the saved conversation draft when a replacement cannot be saved', async () => {
    backendChoice.forcePending = true;
    await mount(); await act(async () => panelRef.current!.loadThread('thoughts-original'));
    await type(draft); await act(async () => dropImage()); await settleFiles();
    const originalKey = Object.keys(localStorage).find(key => key.startsWith('o8:composer-draft:') && key.includes('thoughts-original'))!;
    const saved = localStorage.getItem(originalKey);
    const setItem = Storage.prototype.setItem;
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith('o8:composer-draft:') && key !== originalKey) throw new Error('Quota exceeded');
      setItem.call(this, key, value);
    });
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Start fresh')!.click());
    expect(input().value).toBe(draft);
    expect(host.textContent).toContain('latest draft changes could not be saved');
    expect(localStorage.getItem(originalKey)).toBe(saved);
    storage.mockRestore();
    await act(async () => root.unmount()); resetComposerDraftMemoryForTests(); sessionStorage.clear(); root = createRoot(host);
    await mount('/repo/alpha', 'workspace-alpha', true, 'thoughts-original');
    expect(input().value).toBe(draft);
    expect(host.querySelector('img[alt="draft.png"]')).not.toBeNull();
  });

  it('carries the unsent text and image when Start fresh replaces the conversation', async () => {
    backendChoice.forcePending = true;
    await mount(); await act(async () => panelRef.current!.loadThread('thoughts-original'));
    await type(draft); await act(async () => dropImage()); await settleFiles();
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Start fresh')!.click());
    expect(input().value).toBe(draft);
    expect(host.querySelector('img[alt="draft.png"]')).not.toBeNull();
  });
});
