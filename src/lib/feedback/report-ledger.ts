import 'server-only';

/**
 * Report ledger — the local record of every bug/request the operator has filed.
 *
 * Intake is PRIVATE (the report + screenshot + crash traces go to a private ops
 * channel — someone's whole screen and their repo paths are in there). The public
 * artifact is the FIX: when a commit lands carrying `Fixes-Report: <id>`,
 * scripts/publish-fixed.mjs looks the id up here and records it in the public
 * fix manifest. Open problems stay private; closed ones go public.
 *
 * That is the only reason this file exists: a fix, weeks later, has to be able to
 * find out what the report SAID and who FILED it. Discord can't answer that — the
 * ops channel is not queryable and the reporter is not @-mentionable.
 *
 * Append-only JSONL at DATA_DIR/feedback/reports.jsonl. Never throws — a broken
 * ledger write must not fail the report the operator just spent a minute writing.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

/** Crockford-ish: no 0/O/1/I/L/U — these ids get read aloud and typed into commits. */
const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_LENGTH = 6;

export interface ReportRecord {
  /** Short, human-quotable id — goes in the commit trailer. */
  id: string;
  ts: number;
  category: 'bug' | 'request';
  /** One-line summary — the headline of the eventual fix receipt. */
  title: string;
  /**
   * Always null. The feedback pipeline no longer records who filed a report
   * (data minimization — the `#fixed` credit loop is retired). Field retained
   * for ledger-shape stability with older on-disk entries.
   */
  reporter: string | null;
  /** App version the report was filed against. */
  version: string;
  /**
   * Where this ledger row came from. 'local' = filed from THIS install (⌘⇧E)
   * — the only rows that earn a "you reported this" receipt. 'intake-sync' =
   * mirrored from the intake channel by the maintainer's sync (ops tooling);
   * without the marker the maintainer's box showed receipts for EVERYONE's
   * reports. Absent on rows written before 2026-07-14 — treated as 'local'
   * (a normal user's ledger only ever contains their own reports).
   */
  origin?: 'local' | 'intake-sync';
}

function dataDir(): string {
  return (
    getDataDir()
  );
}

export function feedbackDir(): string {
  return path.join(dataDir(), 'feedback');
}

export function reportLedgerPath(): string {
  return path.join(feedbackDir(), 'reports.jsonl');
}

/** A fresh report id. Not cryptographic — just short, unambiguous, and unique enough. */
export function newReportId(): string {
  let out = '';
  for (let i = 0; i < ID_LENGTH; i += 1) {
    out += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  }
  return out;
}

/**
 * Condense the report body into the line that will headline the fix receipt.
 * The operator writes prose ("the diff panel goes blank when the worktree is
 * big, every time"); the changelog wants one clean line.
 */
export function reportTitle(message: string): string {
  const line = message.replace(/\s+/g, ' ').trim();
  if (!line) return '(no description)';
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/** Append a report. Never throws — returns false when the write failed. */
export function recordReport(record: ReportRecord): boolean {
  try {
    const dir = feedbackDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const stamped: ReportRecord = { origin: 'local', ...record };
    appendFileSync(reportLedgerPath(), `${JSON.stringify(stamped)}\n`, 'utf8');
    return true;
  } catch (err) {
    try {
      console.error('[feedback] ledger append failed:', err instanceof Error ? err.message : err);
    } catch {
      /* swallow */
    }
    return false;
  }
}

/** Read every report. Malformed lines are skipped. Never throws. */
export function readReports(): ReportRecord[] {
  try {
    const file = reportLedgerPath();
    if (!existsSync(file)) return [];
    const out: ReportRecord[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as ReportRecord;
        if (parsed && typeof parsed.id === 'string' && typeof parsed.title === 'string') {
          out.push(parsed);
        }
      } catch {
        // skip malformed line
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Look one up by id (case-insensitive — the id gets retyped into commit messages). */
export function findReport(id: string): ReportRecord | null {
  const wanted = id.trim().toUpperCase();
  if (!wanted) return null;
  // Last write wins if an id ever collided.
  const matches = readReports().filter((r) => r.id.toUpperCase() === wanted);
  return matches.length > 0 ? matches[matches.length - 1] : null;
}
