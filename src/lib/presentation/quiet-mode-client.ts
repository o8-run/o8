'use client';

/**
 * Quiet-mode client store (#2147).
 *
 * Quiet mode lives in three places at once — the persisted operator default,
 * the Rust shell (which owns the overlay windows and the native banner), and
 * the React tree (which owns coach cards, status pills and toasts). This module
 * is the single client-side view of all three:
 *
 *   - `useQuietMode()` — subscribe from any component.
 *   - `setQuietMode(active)` — persist it, tell Rust, notify the tree.
 *   - `primeQuietMode(active)` — seed from an operator-defaults payload the
 *     caller already fetched, so the toggle never flashes the wrong state.
 *
 * Cross-window sync: the Rust command emits `o8:quiet-mode-changed` to every
 * window, so the dock and the other satellites learn about it too. Inside one
 * document we also fire a DOM CustomEvent, which is what makes the browser
 * (non-Tauri) path work at all.
 */

import { useSyncExternalStore } from 'react';

const TAURI_EVENT = 'o8:quiet-mode-changed';
const DOM_EVENT = 'o8:quiet-mode-changed';

let active = false;
let hydrated = false;
let hydrating: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

function publish(next: boolean): void {
  if (active === next) return;
  active = next;
  for (const listener of listeners) listener();
}

function emitToDocument(next: boolean): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(DOM_EVENT, { detail: { active: next } }));
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function invokeQuietMode(command: string, args?: Record<string, unknown>): Promise<{ active?: boolean } | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<{ active?: boolean } | void>(command, args) ?? {};
  } catch (error) {
    console.warn(`[quiet-mode] ${command} failed`, error);
    return null;
  }
}

// ── External store plumbing ──

export function subscribeQuietMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getQuietModeSnapshot(): boolean {
  return active;
}

/** Server render and the first client paint agree: quiet mode starts off. */
function getQuietModeServerSnapshot(): boolean {
  return false;
}

export function useQuietMode(): boolean {
  return useSyncExternalStore(subscribeQuietMode, getQuietModeSnapshot, getQuietModeServerSnapshot);
}

// ── Hydration + mutation ──

/** Seed the store from a payload the caller already has. Cheap, idempotent. */
export function primeQuietMode(next: boolean): void {
  hydrated = true;
  publish(next);
}

interface PresentationValues {
  presentationQuietMode?: boolean;
  notificationsReviewReady?: 'off' | 'on';
}

async function readPersistedPresentation(): Promise<PresentationValues | null> {
  try {
    const response = await fetch('/api/panel/operator-defaults?include=presentation', { cache: 'no-store' });
    if (!response.ok) return null;
    const payload = await response.json() as { values?: PresentationValues };
    return payload.values ?? null;
  } catch (error) {
    console.warn('[quiet-mode] settings read failed', error);
    return null;
  }
}

/**
 * Bring the native shell in line with what is persisted, once per document.
 *
 * The persisted operator default is the durable truth; the Rust shell starts
 * every launch with quiet mode off and review notifications on. So if the
 * operator left quiet mode on and the app restarted mid-recording, this is what
 * puts the overlays back down instead of letting them reappear. Same for the
 * review-notification preference, which Rust cannot read for itself.
 */
export async function loadQuietMode(): Promise<boolean> {
  if (hydrated) return active;
  if (hydrating) return hydrating;
  hydrating = (async () => {
    const values = await readPersistedPresentation();
    if (values?.notificationsReviewReady !== undefined) {
      await syncReviewNotificationSetting(values.notificationsReviewReady !== 'off');
    }
    const persisted = values?.presentationQuietMode === true;
    if (values) {
      const native = await invokeQuietMode('presentation_quiet_mode_set', { active: persisted });
      primeQuietMode(typeof native?.active === 'boolean' ? native.active : persisted);
      return active;
    }
    // No settings answer (offline route, first paint before the server is up):
    // fall back to whatever the shell currently reports.
    const native = await invokeQuietMode('presentation_quiet_mode_get');
    primeQuietMode(native?.active === true);
    return active;
  })();
  try {
    return await hydrating;
  } finally {
    hydrating = null;
  }
}

/**
 * Turn quiet mode on or off everywhere.
 *
 * Order matters: the native shell goes first so the overlay windows are already
 * down by the time the in-app surfaces re-render, and the operator default is
 * written last so a failed persist still leaves the screen clean rather than
 * leaving overlays up with the setting saved.
 */
export async function setQuietMode(next: boolean): Promise<boolean> {
  await invokeQuietMode('presentation_quiet_mode_set', { active: next });
  primeQuietMode(next);
  emitToDocument(next);
  try {
    const response = await fetch('/api/panel/operator-defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presentationQuietMode: next }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error ?? 'Quiet mode could not be saved.');
    }
  } catch (error) {
    console.warn('[quiet-mode] persist failed', error);
    throw error;
  }
  return next;
}

/**
 * Attach the cross-window listeners. Call once from a long-lived surface (the
 * dashboard does it). Returns a disposer.
 */
export function watchQuietMode(): () => void {
  if (typeof window === 'undefined') return () => {};
  const onDom = (event: Event) => {
    const detail = (event as CustomEvent<{ active?: boolean }>).detail;
    if (typeof detail?.active === 'boolean') publish(detail.active);
  };
  window.addEventListener(DOM_EVENT, onDom);

  let disposeTauri: (() => void) | null = null;
  let disposed = false;
  if (isTauriRuntime()) {
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen<{ active?: boolean }>(TAURI_EVENT, (event) => {
        if (typeof event.payload?.active === 'boolean') publish(event.payload.active);
      }))
      .then((unlisten) => {
        if (disposed) unlisten();
        else disposeTauri = unlisten;
      })
      .catch((error) => console.warn('[quiet-mode] listen failed', error));
  }

  // Other clients write the same settings route. Hydration alone leaves Rust
  // flags and React presentation stale for the rest of this app's lifetime.
  // Reconcile the presentation values route while the dashboard is mounted;
  // serialize reads so an older response cannot undo a newer one.
  let reading: Promise<void> | null = null;
  // Native recording controls may temporarily override quiet mode. Apply only
  // changes to the persisted preference after the initial hydration.
  let previous: PresentationValues | null = null;
  const reconcile = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (reading) return reading;
    reading = (async () => {
      const values = await readPersistedPresentation();
      if (!values || disposed) return;
      const quiet = values.presentationQuietMode === true;
      const notifications = values.notificationsReviewReady !== 'off';
      if (!previous || previous.notificationsReviewReady !== values.notificationsReviewReady) {
        if (!await syncReviewNotificationSetting(notifications)) return;
      }
      if (disposed) return;
      if (!previous || previous.presentationQuietMode !== values.presentationQuietMode) {
        const native = await invokeQuietMode('presentation_quiet_mode_set', { active: quiet });
        if (disposed || isTauriRuntime() && !native) return;
        primeQuietMode(typeof native?.active === 'boolean' ? native.active : quiet);
        emitToDocument(active);
      }
      previous = values;
    })().finally(() => { reading = null; });
    return reading;
  };
  const onFocus = () => reconcile();
  window.addEventListener('focus', onFocus);
  const timer = window.setInterval(onFocus, 1000);
  void reconcile();

  return () => {
    disposed = true;
    window.removeEventListener(DOM_EVENT, onDom);
    window.removeEventListener('focus', onFocus);
    window.clearInterval(timer);
    disposeTauri?.();
  };
}

/**
 * Mirror the standing review-notification preference into the native shell so
 * `notify_review_ready` can honour it (#2150). Safe to call on every settings
 * load; the Rust side just stores the last value it was told.
 */
export async function syncReviewNotificationSetting(enabled: boolean): Promise<boolean> {
  const native = await invokeQuietMode('set_review_notifications_enabled', { enabled });
  return !isTauriRuntime() || native !== null;
}

/** Test seam: forget hydration so a suite can drive the store from scratch. */
export function resetQuietModeForTests(): void {
  active = false;
  hydrated = false;
  hydrating = null;
  listeners.clear();
}
