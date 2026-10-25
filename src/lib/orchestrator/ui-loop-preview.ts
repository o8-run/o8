import 'server-only';

import { recordLaneEvent } from '@/lib/lane/events';
import { getLaneEvents } from '@/lib/lane/registry';
import { createO8WebviewBrowserHandlers } from '@/lib/mcp/o8-webview-browser-tools';
import { probeHttpHealth } from '@/lib/workspace/manifest/apply';

const PREVIEW_POLL_STEP_MS = 250;
const DEFAULT_PREVIEW_TIMEOUT_MS = 20_000;

export interface UiLoopPreviewCheck {
  kind: 'http' | 'browser';
  sequence: number;
  elapsedMs: number;
  ok: boolean;
  error?: string;
}

export type UiLoopPreviewResult = {
  state: 'ready' | 'timed_out' | 'unreachable' | 'no_preview';
  elapsedMs: number;
  checks: UiLoopPreviewCheck[];
  previewUrl?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function manifestPreviewUrl(laneId: string): string | null {
  const events = getLaneEvents(laneId, 500);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.verb === 'workspace_manifest_failed' || event.verb === 'workspace_manifest_services_stopped') return null;
    if (event.verb !== 'workspace_manifest_applied') continue;
    const preview = stringValue(event.payload.preview);
    if (preview) return preview;
  }
  return null;
}

function normalizedHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseToolJson(result: Awaited<ReturnType<ReturnType<typeof createO8WebviewBrowserHandlers>[string]>>): Record<string, unknown> {
  const content = result.content.find((item) => item.type === 'text');
  if (!content || content.type !== 'text') return { ok: false, error: 'Browser wait returned no text result.' };
  try {
    const parsed = JSON.parse(content.text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { ok: false, error: 'Browser wait returned an invalid result.' };
  } catch {
    return { ok: false, error: 'Browser wait returned an invalid result.' };
  }
}

function recordResult(
  laneId: string,
  packetId: string,
  result: UiLoopPreviewResult,
): UiLoopPreviewResult {
  recordLaneEvent(
    laneId,
    result.state === 'ready' ? 'ui_loop_preview_ready' : 'ui_loop_preview_failed',
    'orchestrator',
    { packetId, laneId, ...result },
  );
  return result;
}

export async function waitForPreviewReady(input: {
  packetId: string;
  laneId: string;
  url?: string | null;
  readySelector?: string | null;
  readyText?: string | null;
  timeoutMs?: number;
}): Promise<UiLoopPreviewResult> {
  const startedAt = Date.now();
  const checks: UiLoopPreviewCheck[] = [];
  const configuredUrl = manifestPreviewUrl(input.laneId) ?? stringValue(input.url);
  if (!configuredUrl) {
    return recordResult(input.laneId, input.packetId, { state: 'no_preview', elapsedMs: 0, checks });
  }
  const previewUrl = normalizedHttpUrl(configuredUrl);
  if (!previewUrl) {
    return recordResult(input.laneId, input.packetId, {
      state: 'unreachable',
      elapsedMs: 0,
      checks,
      previewUrl: configuredUrl,
    });
  }
  const timeoutMs = Number.isSafeInteger(input.timeoutMs) && Number(input.timeoutMs) > 0
    ? Number(input.timeoutMs)
    : DEFAULT_PREVIEW_TIMEOUT_MS;
  let sawHttpResponse = false;

  for (;;) {
    const elapsedBeforeProbe = Date.now() - startedAt;
    if (elapsedBeforeProbe >= timeoutMs) {
      return recordResult(input.laneId, input.packetId, {
        state: sawHttpResponse ? 'timed_out' : 'unreachable',
        elapsedMs: Math.min(timeoutMs, elapsedBeforeProbe),
        checks,
        previewUrl,
      });
    }
    const receipt = await probeHttpHealth(
      previewUrl,
      Math.max(1, Math.min(PREVIEW_POLL_STEP_MS, timeoutMs - elapsedBeforeProbe)),
    );
    const error = receipt.error?.trim();
    if (error?.startsWith('HTTP health probe returned ')) sawHttpResponse = true;
    checks.push({
      kind: 'http',
      sequence: checks.length + 1,
      elapsedMs: (checks.length) * PREVIEW_POLL_STEP_MS,
      ok: receipt.ok,
      ...(error ? { error } : {}),
    });
    if (receipt.ok) break;

    const nextProbeAt = startedAt + checks.length * PREVIEW_POLL_STEP_MS;
    const remainingMs = Math.min(nextProbeAt - Date.now(), startedAt + timeoutMs - Date.now());
    if (remainingMs <= 0) continue;
    await sleep(remainingMs);
  }

  const selector = stringValue(input.readySelector) ?? (stringValue(input.readyText) ? 'body' : null);
  if (selector) {
    const elapsedBeforeBrowser = Date.now() - startedAt;
    const remainingMs = timeoutMs - elapsedBeforeBrowser;
    if (remainingMs <= 0) {
      return recordResult(input.laneId, input.packetId, {
        state: 'timed_out',
        elapsedMs: timeoutMs,
        checks,
        previewUrl,
      });
    }
    const handler = createO8WebviewBrowserHandlers().o8_browser_wait;
    const result = parseToolJson(await handler({
      selector,
      ...(stringValue(input.readyText) ? { text: stringValue(input.readyText) } : {}),
      timeoutMs: remainingMs,
    }));
    const ok = result.ok === true;
    const error = stringValue(result.error)
      ?? (result.timedOut === true ? 'Browser readiness wait timed out.' : null);
    checks.push({
      kind: 'browser',
      sequence: checks.length + 1,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      ok,
      ...(error ? { error } : {}),
    });
    if (!ok) {
      return recordResult(input.laneId, input.packetId, {
        state: result.timedOut === true || result.pending === true ? 'timed_out' : 'unreachable',
        elapsedMs: Math.min(timeoutMs, Date.now() - startedAt),
        checks,
        previewUrl,
      });
    }
  }

  return recordResult(input.laneId, input.packetId, {
    state: 'ready',
    elapsedMs: Math.min(timeoutMs, Date.now() - startedAt),
    checks,
    previewUrl,
  });
}
