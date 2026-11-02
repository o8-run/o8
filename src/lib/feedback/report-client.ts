'use client';

/**
 * Shared client helpers for the one-way beta feedback/error intake — the
 * "report this" flow that posts a note + optional screenshot to the team
 * Discord via /api/feedback/report. Used by the global IDE hotkey host
 * (ReportIssueHost), the canvas feedback popover (CanvasFeedbackButton), and
 * the Settings form (ReportIssueSection), so the capture + submit logic lives
 * in ONE place instead of three near-identical copies.
 */

import { isTauri } from '@/lib/tauri/bridge';
import { REPORT_DATA_SHARING_OFF_ERROR, REPORT_DATA_SHARING_OFF_MESSAGE } from '@/lib/feedback/data-sharing';
import { readReportDataSharingEnabled } from '@/lib/feedback/report-data-sharing-client';
import {
  collectWorkspaceIntrospection,
  readSpawnJournal,
  type SpawnJournalEntry,
} from '@/lib/feedback/workspace-introspect';

export const MAX_REPORT_MESSAGE = 4000;
export const MAX_REPORT_IMAGE_BYTES = 8 * 1024 * 1024;

export type ReportCategory = 'bug' | 'request';

export interface ReportImage {
  dataUrl: string;
  name: string;
}

/**
 * Capture the o8 app window as a PNG data URL (Tauri only, via the Rust
 * `capture_app_window` command). Returns null when capture is unavailable
 * (web build) or denied — callers fall back to letting the user paste/drop a
 * shot. Capture BEFORE opening the report modal so the shot shows the app
 * state, not the modal itself.
 */
export async function captureAppWindow(): Promise<ReportImage | null> {
  try {
    if (!isTauri()) return null;
    const { invoke } = await import('@tauri-apps/api/core');
    const b64 = await invoke<string | null>('capture_app_window');
    if (typeof b64 === 'string' && b64) {
      return { dataUrl: `data:image/png;base64,${b64}`, name: 'o8-window.png' };
    }
  } catch {
    /* no capture — the operator can still paste/drop a shot */
  }
  return null;
}

/**
 * Read an image File into a data-URL attachment, enforcing the size cap.
 * Resolves an error string instead of throwing so callers surface it inline.
 */
export function fileToReportImage(
  file: File | null | undefined,
): Promise<{ ok: true; image: ReportImage } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    if (!file || !file.type.startsWith('image/')) {
      resolve({ ok: false, error: 'That file is not an image.' });
      return;
    }
    if (file.size > MAX_REPORT_IMAGE_BYTES) {
      resolve({ ok: false, error: 'Screenshot too large (max 8 MB).' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve({ ok: true, image: { dataUrl: reader.result, name: file.name || 'screenshot.png' } });
      } else {
        resolve({ ok: false, error: 'Could not read that image.' });
      }
    };
    reader.onerror = () => resolve({ ok: false, error: 'Could not read that image.' });
    reader.readAsDataURL(file);
  });
}

export interface ClientDiagnostics {
  ui: {
    innerW: number;
    innerH: number;
    dpr: number;
    uiZoom: string;
    bodyScrollTop: number;
    docScrollTop: number;
    /** Top of the dashboard root rect — a non-zero value means the whole app
     *  shell is shifted out of the window (the 0.1.605/607 body-scroll bug
     *  read as dashboardTop −491). */
    dashboardTop: number | null;
    palette: string;
    surface: string;
  } | null;
  /** Tail of the Rust-side webview error ring buffer (console.error +
   *  window error/unhandledrejection — includes non-crash forensics like the
   *  swallowed [workspace-spawn] failures). */
  consoleErrors: Array<{ message: string; source: string; lineno: number; timestamp: number }>;
  platform: string;
  /** Workspace tile/tab truth at report time (GQXEZD forensics): which tiles
   *  exist, which have live handles, what tabs each workspace holds. */
  workspace: Record<string, unknown> | null;
  /** Breadcrumbs from the session-spawn paths — proves whether a "New session
   *  did nothing" click reached the handler and where the tab went. */
  spawnJournal: SpawnJournalEntry[];
}

/**
 * Snapshot the client-side state that crash-only telemetry can never see:
 * layout/geometry drift, zoom, theme, and the console-error ring buffer.
 * Every field is best-effort — a diagnostics failure must never block the
 * report itself.
 */
export async function collectClientDiagnostics(): Promise<ClientDiagnostics> {
  const result: ClientDiagnostics = { ui: null, consoleErrors: [], platform: 'unknown', workspace: null, spawnJournal: [] };
  try {
    const workspace = collectWorkspaceIntrospection();
    result.workspace = Object.keys(workspace).length > 0 ? workspace : null;
    result.spawnJournal = readSpawnJournal();
  } catch {
    /* introspection unavailable — report still goes */
  }
  try {
    result.platform = typeof navigator !== 'undefined' ? navigator.platform || 'unknown' : 'unknown';
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      const dash = document.querySelector('[data-mcp-scope="dashboard"]');
      const rootStyle = getComputedStyle(document.documentElement);
      result.ui = {
        innerW: window.innerWidth,
        innerH: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        uiZoom: rootStyle.getPropertyValue('--ui-zoom').trim() || '1',
        bodyScrollTop: document.body?.scrollTop ?? 0,
        docScrollTop: document.documentElement.scrollTop,
        dashboardTop: dash ? Math.round(dash.getBoundingClientRect().top) : null,
        palette: document.documentElement.dataset.palette ?? '',
        surface: document.documentElement.dataset.surface ?? '',
      };
    }
  } catch {
    /* geometry unavailable — report still goes */
  }
  try {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      const buffer = await invoke<{ errors?: Array<{ message?: string; source?: string; lineno?: number; timestamp?: number }> }>('o8_view_console_errors');
      result.consoleErrors = (buffer?.errors ?? [])
        .slice(-20)
        .map((entry) => ({
          message: String(entry?.message ?? '').slice(0, 600),
          source: String(entry?.source ?? '').slice(0, 200),
          lineno: Number(entry?.lineno ?? 0),
          timestamp: Number(entry?.timestamp ?? 0),
        }));
    }
  } catch {
    /* ring buffer unavailable — report still goes */
  }
  return result;
}

/**
 * POST a report to the private team intake. `route` records where it fired.
 *
 * Resolves the short report id the server assigned. That id is the operator's
 * receipt: a commit carrying `Fixes-Report: <id>` puts the fix in the public
 * manifest their own app reads. Show it — an id they never saw is a fix they
 * can never connect back to the thing they reported.
 *
 * Diagnostics ride along by DEFAULT (Q ruling 2026-07-15 — "when he sends a
 * screenshot we get the logs"): the crash digest (server-side), the console
 * ring buffer, and the UI-state snapshot. Reports are private at intake.
 * Callers can pass `includeDiagnostics: false` to opt a report out.
 */
export async function submitReport(input: {
  category: ReportCategory;
  message: string;
  route: string;
  image?: ReportImage | null;
  includeDiagnostics?: boolean;
}): Promise<{ ok: true; reportId: string | null } | { ok: false; error: string; code?: string }> {
  try {
    const dataSharingEnabled = await readReportDataSharingEnabled().catch(() => false);
    if (!dataSharingEnabled) {
      return {
        ok: false,
        error: REPORT_DATA_SHARING_OFF_MESSAGE,
        code: REPORT_DATA_SHARING_OFF_ERROR,
      };
    }

    const includeDiagnostics = input.includeDiagnostics !== false;
    const client = includeDiagnostics ? await collectClientDiagnostics() : null;
    const response = await fetch('/api/feedback/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: input.category,
        message: input.message,
        route: input.route,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
        image: input.image ? { dataUrl: input.image.dataUrl, name: input.image.name } : undefined,
        includeDiagnostics,
        client: client ?? undefined,
      }),
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; message?: string; reportId?: string } | null;
    if (!response.ok || !body?.ok) {
      return {
        ok: false,
        error: body?.message || body?.error || `Report failed (HTTP ${response.status}).`,
        code: body?.error,
      };
    }
    return { ok: true, reportId: typeof body.reportId === 'string' ? body.reportId : null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Report failed.' };
  }
}
