#!/usr/bin/env node
/**
 * publish-fixed — announce fixed reports in the public #fixed channel.
 *
 * The doctrine: intake is private (a report carries a screenshot of somebody's
 * whole screen and stack traces with their repo paths in them — that can never
 * go on a public board). The PUBLIC artifact is the fix. Open problems rot;
 * fixed ones never do. So we publish only wins, credited to whoever found them.
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
 *   3. This script posts to #fixed:
 *
 *        Diff panel went blank on large worktrees
 *        Reported by @kleosr · fixed in v0.1.592
 *
 *   4. scripts/release.mjs ships the same set as fixed.json, so the REPORTER's
 *      own app can tell them too — see scripts/lib/fixed-reports.mjs.
 *
 * `npm run ship` runs this automatically (release.mjs, after the public mirror
 * lands). Run it by hand to backfill or to preview.
 *
 * Usage:
 *   npm run publish:fixed -- --dry-run       # print, post nothing
 *   npm run publish:fixed -- --range v0.1.590..HEAD
 *
 * Webhook: O8_FIXED_WEBHOOK_URL, else `fixedWebhookUrl` in o8.release.json (the
 * gitignored release config that already holds the Sentry DSN). Absent → refuses
 * to run, rather than silently dropping somebody's credit.
 *
 * Idempotent: published ids are recorded in ~/.o8/feedback/published.json, so a
 * re-run on an overlapping range will not double-post.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
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
const EMBED_COLOR = 0x16a34a; // green — this channel only ever carries wins.

/** env wins; else the gitignored o8.release.json — never a literal in source. */
function resolveFixedWebhook() {
  const fromEnv = process.env.O8_FIXED_WEBHOOK_URL?.trim();
  if (fromEnv) return fromEnv;
  try {
    const cfg = JSON.parse(readFileSync(path.join(process.cwd(), 'o8.release.json'), 'utf8'));
    const url = typeof cfg.fixedWebhookUrl === 'string' ? cfg.fixedWebhookUrl.trim() : '';
    return url || null;
  } catch {
    return null;
  }
}

async function postFixed(webhookUrl, entry) {
  const credit = entry.reporter
    ? `Reported by @${entry.reporter} · fixed in v${entry.version}`
    : `Fixed in v${entry.version}`;

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'o8',
      embeds: [{
        // Never entry.title — that is the user's raw prose.
        title: entry.publicTitle || entry.title,
        description: credit,
        color: EMBED_COLOR,
        footer: { text: `report ${entry.id} · ${entry.sha}` },
      }],
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Discord returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ''}`);
  }
}

/**
 * Announce every unpublished fix in `range` and record it. Exported so
 * release.mjs can call it directly after the public mirror lands — announcing a
 * fix "in v0.1.592" before v0.1.592 exists would be a lie.
 */
export async function publishFixed({ range, dryRun = false, version = appVersion() } = {}) {
  const resolvedRange = range || defaultRange();
  const webhookUrl = resolveFixedWebhook();

  if (!webhookUrl && !dryRun) {
    throw new Error(
      'No #fixed webhook. Set O8_FIXED_WEBHOOK_URL, or add "fixedWebhookUrl" to o8.release.json.',
    );
  }

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

  // The reporter's raw prose is about to hit #fixed AND fixed.json, which is a
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

  for (const entry of entries) {
    if (dryRun) {
      console.log(`  [dry-run] ${entry.id} → v${version} — ${entry.reporter ? `@${entry.reporter}` : 'anonymous'}`);
      console.log(`            raw:    ${entry.title}`);
      console.log(`            public: ${entry.publicTitle}`);
    } else {
      await postFixed(webhookUrl, entry);
    }
  }

  if (!dryRun && entries.length > 0) {
    // Append, never replace — published.json is also what release.mjs turns into
    // the cumulative fixed.json manifest.
    writePublished([...published, ...entries]);
  }

  console.log(
    `${dryRun ? '[dry-run] ' : ''}Published ${entries.length} fix${entries.length === 1 ? '' : 'es'} from ${resolvedRange}.`,
  );

  // A trailer naming an id we have no record of is a silent hole in the loop:
  // somebody's report gets fixed and they are never told. Say so, loudly.
  if (missing.length > 0) {
    console.warn(`\n⚠ ${missing.length} trailer(s) reference an unknown report id — not published:`);
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
