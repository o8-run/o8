import type { TmuxSnapshotCursor } from './terminal-resync-snapshot';

export const TERMINAL_RESYNC_IDLE_MS = 40;
export const TERMINAL_RESYNC_POLL_MS = 10;
export const TERMINAL_RESYNC_MAX_WAIT_MS = 500;
export const TERMINAL_RESYNC_FRESHNESS_RETRY_MS = 25;

export type TerminalResyncCapture = { ok: boolean; data: string; cursor?: TmuxSnapshotCursor | null };

export type TerminalResyncBarrierResult =
  | { status: 'cancelled'; waitedMs: number }
  | {
    status: 'ready';
    waitedMs: number;
    unsettled: boolean;
    capture: TerminalResyncCapture;
    captureAttempts: 1 | 2;
    freshnessLine: string | null;
    fallbackReason: 'capture-failed' | 'stale-snapshot' | null;
  };

type TerminalResyncBarrierOptions = {
  getLastOutputAt: () => number;
  getBatchBuffer: () => string;
  getScrollbackChunks: () => readonly string[];
  capture: () => TerminalResyncCapture;
  isCancelled: () => boolean;
  onUnsettled?: (waitedMs: number) => void;
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
};

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function stripTerminalControlSequences(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/gu, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    // Escapes with intermediates, such as the ESC ( B character-set reset in sgr0.
    .replace(/\x1b[ -/]+[0-~]/gu, '')
    .replace(/\x1b[@-_]/gu, '')
    .replaceAll('\r', '');
}

function scrollbackTail(chunks: readonly string[], maxBytes: number): string {
  const retained: Buffer[] = [];
  let remaining = maxBytes;
  for (let index = chunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const chunk = Buffer.from(chunks[index], 'utf8');
    if (chunk.byteLength <= remaining) {
      retained.push(chunk);
      remaining -= chunk.byteLength;
    } else {
      retained.push(chunk.subarray(chunk.byteLength - remaining));
      remaining = 0;
    }
  }
  return Buffer.concat(retained.reverse()).toString('utf8');
}

function splitCursorAddressedRows(value: string): string {
  return value.replace(/\x1b\[[\d;]*[Hf]/gu, '\n');
}

export function terminalResyncFreshnessLine(chunks: readonly string[]): string | null {
  const tail = splitCursorAddressedRows(scrollbackTail(chunks, 512));
  const lines = stripTerminalControlSequences(tail).split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line) return line.slice(-80);
  }
  return null;
}

function captureContainsFreshnessLine(capture: TerminalResyncCapture, freshnessLine: string | null): boolean {
  return capture.ok && (
    freshnessLine == null
    || stripTerminalControlSequences(capture.data).includes(freshnessLine)
  );
}

export async function waitForTerminalResyncBarrier(
  options: TerminalResyncBarrierOptions,
): Promise<TerminalResyncBarrierResult> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitForDelay;
  const startedAt = now();

  while (
    now() - options.getLastOutputAt() < TERMINAL_RESYNC_IDLE_MS
    || options.getBatchBuffer() !== ''
  ) {
    if (options.isCancelled()) return { status: 'cancelled', waitedMs: now() - startedAt };
    const waitedMs = now() - startedAt;
    if (waitedMs >= TERMINAL_RESYNC_MAX_WAIT_MS) break;
    await wait(Math.min(TERMINAL_RESYNC_POLL_MS, TERMINAL_RESYNC_MAX_WAIT_MS - waitedMs));
  }

  const waitedMs = now() - startedAt;
  if (options.isCancelled()) return { status: 'cancelled', waitedMs };
  const unsettled = (
    now() - options.getLastOutputAt() < TERMINAL_RESYNC_IDLE_MS
    || options.getBatchBuffer() !== ''
  );
  if (unsettled) options.onUnsettled?.(waitedMs);
  let freshnessLine = terminalResyncFreshnessLine(options.getScrollbackChunks());
  let capture = options.capture();
  if (!capture.ok) {
    return {
      status: 'ready',
      waitedMs,
      unsettled,
      capture,
      captureAttempts: 1,
      freshnessLine,
      fallbackReason: 'capture-failed',
    };
  }
  if (captureContainsFreshnessLine(capture, freshnessLine)) {
    return {
      status: 'ready',
      waitedMs,
      unsettled,
      capture,
      captureAttempts: 1,
      freshnessLine,
      fallbackReason: null,
    };
  }

  await wait(TERMINAL_RESYNC_FRESHNESS_RETRY_MS);
  if (options.isCancelled()) return { status: 'cancelled', waitedMs: now() - startedAt };
  freshnessLine = terminalResyncFreshnessLine(options.getScrollbackChunks());
  capture = options.capture();
  return {
    status: 'ready',
    waitedMs,
    unsettled,
    capture,
    captureAttempts: 2,
    freshnessLine,
    fallbackReason: captureContainsFreshnessLine(capture, freshnessLine)
      ? null
      : (capture.ok ? 'stale-snapshot' : 'capture-failed'),
  };
}
