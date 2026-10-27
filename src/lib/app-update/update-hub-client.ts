'use client';

import { useSyncExternalStore } from 'react';
import { fetchWithLongLivedBudget } from '@/lib/connection-budget';
import type { StableCli } from '@/lib/setup/cli-installation';
import type { CliUpdateProgress, CliUpdateStage } from '@/lib/setup/cli-update-progress';
import { readCliUpdateResponse } from './cli-update-response';
import { readCliDiscoveryResponse, type CliDiscoveryProgress } from './cli-discovery-response';
import type { CliUpdateRecord } from '@/lib/setup/cli-updates';
import type { ReleaseNotes } from './release-notes';
import type { UpdateProgress } from './client-restart';

export interface AppUpdateBlockers {
  /** Work a restart would interrupt. A restart waits for it. */
  live: string[];
  /** Tasks waiting for review or input. A confirmed restart keeps their state. */
  parked: string[];
}

export interface AppUpdateView {
  version: string | null;
  /** The running app's version, when the updater reported it. */
  currentVersion?: string | null;
  outcome: 'never' | 'available' | 'current' | 'failed';
  installing: boolean;
  message: string | null;
  error: string | null;
  downloadOnly: boolean;
  packageManager?: boolean;
  progress?: UpdateProgress | null;
  /** Set when the update is installed and its restart is waiting. */
  blockers?: AppUpdateBlockers | null;
}
interface UpdateHub {
  app: AppUpdateView;
  tools: CliUpdateRecord[];
  checking: boolean;
  checkingAll: boolean;
  cliBusy: string | null;
  cliProgress: Record<string, CliUpdateProgress>;
  cliDiscovery: CliDiscoveryProgress | null;
  cliDiscoveryChecked: string[];
  syncing: boolean;
  cliError: string | null;
  cliMessage: string | null;
  checkMessage: string | null;
  checkedAt: number;
}
const initial: UpdateHub = { app: { version: null, outcome: 'never', installing: false, message: null, error: null, downloadOnly: false },
  tools: [], checking: false, checkingAll: false, cliBusy: null, cliProgress: {}, cliDiscovery: null, cliDiscoveryChecked: [], syncing: false, cliError: null, cliMessage: null, checkMessage: null, checkedAt: 0 };
type AppCheckResult = { version: string | null; error?: string };
export type UpdateCheckResult = { hasUpdates: boolean; incomplete: boolean };
const global = globalThis as typeof globalThis & { __o8UpdateHub?: { snapshot: UpdateHub; listeners: Set<() => void>;
  check?: Promise<void>; sync?: Promise<void>; allCheck?: Promise<UpdateCheckResult>; appCheck?: () => Promise<AppCheckResult> } };
const hub = global.__o8UpdateHub ??= { snapshot: initial, listeners: new Set() };
// A running dev session can retain the shared hub through a module update.
if (!hub.snapshot.cliProgress) hub.snapshot = { ...hub.snapshot, cliProgress: {} };
if (!hub.snapshot.cliDiscoveryChecked) hub.snapshot = { ...hub.snapshot, cliDiscoveryChecked: [] };
function patch(value: Partial<UpdateHub>) { hub.snapshot = { ...hub.snapshot, ...value }; for (const listener of hub.listeners) listener(); }
export function publishAppUpdateView(app: AppUpdateView) {
  if (JSON.stringify(hub.snapshot.app) !== JSON.stringify(app)) {
    const newAction = (app.installing && !hub.snapshot.app.installing) || (app.message && app.message !== hub.snapshot.app.message);
    patch({ app, ...(newAction ? { checkMessage: null, cliMessage: null } : {}) });
  }
}
export function useUpdateHub() {
  return useSyncExternalStore(listener => { hub.listeners.add(listener); return () => hub.listeners.delete(listener); }, () => hub.snapshot, () => initial);
}

export function registerAppUpdateCheck(check: () => Promise<AppCheckResult>) {
  hub.appCheck = check;
  return () => { if (hub.appCheck === check) hub.appCheck = undefined; };
}

/** The default update action checks o8 only. Tool checks require opening Tools. */
export async function checkAppUpdates(): Promise<UpdateCheckResult> {
  if (hub.allCheck) return hub.allCheck;
  patch({ checkingAll: true, checkMessage: 'Checking o8…' });
  hub.allCheck = (async () => {
    const result = await (hub.appCheck ? hub.appCheck() : Promise.reject(new Error('unavailable')))
      .catch(() => ({ version: null, error: 'o8 update checking is unavailable.' }));
    patch({ checkMessage: result.error ? 'The o8 update check could not finish. Check again.' : result.version ? 'o8 update is ready.' : 'You’re up to date. o8 is current.' });
    return { hasUpdates: Boolean(result.version), incomplete: Boolean(result.error) };
  })().finally(() => { patch({ checkingAll: false }); hub.allCheck = undefined; });
  return hub.allCheck;
}

/** An explicit check combines app and installed CLI results without installing. */
export function checkAllUpdates(): Promise<UpdateCheckResult> {
  if (hub.allCheck) return hub.allCheck;
  patch({ checkingAll: true, checkMessage: 'Checking o8 and connected CLIs…', cliMessage: null });
  hub.allCheck = (async () => {
    const [app] = await Promise.all([
      hub.appCheck ? hub.appCheck().catch(() => ({ version: null, error: 'o8 update check failed.' }))
        : Promise.resolve({ version: null, error: 'o8 update checking is unavailable.' }),
      refreshCliUpdateView(true),
    ]);
    const installed = hub.snapshot.tools.filter(tool => tool.runtimeId !== 'gemini' && tool.status !== 'not-installed');
    const incompleteReport = ['codex', 'claude-code', 'grok'].some(runtime => hub.snapshot.tools.filter(tool => tool.runtimeId === runtime).length !== 1);
    const result = { hasUpdates: Boolean(app.version) || installed.some(tool => tool.status === 'update-available'),
      incomplete: incompleteReport || Boolean(app.error || hub.snapshot.cliError) || installed.some(tool => tool.status === 'unknown') };
    // A connected-CLI check failure is not an o8 update failure; say which check did not finish.
    const appIncomplete = Boolean(app.error);
    patch({ checkMessage: result.incomplete
      ? appIncomplete ? 'The o8 update check could not finish. Check again.'
        : app.version ? 'o8 update is ready. Some CLI checks could not finish.' : 'Some CLI checks could not finish. Check again.'
      : result.hasUpdates ? app.version ? 'Updates are ready.' : 'o8 is up to date. CLI updates are ready.'
        : 'You’re up to date. o8 and connected CLIs are current.' });
    return result;
  })().finally(() => { patch({ checkingAll: false }); hub.allCheck = undefined; });
  return hub.allCheck;
}

/** One shared check; opening a hover never installs or starts a model turn. */
export async function refreshCliUpdateView(fresh = false): Promise<void> {
  if (hub.check) {
    await hub.check;
    if (!fresh) return;
    // A manual retry must not reuse an older hover check.
    return refreshCliUpdateView(true);
  }
  const ttl = hub.snapshot.tools.some(tool => tool.status === 'unknown') ? 60_000 : 30 * 60_000;
  if (!fresh && Date.now() - hub.snapshot.checkedAt < ttl) return;
  hub.check = (async () => {
    patch({ checking: true, cliError: null, cliMessage: null, cliDiscovery: null, cliDiscoveryChecked: [], checkedAt: 0 });
    try {
      const response = await fetchWithLongLivedBudget(`/api/setup/cli-updates${fresh ? '?refresh=1' : ''}`, {
        // Cold probes can delay headers too. Keep the whole discovery bounded at
        // five minutes without the generic 45-second headers guard racing it.
        cache: 'no-store', headers: { Accept: 'text/event-stream' }, signal: AbortSignal.timeout(300_000),
      }, 300_000);
      const tools = await readCliDiscoveryResponse(response, {
        progress: cliDiscovery => {
          if (hub.snapshot.cliDiscovery?.completed !== cliDiscovery.completed || hub.snapshot.cliDiscovery?.total !== cliDiscovery.total) patch({ cliDiscovery });
        },
        tool: tool => patch({ cliDiscoveryChecked: [...hub.snapshot.cliDiscoveryChecked, tool.runtimeId], tools: hub.snapshot.tools.some(row => row.runtimeId === tool.runtimeId)
          ? hub.snapshot.tools.map(row => row.runtimeId === tool.runtimeId ? tool : row) : [...hub.snapshot.tools, tool] }),
      });
      // Keep streamed rows in their arrival order when the final report arrives.
      const order = new Map(hub.snapshot.tools.map((tool, index) => [tool.runtimeId, index]));
      patch({ tools: [...tools].sort((a, b) => (order.get(a.runtimeId) ?? order.size) - (order.get(b.runtimeId) ?? order.size)),
        cliDiscoveryChecked: tools.map(tool => tool.runtimeId), checkedAt: Date.now() });
    } catch { patch({ cliError: 'CLI checks couldn’t finish. Try again.' }); }
    finally { patch({ checking: false, cliDiscovery: null, cliDiscoveryChecked: [] }); }
  })().finally(() => { hub.check = undefined; });
  return hub.check;
}

/** Wait only for an explicitly started batch; never start an installer for an app update. */
export async function waitForConnectedCliUpdates(): Promise<void> {
  await hub.sync?.catch(() => {});
}

/** Explicit CLI action; each server installer retains its own idle and ownership checks. */
export async function synchronizeConnectedClis(runtimeId?: StableCli): Promise<void> {
  if (!runtimeId) throw new Error('Choose a tool to update explicitly.');
  if (hub.sync) return hub.sync;
  const startedAt = Date.now();
  const progress = (stage: CliUpdateStage, message?: string) => patch({ cliProgress: { ...hub.snapshot.cliProgress, [runtimeId]: { stage, startedAt, updatedAt: Date.now(), message } } });
  progress('checking');
  hub.sync = (async () => {
    patch({ syncing: true, cliError: null, cliMessage: 'Checking installed CLIs…', checkMessage: null });
    await refreshCliUpdateView(true);
    if (hub.snapshot.cliError) throw new Error(hub.snapshot.cliError);
    const connected = [runtimeId].map(runtime => {
      const matches = hub.snapshot.tools.filter(item => item.runtimeId === runtime);
      if (matches.length !== 1) throw new Error('The connected CLI report is incomplete. Check again before updating.');
      return matches[0]!;
    });
    const failures: string[] = [];
    const updated: CliUpdateRecord[] = [];
    for (const tool of connected) {
      if (tool.status === 'not-installed' || tool.status === 'current') continue;
      if (tool.status === 'unknown') {
        failures.push(`${tool.label}: the installed version or release could not be verified. Check again.`);
        continue;
      }
      patch({ cliBusy: tool.runtimeId, cliMessage: `Checking ${tool.label}…` });
      try {
        const response = await fetch('/api/setup/cli-updates', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({ runtime: tool.runtimeId }), signal: AbortSignal.timeout(360_000) });
        await readCliUpdateResponse(response, stage => { progress(stage); patch({ cliMessage: `${stage === 'installing' ? 'Updating' : stage === 'verifying' ? 'Verifying' : 'Checking'} ${tool.label}…` }); });
        progress('verifying');
        updated.push(tool);
      } catch (error) {
        failures.push(`${tool.label}: ${error instanceof Error ? error.message : 'The update could not finish.'}`);
      } finally { patch({ cliBusy: null }); }
    }
    // Refresh even after a partial failure so completed updates are visible.
    if (connected.some(tool => tool.status === 'update-available')) {
      await refreshCliUpdateView(true);
      if (hub.snapshot.cliError) failures.push(hub.snapshot.cliError);
      for (const tool of updated) {
        const matches = hub.snapshot.tools.filter(item => item.runtimeId === tool.runtimeId);
        if (matches.length !== 1 || matches[0]?.status !== 'current') {
          failures.push(`${tool.label}: the final version check could not confirm it is current. Check again.`);
        }
      }
    }
    if (failures.length) throw new Error(failures.join(' '));
    progress('succeeded');
    patch({ cliMessage: connected.every(tool => tool.status === 'not-installed') ? 'No supported CLIs are installed.'
      : runtimeId ? `${connected[0]!.label} is up to date.` : 'Connected CLIs are up to date.' });
  })().catch(error => { progress('failed', error instanceof Error ? error.message : 'CLI update could not finish.'); patch({ cliBusy: null, cliMessage: null, cliError: error instanceof Error ? error.message : 'CLI updates could not finish.' }); throw error; })
    .finally(() => { patch({ syncing: false }); hub.sync = undefined; });
  return hub.sync;
}

const notesTasks = new Map<string, { at: number; task: Promise<ReleaseNotes> }>();
export function loadCachedReleaseNotes(version = 'latest'): Promise<ReleaseNotes> {
  const key = `o8:release-notes:v1:${version}`;
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as { at: number; notes: ReleaseNotes } | null;
    if (saved?.notes.entries && Date.now() - saved.at < 6 * 60 * 60_000) return Promise.resolve(saved.notes);
  } catch { /* Local storage is optional. */ }
  const pending = notesTasks.get(version);
  if (pending && Date.now() - pending.at < 6 * 60 * 60_000) return pending.task;
  const task = (async () => {
    const response = await fetch(`/api/panel/o8-update-summary?version=${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('Release notes are unavailable.');
    const notes = await response.json() as ReleaseNotes;
    try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), notes })); } catch { /* Shared memory still caches the published result. */ }
    return notes;
  })().catch(error => { notesTasks.delete(version); throw error; });
  notesTasks.set(version, { at: Date.now(), task });
  return task;
}
