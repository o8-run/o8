// @vitest-environment jsdom
import { act, createElement, Fragment, StrictMode, useLayoutEffect, useRef, useState, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatGPTPlanChat } from './ChatGPTPlanChat';
import { WorkspaceTerminalPanels } from './WorkspaceTerminalPanels';
import { WorkspaceLaunchPicker } from './WorkspaceLaunchPicker';
import { WorkspaceAddTabButton } from '../shell/WorkspaceAddTabButton';
import { buildNewChatGPTPlanTab, buildPersistedState } from './terminal-tab-handlers';
import { useTextChatTabs } from './use-text-chat-tabs';
import { computeRestoredTabs } from './terminal-restore';
import { registerPlanAccountToken } from '@/lib/chatgpt-plan/client';
import type { TerminalTab } from './types';
import { OPEN_SETTINGS_TAB_EVENT } from '@/lib/desktop/events';

const fixture = vi.hoisted(() => ({ owner: 'fixture-owner-a', signedIn: true }));
vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => ({ isLoaded: true, signedIn: fixture.signedIn, user: { id: fixture.owner }, signIn: vi.fn() }) }));
vi.mock('../shell/SavedMachinePicker', () => ({ SavedMachinePicker: () => null }));
vi.mock('./XtermPanel', () => ({ XtermPanel: () => null }));
vi.mock('./WorkspaceChatPane', () => ({ WorkspaceChatPane: () => null }));
vi.mock('./workspace-boot-loader-claim', () => ({ WorkspaceBootLoaderClaim: () => null }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ paletteId: 'dark', workspaceGlass: true, surface: 'glass' }) }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: HTMLAttributes<HTMLDivElement>) => createElement('div', { style }, children) }));
vi.mock('@/lib/pretext', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/pretext')>(), usePretextHeight: () => 24 }));

let planAccount: string;
let firstModelAvailable: boolean;
const status = () => ({ connected: true, planEnabled: true, activeId: planAccount, selection: { accountId: planAccount, generation: 1, desktopEpoch: 'fixture-epoch' }, welcomed: true, accounts: [], models: [...(firstModelAvailable ? [{ id: 'fixture-model', label: 'Fixture model' }] : []), { id: 'fixture-model-two', label: 'Second model' }], usageUrl: '' });
let root: Root; let container: HTMLDivElement; let releaseToken: () => void;
let connected: boolean; let requestBodies: Array<Record<string, unknown>>; let requestHeaders: Headers[];
let stream: ReadableStreamDefaultController<Uint8Array> | null;
let deferStream: boolean;
let replyText: string;
const event = (text: string) => new TextEncoder().encode(`data: ${text}\n\n`);

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.owner = 'fixture-owner-a'; fixture.signedIn = true; connected = true; firstModelAvailable = true; planAccount = 'fixture-plan-account'; requestBodies = []; requestHeaders = []; stream = null; deferStream = false; replyText = 'O8_PLAN_OK_40';
  releaseToken = registerPlanAccountToken(async () => `fixture-session-${fixture.owner}`);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/panel/models/chatgpt') return Response.json(init?.method === 'POST' ? { bound: true } : connected ? status() : { ...status(), planEnabled: false, models: [] });
    if (url !== '/api/v2/proxy/llm') throw new Error(`Unexpected route ${url}`);
    requestBodies.push(JSON.parse(init!.body as string)); requestHeaders.push(new Headers(init?.headers));
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      stream = controller;
      controller.enqueue(event(JSON.stringify({ type: 'content', text: replyText })));
      if (!deferStream) { controller.enqueue(event('[DONE]')); controller.close(); }
      init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
    } }));
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); releaseToken(); container.remove(); vi.unstubAllGlobals(); });
async function mount() { await act(async () => root.render(createElement(Fragment, null, createElement(ChatGPTPlanChat, { tabId: 'fixture-plan-tab' })))); }
async function send() {
  const input = container.querySelector('textarea')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Add 17 and 23'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  await act(async () => new Promise(resolve => setTimeout(resolve, 60)));
}

async function openFromWorkspace(useTabPicker = false) {
  let spawned: CustomEvent | null = null;
  const persist = vi.fn();
  function Harness() {
    const [tabs, setTabs] = useState<TerminalTab[]>([]);
    const tabsRef = useRef<TerminalTab[]>([]);
    const [activeId, setActiveId] = useState('');
    const { handleNewChatGPTPlanTab } = useTextChatTabs({ tabsRef, setTabs, persistTabsNow: (next, id) => persist(buildPersistedState(next, id)), setActiveTabIdFromUser: setActiveId });
    useLayoutEffect(() => {
      const listener = (value: Event) => { spawned = value as CustomEvent; if (spawned.detail.kind === 'chatgpt-plan' && spawned.detail.workspaceId === 'fixture-workspace') handleNewChatGPTPlanTab(); };
      window.addEventListener('o8:request-spawn-tab', listener);
      return () => window.removeEventListener('o8:request-spawn-tab', listener);
    }, [handleNewChatGPTPlanTab]);
    const noop = vi.fn();
    return createElement(Fragment, null, useTabPicker ? createElement(WorkspaceLaunchPicker, { onNewTab: noop, onNewLLMChatTab: noop, onNewChatGPTPlanTab: handleNewChatGPTPlanTab }) : createElement(WorkspaceAddTabButton, { workspaceId: 'fixture-workspace' }), createElement(WorkspaceTerminalPanels, { workspaceId: 'fixture-workspace', visibleTabs: tabs, restoreSettled: true, effectiveActiveTabId: activeId, termWsConnected: false, panelRefs: { current: new Map() }, onCloseTab: noop, onRunInTerminal: noop, onOpenWorkspaceCommitTab: noop, onUpdateLlmSummary: noop, onUpdateLinkedIssue: noop, onUpdateChatMessages: noop, onUpdateChatSessionKey: noop, onUpdateChatModel: noop, onConsumeChatDraftInjection: noop, onSaveCheckpoint: noop, onRestoreLatestCheckpoint: noop, projectContextRailVisible: false, sendTerminalAttach: noop, sendTerminalInput: noop, sendTerminalResize: noop, sendTerminalVisibility: noop, sendTerminalDetach: noop }));
  }
  await act(async () => root.render(createElement(Harness)));
  await act(async () => container.querySelector('button')!.click());
  const launch = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.startsWith('ChatGPT plan chat'));
  expect(launch).toBeDefined();
  await act(async () => launch!.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  return persist;
}

it('opens the real plan pane from the normal workspace menu and sends one authenticated text-only request', async () => {
  const persist = await openFromWorkspace();
  expect(container.querySelector('[aria-label="ChatGPT plan model"]')).not.toBeNull();
  expect(persist).toHaveBeenCalledWith(expect.objectContaining({ tabs: [expect.objectContaining({ kind: 'chatgpt-plan', label: 'ChatGPT plan' })] }));
  await send();
  expect(container.querySelector('[role="log"]')?.textContent).toContain('O8_PLAN_OK_40');
  expect(requestBodies).toHaveLength(1);
  expect(requestBodies[0]).toMatchObject({ provider: 'chatgpt', model: 'fixture-model', planTextOnly: true, disableTools: true, approvedTools: [], messages: [{ role: 'user', content: 'Add 17 and 23' }] });
  expect(requestBodies[0]).not.toHaveProperty('repoPath');
  expect(requestBodies[0]).toMatchObject({ planAccountId: planAccount, planGeneration: 1, planDesktopEpoch: 'fixture-epoch' });
  expect(requestHeaders[0].get('x-clerk-session-token')).toBe('fixture-session-fixture-owner-a');
});

it('hides the old conversation on the first account-transition commit and aborts its stream', async () => {
  deferStream = true; await mount(); await send();
  expect(container.textContent).toContain('O8_PLAN_OK_40');
  let firstCommit = '';
  function Observer() { useLayoutEffect(() => { firstCommit = container.textContent ?? ''; }); return null; }
  fixture.owner = 'fixture-owner-b';
  await act(async () => root.render(createElement(Fragment, null, createElement(ChatGPTPlanChat, { tabId: 'fixture-plan-tab' }), createElement(Observer))));
  expect(firstCommit).not.toContain('O8_PLAN_OK_40'); expect(firstCommit).not.toContain('Add 17 and 23');
  expect(container.textContent).not.toContain('O8_PLAN_OK_40');
});

it('invalidates a connected account conversation immediately on disconnect and refuses another request', async () => {
  deferStream = true; await mount(); await send(); connected = false;
  await act(async () => window.dispatchEvent(new Event('o8:chatgpt-plan-changed')));
  expect(container.textContent).not.toContain('O8_PLAN_OK_40');
  expect(container.querySelector('textarea')).toBeNull();
  expect(requestBodies).toHaveLength(1);
});

it('hides completed conversation text on the first sign-out commit', async () => {
  await mount(); await send();
  let firstCommit = '';
  function Observer() { useLayoutEffect(() => { firstCommit = container.textContent ?? ''; }); return null; }
  fixture.signedIn = false;
  await act(async () => root.render(createElement(Fragment, null, createElement(ChatGPTPlanChat, { tabId: 'fixture-plan-tab' }), createElement(Observer))));
  expect(firstCommit).not.toContain('O8_PLAN_OK_40'); expect(firstCommit).not.toContain('Add 17 and 23');
  expect(container.textContent).toContain('Sign in to o8');
});

it('does not retry or fall back when a plan request ends without a completed stream', async () => {
  deferStream = true; await mount(); await send();
  await act(async () => stream!.close());
  expect(container.textContent).toContain('partial response');
  expect(container.textContent).toContain('ended before completion');
  expect(requestBodies).toHaveLength(1);
});

it('clears a transcript after an external plan selection change before sending and never carries it into the new account', async () => {
  await mount(); await send(); planAccount = 'fixture-plan-b';
  await send();
  expect(container.textContent).not.toContain('O8_PLAN_OK_40');
  expect(container.textContent).toContain('conversation was cleared');
  expect(requestBodies).toHaveLength(1);
  await send();
  expect(requestBodies).toHaveLength(2);
  expect(requestBodies[1]).toMatchObject({ planAccountId: 'fixture-plan-b', messages: [{ role: 'user', content: 'Add 17 and 23' }] });
});

it('works after StrictMode remount and ignores a stream reply after unmount', async () => {
  await act(async () => root.render(createElement(StrictMode, null, createElement(ChatGPTPlanChat, { tabId: 'fixture-plan-tab' }))));
  deferStream = true; await send();
  expect(requestBodies).toHaveLength(1);
  await act(async () => root.render(null));
  expect(container.textContent).toBe('');
});

it('keeps an open plan conversation when four other tabs exhaust the heavy pane residency budget', async () => {
  const plan = buildNewChatGPTPlanTab();
  const tabs: TerminalTab[] = [plan, ...Array.from({ length: 4 }, (_, index) => ({ id: `fixture-terminal-${index}`, label: `Terminal ${index}`, kind: 'terminal' as const, tmuxSession: `fixture-tmux-${index}`, createdAt: 0, lastActivity: 0 }))];
  const noop = vi.fn();
  const props = { workspaceId: 'fixture-workspace', visibleTabs: tabs, restoreSettled: true, termWsConnected: false, panelRefs: { current: new Map() }, onCloseTab: noop, onRunInTerminal: noop, onOpenWorkspaceCommitTab: noop, onUpdateLlmSummary: noop, onUpdateLinkedIssue: noop, onUpdateChatMessages: noop, onUpdateChatSessionKey: noop, onUpdateChatModel: noop, onConsumeChatDraftInjection: noop, onSaveCheckpoint: noop, onRestoreLatestCheckpoint: noop, projectContextRailVisible: false, sendTerminalAttach: noop, sendTerminalInput: noop, sendTerminalResize: noop, sendTerminalVisibility: noop, sendTerminalDetach: noop };
  await act(async () => root.render(createElement(WorkspaceTerminalPanels, { ...props, effectiveActiveTabId: plan.id })));
  await send();
  const pane = container.querySelector('[aria-label="ChatGPT plan chat"]');
  for (const tab of tabs.slice(1)) await act(async () => root.render(createElement(WorkspaceTerminalPanels, { ...props, effectiveActiveTabId: tab.id })));
  await act(async () => root.render(createElement(WorkspaceTerminalPanels, { ...props, effectiveActiveTabId: plan.id })));
  expect(container.querySelector('[aria-label="ChatGPT plan chat"]')).toBe(pane);
  expect(pane?.textContent).toContain('O8_PLAN_OK_40');
  expect(requestBodies).toHaveLength(1);
});


it('takes a disconnected user from the normal pane entry to connection settings without a billed request', async () => {
  connected = false;
  const settings = vi.fn();
  window.addEventListener(OPEN_SETTINGS_TAB_EVENT, settings);
  try {
    await openFromWorkspace();
    const connect = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Connect ChatGPT');
    expect(connect).toBeDefined();
    await act(async () => connect!.click());
    expect(settings).toHaveBeenCalledOnce();
    expect((settings.mock.calls[0][0] as CustomEvent).detail).toEqual({ tab: 'models' });
    expect(requestBodies).toHaveLength(0);
  } finally {
    window.removeEventListener(OPEN_SETTINGS_TAB_EVENT, settings);
  }
});


it('prefills a suggested prompt without sending or changing the selected model', async () => {
  await openFromWorkspace();
  const model = container.querySelector<HTMLButtonElement>('[aria-label="ChatGPT plan model"]')!;
  const before = model.value;
  const prompt = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Make a plan');
  await act(async () => prompt!.click());
  const input = container.querySelector('textarea')!;
  expect(input.value).toContain('turn this idea into a clear plan');
  expect(document.activeElement).toBe(input);
  expect(model.value).toBe(before);
  expect(requestBodies).toHaveLength(0);
});

it('uses the shared composer model menu and keeps the chosen plan model for the real send path', async () => {
  await mount();
  const chip = container.querySelector<HTMLButtonElement>('[aria-label="ChatGPT plan model"]')!;
  expect(chip.closest('[data-o8-composer-root]')).not.toBeNull();
  expect(container.querySelector('header')).toBeNull();
  await act(async () => chip.click());
  const options = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
  expect(document.activeElement).toBe(options[0]);
  await act(async () => options[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(options[1]);
  await act(async () => options[1].click());
  expect(document.querySelector('[aria-label="ChatGPT models"]')).toBeNull();
  expect(document.activeElement).toBe(chip);
  expect(chip.value).toBe('fixture-model-two');
  expect(requestBodies).toHaveLength(0);
  await send();
  expect(requestBodies).toHaveLength(1);
  expect(requestBodies[0].model).toBe('fixture-model-two');
});

it('keeps file mentions and slash commands literal and uses Enter with Shift+Enter for a newline', async () => {
  await mount();
  const input = container.querySelector('textarea')!;
  const text = '/visualize @src/example.ts as a simple diagram';
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(input.value).toBe(text);
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })));
  expect(requestBodies).toHaveLength(0);
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(requestBodies).toHaveLength(1);
  expect(requestBodies[0]).toMatchObject({ planTextOnly: true, disableTools: true, messages: [{ role: 'user', content: text }] });
});

it('renders Markdown through the regular transcript instead of the old plain-text messages', async () => {
  replyText = '## Next step\n\nUse **one shared workspace**.\n\n```ts\nconst ready = true;\n```';
  await mount(); await send();
  await act(async () => new Promise(resolve => setTimeout(resolve, 200)));
  const log = container.querySelector('[role="log"]')!;
  expect(log.textContent).toContain('Next step');
  expect(log.textContent).not.toContain('## Next step');
  expect(log.querySelector('strong')?.textContent).toBe('one shared workspace');
  expect(log.querySelector('pre')?.textContent).toContain('const ready = true');
});

it('stops through the shared send control without issuing a duplicate request while busy', async () => {
  deferStream = true;
  await mount(); await send();
  await send();
  expect(requestBodies).toHaveLength(1);
  const stop = container.querySelector<HTMLButtonElement>('[aria-label="Stop ChatGPT"]')!;
  expect(stop.style.borderRadius).toBe('50%');
  await act(async () => stop.click());
  expect(container.textContent).toContain('Request stopped');
  expect(requestBodies).toHaveLength(1);
});

it('closes the composer model portal when its resident pane becomes inactive', async () => {
  await mount();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="ChatGPT plan model"]')!.click());
  expect(document.querySelector('[aria-label="ChatGPT models"]')).not.toBeNull();
  await act(async () => root.render(createElement(ChatGPTPlanChat, { tabId: 'fixture-plan-tab', active: false })));
  expect(document.querySelector('[aria-label="ChatGPT models"]')).toBeNull();
  expect(requestBodies).toHaveLength(0);
});


it('opens from the workspace tab picker, persists through the state route, and sends after restore', async () => {
  const persist = await openFromWorkspace(true);
  expect(persist).toHaveBeenCalledWith(expect.objectContaining({ tabs: [expect.objectContaining({ kind: 'chatgpt-plan' })] }));
  const { POST, GET } = await import('@/app/api/panel/terminal-state/route');
  const url = 'http://localhost/api/panel/terminal-state?scope=fixture-plan-launch';
  expect((await POST(new Request(url, { method: 'POST', body: JSON.stringify(persist.mock.calls[0][0]) }))).status).toBe(200);
  const response = await GET(new Request(url));
  expect(response.status).toBe(200);
  const restored = await computeRestoredTabs(await response.json(), { preferredRepo: null, defaultTab: 'terminal', createDefaultChatTab: () => { throw new Error('Restore the saved plan pane'); } });
  expect(restored?.tabs[0]).toMatchObject({ kind: 'chatgpt-plan', tmuxSession: null });
  expect(restored?.sessionsToAttach).toEqual([]);
  await act(async () => root.render(createElement(ChatGPTPlanChat, { tabId: restored!.activeTabId })));
  await send();
  expect(requestBodies).toHaveLength(1);
  expect(requestBodies[0]).toMatchObject({ provider: 'chatgpt', planTextOnly: true, disableTools: true });
  expect(container.querySelector('[role="log"]')?.textContent).toContain('O8_PLAN_OK_40');
});

it('keeps the draft and selected model when model discovery removes that model before send', async () => {
  await openFromWorkspace();
  firstModelAvailable = false;
  await send();
  expect(requestBodies).toHaveLength(0);
  expect(container.querySelector('textarea')?.value).toBe('Add 17 and 23');
  expect(container.textContent).toContain('no longer available');
  expect(container.querySelector<HTMLButtonElement>('[aria-label="ChatGPT plan model"]')?.value).toBe('fixture-model');
  await send();
  expect(requestBodies).toHaveLength(0);
});
