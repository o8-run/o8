'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { installTauriClerkFetchGuard } from '@/lib/auth/clerk-fetch-guard';
import { isLoopbackHostname } from '@/lib/auth/loopback-request';

// The Clerk publishable key is app-wide and public, baked into the build at ship
// time. When it's absent (fresh build with no Clerk app yet), Clerk is disabled
// and o8 boots fully account-less — sign-in is optional by design.
const CLERK_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const CLERK_ENABLED = Boolean(CLERK_PUBLISHABLE_KEY);

export interface O8AuthUser {
  /** Clerk user id */
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface O8AuthState {
  /** Whether Clerk is configured in this build at all. */
  clerkEnabled: boolean;
  /** Clerk finished resolving its session state. */
  isLoaded: boolean;
  signedIn: boolean;
  user: O8AuthUser | null;
  /** Deliberate account-less mode for a local web development workspace. */
  localWorkspaceOnly?: boolean;
  /** Native account engine startup is distinct from confirmed sign-out. */
  accountConnection?: 'initializing' | 'unavailable';
  retryAccountConnection?: () => void;
  /** Open sign-in: native handoff dialog, or Clerk's browser modal. */
  signIn: () => void;
  /** Open Clerk's account-management modal ("Manage account"). */
  openManageAccount: () => void;
  /** End the current session. */
  signOut: () => Promise<void>;
}

const DISABLED_STATE: O8AuthState = {
  clerkEnabled: false,
  isLoaded: true,
  signedIn: false,
  user: null,
  signIn: () => {
    console.warn('[auth] sign-in requested but Clerk is not configured in this build');
  },
  openManageAccount: () => {},
  signOut: async () => {},
};

const O8AuthContext = createContext<O8AuthState>(DISABLED_STATE);

/**
 * The shared auth hook for retained shell webviews. Reads from O8AuthContext,
 * so consumers never call Clerk hooks directly and work unchanged whether or
 * not Clerk is configured.
 */
export function useO8Auth(): O8AuthState {
  return useContext(O8AuthContext);
}

/**
 * Shell auth provider. The retained webview layouts share one identity through
 * src/components/shell-layout.tsx. No-op (account-less) when no
 * Clerk key is baked into the build.
 */
export function O8AuthProvider({ children }: { children: ReactNode }) {
  if (!CLERK_ENABLED) {
    return <O8AuthContext.Provider value={DISABLED_STATE}>{children}</O8AuthContext.Provider>;
  }
  return <ClerkSessionHost>{children}</ClerkSessionHost>;
}

// Type only — the runtime import is deferred into the effect below so Next's
// static build never evaluates the plugin's Tauri APIs (no Tauri at build time).
type NativeClerk = Awaited<ReturnType<(typeof import('tauri-plugin-clerk'))['initClerk']>>;
type AccountSessionModule = typeof import('./ClerkAccountSession');

/**
 * Picks the Clerk session engine per surface:
 *  - Tauri desktop → NATIVE mode via tauri-plugin-clerk: clerk-js runs with
 *    standardBrowser:false, routes the Frontend API through Rust, and persists
 *    the session token to a Tauri store on disk. REQUIRED because a PRODUCTION
 *    Clerk instance keeps its session in a cross-site cookie that macOS WKWebView
 *    won't return to the 127.0.0.1 webview origin — so the standard cookie flow
 *    flashes the session in then drops it. (Root-fixed 2026-07-05; see
 *    the desktop sign-in flow.)
 *  - Web / mobile → standard cookie mode (same-origin with the real o8.run domain).
 * While the native engine starts, workspace children remain available and the
 * account stays unresolved. Failed initialization has an explicit retry.
 */
function ClerkSessionHost({ children }: { children: ReactNode }) {
  const [engine, setEngine] = useState<NativeClerk | 'web' | 'local' | null>(null);
  const [accountAuth, setAccountAuth] = useState<O8AuthState>(DISABLED_STATE);
  const [connectionUnavailable, setConnectionUnavailable] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [AccountSession, setAccountSession] = useState<AccountSessionModule['ClerkAccountSession'] | null>(null);
  const pendingNativeEngine = useRef<Promise<NativeClerk> | null>(null);
  const pendingAccountSession = useRef<Promise<AccountSessionModule> | null>(null);
  const originalNativeFetch = useRef<typeof fetch | null>(null);
  const retryAccountConnection = useCallback(() => {
    setConnectionUnavailable(false);
    setConnectionAttempt(attempt => attempt + 1);
  }, []);

  useEffect(() => {
    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    if (!isTauri) {
      if (process.env.NODE_ENV === 'development'
        && CLERK_PUBLISHABLE_KEY?.startsWith('pk_live_')
        && isLoopbackHostname(globalThis.location?.hostname)) {
        setEngine('local');
        return;
      }
      setEngine('web');
      return;
    }
    let active = true;
    const nativeFetch = originalNativeFetch.current ?? globalThis.fetch;
    originalNativeFetch.current = nativeFetch;
    const timer = window.setTimeout(() => {
      if (active) setConnectionUnavailable(true);
    }, 8000);
    // Client-only dynamic import — the plugin touches Tauri globals, so it must
    // never load during Next's SSR/static export.
    // A retry observes an unresolved initialization instead of starting it twice.
    const attempt = pendingNativeEngine.current ?? import('tauri-plugin-clerk')
      .then(m => m.initClerk(undefined, m.noopLogger()));
    pendingNativeEngine.current = attempt;
    attempt
      .then((clerk) => {
        if (!active) return;
        window.clearTimeout(timer);
        installTauriClerkFetchGuard(nativeFetch);
        setEngine(clerk);
      })
      .catch(() => {
        if (pendingNativeEngine.current === attempt) pendingNativeEngine.current = null;
        if (!active) return;
        window.clearTimeout(timer);
        // Keep native diagnostics useful without logging SDK errors or credentials.
        console.error('[auth] native Clerk init failed; retry in Account settings');
        setConnectionUnavailable(true);
      });
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [connectionAttempt]);

  // Optional SDK loading has its own bounded, retryable stage. Keep failures
  // inside account state so a missing chunk cannot tear down the workspace.
  useEffect(() => {
    if (engine === null || engine === 'local' || AccountSession) return;
    let active = true;
    setConnectionUnavailable(false);
    const timer = window.setTimeout(() => {
      if (active) setConnectionUnavailable(true);
    }, 8000);
    const attempt = pendingAccountSession.current ?? import('./ClerkAccountSession');
    pendingAccountSession.current = attempt;
    attempt.then(module => {
      const Client = module.ClerkAccountSession;
      if (!active) return;
      window.clearTimeout(timer);
      setConnectionUnavailable(false);
      setAccountSession(() => Client);
    }).catch(() => {
      if (pendingAccountSession.current === attempt) pendingAccountSession.current = null;
      if (!active) return;
      window.clearTimeout(timer);
      setConnectionUnavailable(true);
    });
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [engine, connectionAttempt, AccountSession]);

  const accountPending = engine === null || (engine !== 'local' && !accountAuth.clerkEnabled);
  const value: O8AuthState = accountPending ? {
    ...DISABLED_STATE, clerkEnabled: true, isLoaded: false,
    accountConnection: connectionUnavailable ? 'unavailable' : 'initializing',
    retryAccountConnection,
  } : engine === 'local' ? { ...DISABLED_STATE, localWorkspaceOnly: true } : accountAuth;

  // Account startup may settle after the workspace is already in use. Keep its
  // provider ancestry and child position stable so recovery preserves local UI state.
  return (
    <O8AuthContext.Provider value={value}>
      {engine === null || engine === 'local' || !AccountSession ? null : (
        <AccountSession engine={engine} onAuthChange={setAccountAuth} />
      )}
      {children}
    </O8AuthContext.Provider>
  );
}
