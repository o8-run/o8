/**
 * Opt-in crash uploader. Default OFF: uploads happen ONLY when the operator has
 * enabled `telemetryOptIn` AND an ingest endpoint is configured
 * (O8_TELEMETRY_INGEST_URL env, or the `telemetryIngestUrl` operator setting).
 * When either is missing this is a pure no-op.
 *
 * No retry storm: a single POST attempt per interval with a bounded timeout. A
 * failed attempt simply leaves the cursor untouched and retries next interval.
 * Never throws.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  resolveTelemetryIngestUrlSync,
  resolveTelemetryOptInSync,
} from '@/lib/operator/defaults';
import { readCrashRecords, telemetryDir, type CrashRecord } from './crash-store';
import { recurring } from '@/lib/background-work/ledger';

const UPLOAD_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 30 * 1000;
const UPLOAD_TIMEOUT_MS = 10 * 1000;
const MAX_BATCH = 200;

export type UploadStatus = 'disabled' | 'empty' | 'uploaded' | 'failed' | 'error';

interface UploadCursor {
  lastUploadedTs: number;
}

function cursorPath(): string {
  return path.join(telemetryDir(), 'upload-cursor.json');
}

function resolveIngestUrl(): string {
  const fromEnv = process.env.O8_TELEMETRY_INGEST_URL?.trim();
  if (fromEnv) return fromEnv;
  try {
    return resolveTelemetryIngestUrlSync();
  } catch {
    return '';
  }
}

function readCursor(): UploadCursor {
  try {
    const file = cursorPath();
    if (!existsSync(file)) return { lastUploadedTs: 0 };
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<UploadCursor>;
    const ts = typeof parsed.lastUploadedTs === 'number' && Number.isFinite(parsed.lastUploadedTs)
      ? parsed.lastUploadedTs
      : 0;
    return { lastUploadedTs: ts };
  } catch {
    return { lastUploadedTs: 0 };
  }
}

async function writeCursor(cursor: UploadCursor): Promise<void> {
  try {
    await mkdir(telemetryDir(), { recursive: true });
    await writeFile(cursorPath(), `${JSON.stringify(cursor, null, 2)}\n`, 'utf8');
  } catch {
    // best-effort — a lost cursor at worst re-uploads a bounded batch.
  }
}

/**
 * Run one upload pass. Returns a status describing what happened. Never throws.
 */
export async function runTelemetryUpload(): Promise<UploadStatus> {
  try {
    if (!resolveTelemetryOptInSync()) return 'disabled';
    const ingestUrl = resolveIngestUrl();
    if (!ingestUrl) return 'disabled';

    const cursor = readCursor();
    const pending = readCrashRecords()
      .filter((r) => r.ts > cursor.lastUploadedTs)
      .slice(0, MAX_BATCH);
    if (pending.length === 0) return 'empty';

    const maxTs = pending.reduce((max: number, r: CrashRecord) => (r.ts > max ? r.ts : max), cursor.lastUploadedTs);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    let ok = false;
    try {
      const res = await fetch(ingestUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'o8', count: pending.length, records: pending }),
        signal: controller.signal,
      });
      ok = res.ok;
    } catch {
      ok = false;
    } finally {
      clearTimeout(timer);
    }

    if (!ok) {
      console.warn('[telemetry] crash upload attempt failed — will retry next interval');
      return 'failed';
    }

    await writeCursor({ lastUploadedTs: maxTs });
    console.log(`[telemetry] uploaded ${pending.length} crash record(s)`);
    return 'uploaded';
  } catch (err) {
    try {
      console.error('[telemetry] upload pass error:', err instanceof Error ? err.message : err);
    } catch {
      /* swallow */
    }
    return 'error';
  }
}

interface UploaderGlobal {
  __o8TelemetryUploadLoopStarted?: boolean;
}

/**
 * Start the periodic upload loop (idempotent). Each tick is a cheap no-op when
 * telemetry is off. Timers are unref'd so they never keep the process alive.
 */
export function startTelemetryUploadLoop(): void {
  try {
    const g = globalThis as unknown as UploaderGlobal;
    if (g.__o8TelemetryUploadLoopStarted) return;
    g.__o8TelemetryUploadLoopStarted = true;

    const initial = setTimeout(() => { void runTelemetryUpload(); }, INITIAL_DELAY_MS);
    const interval = recurring('telemetry-upload', () => { void runTelemetryUpload(); }, UPLOAD_INTERVAL_MS);
    if (typeof initial.unref === 'function') initial.unref();
    if (typeof interval.unref === 'function') interval.unref();
  } catch {
    // never block boot
  }
}
