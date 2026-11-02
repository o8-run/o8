#!/usr/bin/env node
/**
 * publish-fixed — record fixed reports so the reporter's own app can tell them.
 *
 * The doctrine: intake is private (a report carries a screenshot of somebody's
 * whole screen and stack traces with their repo paths in them — that can never
 * go on a public board). The PUBLIC artifact is the fix. Open problems rot;
 * fixed ones never do. So we publish only wins.
 *
 * The loop:
 *   1. Operator files a report  → private ops channel + a short id (A7F3K2),
 *                                 recorded in ~/.o8/feedback/reports.jsonl
 *   2. You fix it, and the commit carries a trailer:
 *
 *        fix(diff): stop blanking the panel on large worktrees
 *
 *        Fixes-Report: A7F3K2
 *
 *   3. This script records the fix in ~/.o8/feedback/published.json.
 *   4. scripts/release.mjs ships that set as fixed.json, so the REPORTER's own
 *      app can tell them — see scripts/lib/fixed-reports.mjs.
 *
 * The public #fixed Discord channel was retired on 2026-10-28; nothing is
 * posted anywhere.
 *
 * `npm run ship` runs this automatically (release.mjs, after the public mirror
 * lands). Run it by hand to backfill or to preview.
 *
 * Usage:
 *   npm run publish:fixed -- --dry-run       # print, record nothing
 *   npm run publish:fixed -- --range v0.1.590..HEAD
 *
 * Idempotent: recorded ids are kept in ~/.o8/feedback/published.json, so a
 * re-run on an overlapping range will not record twice.
 */

import {
  appVersion,
  defaultRange,
  publishedPath,
  resolveNewFixes,
  writePublished,
} from './lib/fixed-reports.mjs';
import { syncReports } from './sync-reports.mjs';
import { publicTitle } from './lib/sanitize-title.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const rangeFlag = process.argv.indexOf('--range');
/**
 * Record every unrecorded fix in `range`. Exported so release.mjs can call it
 * directly after the public mirror lands — a receipt saying "fixed in v0.1.592"
 * before v0.1.592 exists would be a lie.
 */
export async function publishFixed({ range, dryRun = false, version = appVersion() } = {}) {
  const resolvedRange = range || defaultRange();
  // Pull the intake channel into the local ledger FIRST. A user's report was
  // recorded on THEIR machine, never ours — without this, every fix we ship for
  // somebody else's bug resolves to "unknown report id" and is silently dropped.
  // Best-effort: a missing bot token must not block a release, but it does mean
  // only self-filed reports resolve, so say so.
  try {
    const { fresh } = await syncReports({ dryRun });
    if (fresh.length > 0) {
      console.log(`[publish-fixed] imported ${fresh.length} report(s) from the intake channel`);
    }
  } catch (err) {
    console.warn(`⚠ could not sync the intake channel: ${err instanceof Error ? err.message : err}`);
    console.warn('  Only reports filed on THIS machine will resolve — a fix for someone else\'s bug will be skipped.');
  }

  const { entries, missing, published } = resolveNewFixes(resolvedRange, version);

  // The reporter's raw prose is about to hit fixed.json, which is a
  // world-readable URL. Clean it first: a free model rewrites it into a neutral
  // bug title, over a deterministic redactor that always runs. The raw text stays
  // in the private ledger for triage and is never published.
  for (const entry of entries) {
    const { title, via } = await publicTitle(entry.title);
    entry.publicTitle = title;
    if (via === 'redact' && !dryRun) {
      console.warn(`  ⚠ ${entry.id}: title polish unavailable — publishing the redacted text`);
    }
  }

  if (dryRun) {
    for (const entry of entries) {
      console.log(`  [dry-run] ${entry.id} → v${version} — ${entry.reporter ? `@${entry.reporter}` : 'anonymous'}`);
      console.log(`            raw:    ${entry.title}`);
      console.log(`            public: ${entry.publicTitle}`);
    }
  }

  if (!dryRun && entries.length > 0) {
    // Append, never replace — published.json is also what release.mjs turns into
    // the cumulative fixed.json manifest.
    writePublished([...published, ...entries]);
  }

  console.log(
    `${dryRun ? '[dry-run] ' : ''}Recorded ${entries.length} fix${entries.length === 1 ? '' : 'es'} from ${resolvedRange}.`,
  );

  // A trailer naming an id we have no record of is a silent hole in the loop:
  // somebody's report gets fixed and they are never told. Say so, loudly.
  if (missing.length > 0) {
    console.warn(`\n⚠ ${missing.length} trailer(s) reference an unknown report id — not recorded:`);
    for (const { id, commit } of missing) {
      console.warn(`  ${id} (${commit.sha} "${commit.subject}") — no such id in ${publishedPath().replace('published.json', 'reports.jsonl')}`);
    }
    console.warn('  The report was filed on another machine, or the id was mistyped.');
  }

  return { entries, missing };
}

// CLI entry — skipped when release.mjs imports publishFixed().
if (import.meta.url === `file://${process.argv[1]}`) {
  publishFixed({
    range: rangeFlag >= 0 ? process.argv[rangeFlag + 1] : undefined,
    dryRun: DRY_RUN,
  }).catch((err) => {
    console.error('✗ publish-fixed failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
