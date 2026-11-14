// @vitest-environment jsdom
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { O8AuthState } from '@/components/auth/O8AuthProvider';

const mocks = vi.hoisted(() => ({
  signedIn: false,
  userLoaded: true,
  user: null as { id: string; reload: () => Promise<void> } | null,
  userSnapshot: null as { isLoaded: boolean; isSignedIn: boolean; user: { id: string; reload: () => Promise<void> } | null } | null,
  userListeners: new Set<() => void>(),
  clerk: {} as Record<string, unknown>,
  signIn: {} as Record<string, unknown>,
  opened: vi.fn(),
  browserSignIn: vi.fn(),
  ticket: vi.fn(async () => ({})),
  callbacks: null as ((event: { payload: string[] }) => void) | null,
}));
vi.mock('@clerk/nextjs', async () => {
  const { useSyncExternalStore } = await import('react');
  return ({
  ClerkProvider: ({ children }: { children: unknown }) => children,
  useUser: () => useSyncExternalStore(listener => {
    mocks.userListeners.add(listener);
    return () => { mocks.userListeners.delete(listener); };
  }, () => mocks.userSnapshot!),
  useClerk: () => mocks.clerk,
  useSignIn: () => ({ signIn: mocks.signIn }),
  });
});
vi.mock('@clerk/nextjs/server', () => ({ auth: async () => ({ userId: null }) }));
vi.mock('tauri-plugin-clerk', () => ({ initClerk: async () => ({}), noopLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => [] }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, listener: typeof mocks.callbacks) => {
    if (name === 'o8:auth-callback') mocks.callbacks = listener;
    return () => { if (mocks.callbacks === listener) mocks.callbacks = null; };
  },
}));
vi.mock('@/lib/desktop/open-external', () => ({ openExternalUrl: mocks.opened }));
vi.mock('@/lib/auth/clerk-fetch-guard', () => ({ installTauriClerkFetchGuard: () => {} }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ paletteId: 'light', surface: 'solid' }) }));
vi.mock('@/lib/entitlement/context', () => ({ useEntitlement: () => ({ founder: null }) }));
vi.mock('@/lib/auth/tauri-clerk-store', async (original) => ({
  ...await original<typeof import('@/lib/auth/tauri-clerk-store')>(), purgeTauriClerkStore: async () => {},
}));

let dataDir: string;
let root: Root;
let host: HTMLDivElement;
let state: O8AuthState;
let render: () => void;
let fetchMock: ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>>;
let enrollments: number;

function localRequest(input: string, init?: RequestInit) {
  return new Request(`http://localhost${input}`, {
    ...init, headers: { host: 'localhost', 'x-o8-client-addr': '127.0.0.1', ...init?.headers },
  });
}

function publishUser() {
  mocks.userSnapshot = { isLoaded: mocks.userLoaded, isSignedIn: mocks.signedIn, user: mocks.user };
  mocks.userListeners.forEach(listener => listener());
}

async function mount() {
  publishUser();
  const { O8AuthProvider, useO8Auth } = await import('@/components/auth/O8AuthProvider');
  const Probe = () => {
    const value = useO8Auth();
    useEffect(() => { state = value; }, [value]);
    return null;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  render = () => root.render(createElement(O8AuthProvider, null, createElement(Fragment, null,
    createElement(Probe),
  )));
  await act(async () => { render(); });
  await act(async () => { await vi.dynamicImportSettled(); });
}

function callbackForLastHandoff() {
  const url = new URL(String(mocks.opened.mock.calls.at(-1)?.[0]));
  return `o8://auth/callback?state=${url.searchParams.get('state')}&ticket=${randomBytes(24).toString('hex')}`;
}

async function openNativeLauncher(open = () => state.signIn()) {
  const opened = mocks.opened.mock.calls.length;
  const begins = fetchMock.mock.calls.filter(([input]) => input.endsWith('/handoff?action=begin')).length;
  await act(async () => { open(); });
  const dialog = document.querySelector('[role="dialog"][aria-label="Sign in to o8"]');
  expect(dialog).not.toBeNull();
  expect(mocks.opened.mock.calls.length).toBe(opened);
  expect(fetchMock.mock.calls.filter(([input]) => input.endsWith('/handoff?action=begin'))).toHaveLength(begins);
  const button = [...dialog!.querySelectorAll('button')].find((element) => element.textContent?.trim() === 'Continue in browser');
  expect(button).toBeDefined();
  return button!;
}

async function beginHandoff() {
  const opened = mocks.opened.mock.calls.length;
  const button = await openNativeLauncher();
  await act(async () => {
    button.click();
    await vi.waitFor(() => expect(mocks.opened.mock.calls.length).toBe(opened + 1), { timeout: 10000 });
  });
  return callbackForLastHandoff();
}

async function deliver(raw: string) {
  await act(async () => {
    await vi.waitFor(() => expect(mocks.callbacks).not.toBeNull(), { timeout: 10000 });
    mocks.callbacks!({ payload: [raw] });
    // The callback handler is intentionally event-driven and fire-and-forget.
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

beforeEach(() => {
  vi.resetModules();
  mocks.signedIn = false;
  mocks.userLoaded = true;
  mocks.user = null;
  mocks.userListeners.clear();
  mocks.userSnapshot = null;
  mocks.opened.mockClear();
  mocks.browserSignIn.mockClear();
  mocks.ticket.mockClear();
  mocks.callbacks = null;
  enrollments = 0;
  sessionStorage.clear();
  dataDir = mkdtempSync(join(tmpdir(), 'o8-handoff-'));
  vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true, value: { metadata: { currentWindow: { label: 'main' } } },
  });
  mocks.signIn = { status: 'complete', createdSessionId: 'session_device', ticket: mocks.ticket, finalize: async () => ({}) };
  mocks.clerk = {
    openSignIn: mocks.browserSignIn,
    user: null, session: { getToken: async () => randomBytes(24).toString('hex') },
    setActive: async () => {
      mocks.signedIn = true;
      mocks.user = { id: 'user_device', reload: async () => {} };
      mocks.clerk.user = mocks.user;
      publishUser();
    },
    signOut: vi.fn(async () => {
      mocks.signedIn = false;
      mocks.user = null;
      mocks.clerk.user = null;
      publishUser();
    }),
  };
  fetchMock = vi.fn(async (input, init) => {
    if (input.includes('/auth/handoff')) {
      return (await import('@/app/api/panel/auth/handoff/route')).POST(localRequest(input, init));
    }
    if (input.endsWith('/device/revoke')) {
      return (await import('@/app/api/panel/auth/device/revoke/route')).POST(localRequest(input, init));
    }
    if (input.endsWith('/device/status')) return Response.json({ present: false, clerkUserId: null });
    if (input.endsWith('/device/enroll')) enrollments += 1;
    return Response.json({ ok: true, plan: 'free' });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('round 2 handoff through the native provider, real callback handler and persisted route state', () => {
  it('opens the native launcher while the account SDK is still loading, then begins the browser handoff', async () => {
    mocks.userLoaded = false;
    await mount();
    const continueButton = await openNativeLauncher();
    expect(fetchMock.mock.calls.filter(([input]) => input.endsWith('/handoff?action=begin'))).toHaveLength(0);
    await act(async () => {
      continueButton.click();
      await vi.waitFor(() => expect(mocks.opened).toHaveBeenCalledOnce(), { timeout: 10000 });
    });
    expect(state.signedIn).toBe(false);
    expect(new URL(String(mocks.opened.mock.calls[0][0])).searchParams.has('state')).toBe(true);
  });

  it('rejects a delayed callback from a handoff begun before explicit sign-out', async () => {
    await mount();
    const raw = await beginHandoff();
    await act(async () => { await state.signOut(); });
    await deliver(raw);
    expect(mocks.ticket.mock.calls.length).toBe(0);
    expect(state.signedIn).toBe(false);
    expect(enrollments).toBe(0);
    expect(mocks.opened.mock.calls.length).toBe(1);
  });

  it('rejects that older callback after a process restart and loss of sessionStorage', async () => {
    await mount();
    const raw = await beginHandoff();
    await act(async () => { await state.signOut(); root.unmount(); });
    vi.resetModules();
    sessionStorage.clear();
    await mount();
    await deliver(raw);
    expect(mocks.ticket.mock.calls.length).toBe(0);
    expect(state.signedIn).toBe(false);
  });

  it('accepts and consumes a new handoff begun after sign-out at mode 0600', async () => {
    await mount();
    await act(async () => { await state.signOut(); });
    const raw = await beginHandoff();
    const target = join(dataDir, 'desktop-auth-handoff.json');
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    await deliver(raw);
    expect(mocks.ticket.mock.calls.length).toBe(1);
    expect(state.signedIn).toBe(true);
    expect(enrollments).toBe(1);
    expect(existsSync(target)).toBe(false);
    expect(document.querySelector('[role="dialog"][aria-label="Sign in to o8"]')).toBeNull();
  });

  it('accepts the durable nonce despite stale sessionStorage and rejects the older local nonce', async () => {
    await mount();
    const raw = await beginHandoff();
    const older = randomBytes(24).toString('hex');
    sessionStorage.setItem('o8:auth-state', older);
    await deliver(raw);
    expect(mocks.ticket.mock.calls.length).toBe(1);
    expect(state.signedIn).toBe(true);
    expect(mocks.opened.mock.calls.length).toBe(1);
    await deliver(`o8://auth/callback?state=${older}&ticket=${randomBytes(24).toString('hex')}`);
    expect(mocks.ticket.mock.calls.length).toBe(1);
    expect(mocks.opened.mock.calls.length).toBe(1);
  });

  it('does not open a browser when an earlier begin response arrives after sign-out', async () => {
    await mount();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const normal = fetchMock.getMockImplementation()!;
    let beginResponseReady = false;
    fetchMock.mockImplementation(async (input, init) => {
      const response = await normal(input, init);
      if (input.endsWith('/handoff?action=begin')) { beginResponseReady = true; await hold; }
      return response;
    });
    const button = await openNativeLauncher();
    await act(async () => {
      button.click();
      await vi.waitFor(() => expect(beginResponseReady).toBe(true), { timeout: 10000 });
    });
    expect(existsSync(join(dataDir, 'desktop-auth-handoff.json'))).toBe(true);
    try {
      await act(async () => { await state.signOut(); });
    } finally {
      await act(async () => { release(); });
    }
    expect(mocks.opened.mock.calls.length).toBe(0);
    expect(state.signedIn).toBe(false);
  });

  it('ignores an earlier validation response that arrives after sign-out', async () => {
    await mount();
    const raw = await beginHandoff();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const normal = fetchMock.getMockImplementation()!;
    const validation = { response: null as Response | null };
    fetchMock.mockImplementation(async (input, init) => {
      const response = await normal(input, init);
      if (input.endsWith('/handoff?action=validate')) { validation.response = response; await hold; }
      return response;
    });
    await deliver(raw);
    await vi.waitFor(() => expect(validation.response).not.toBeNull(), { timeout: 10000 });
    expect(await validation.response!.clone().json()).toMatchObject({ ok: true });
    expect(existsSync(join(dataDir, 'desktop-auth-handoff.json'))).toBe(false);
    try {
      await act(async () => { await state.signOut(); });
    } finally {
      await act(async () => { release(); });
    }
    expect(mocks.ticket.mock.calls.length).toBe(0);
    expect(state.signedIn).toBe(false);
    expect(enrollments).toBe(0);
  });

  it('does not report completed sign-out without durable handoff cancellation acknowledgement', async () => {
    await mount();
    await beginHandoff();
    await act(async () => {
      mocks.signedIn = true;
      mocks.user = { id: 'user_device', reload: async () => {} };
      mocks.clerk.user = mocks.user;
      publishUser();
    });
    expect(state.signedIn).toBe(true);
    expect(existsSync(join(dataDir, 'desktop-auth-handoff.json'))).toBe(true);
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (input.endsWith('/device/revoke') || input.endsWith('/handoff?action=cancel')) throw new Error('Unavailable');
      return normal(input, init);
    });
    await act(async () => { await expect(state.signOut()).rejects.toThrow('Sign-out failed. Try again.'); });
    expect(state.signedIn).toBe(true);
    expect(mocks.clerk.signOut).not.toHaveBeenCalled();
    expect(existsSync(join(dataDir, 'desktop-auth-handoff.json'))).toBe(true);
  });

  it('waits for a slow device revoke before completing sign-out', async () => {
    mocks.signedIn = true;
    mocks.user = { id: 'user_device', reload: async () => {} };
    mocks.clerk.user = mocks.user;
    await mount();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (input.endsWith('/device/revoke')) await hold;
      return normal(input, init);
    });
    let signOut!: Promise<void>;
    await act(async () => {
      signOut = state.signOut();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(mocks.clerk.signOut).not.toHaveBeenCalled();
    expect(state.signedIn).toBe(true);
    await act(async () => {
      release();
      await signOut;
      await vi.waitFor(() => expect(mocks.signedIn).toBe(false), { timeout: 10000 });
    });
    expect(state.signedIn).toBe(false);
  });

  it('preserves browser-mode sign-in without a native handoff request', async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    await mount();
    await act(async () => { state.signIn(); });
    expect(mocks.browserSignIn).toHaveBeenCalledExactlyOnceWith({ forceRedirectUrl: window.location.href, signUpForceRedirectUrl: window.location.href });
    expect(mocks.opened).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"][aria-label="Sign in to o8"]')).toBeNull();
    expect(fetchMock.mock.calls.filter(([input]) => input.includes('/auth/handoff')).length).toBe(0);
  });
});
