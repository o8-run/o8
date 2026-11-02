#!/usr/bin/env node
/**
 * reports — the agent-facing view of the user bug queue.
 *
 * The operator will not remember report ids or the `Fixes-Report:` trailer, and
 * should not have to. An agent loads the `reports` skill, runs this, and sees the
 * whole queue with what's been tried.
 *
 * A note is not bookkeeping. If we attempt a fix and fail, or can't reproduce, the
 * person who filed it hears NOTHING — which is the same rot we refused to build a
 * public board for, just hidden in a private channel. `needs-info` is how we ask
 * them for help, and it reaches them in-app.
 *
 * Commands:
 *   npm run reports                        # the queue: open first, oldest first
 *   npm run reports -- show FYPPHK         # one report + its full note history
 *   npm run reports -- note FYPPHK "tried X, popup still sticks"
 *   npm run reports -- status FYPPHK needs-info --note "which OS + can you screen-record it?"
 *   npm run reports -- status FYPPHK wont-fix --note "by design"
 *
 * Notes and status changes are mirrored to a THREAD on the original report message
 * in the private intake channel — so the record lives where the report does, and
 * survives this machine.
 *
 * `fixed` is NOT set here. It is set by the commit trailer at ship time, so the
 * code and the receipt can never disagree. See scripts/publish-fixed.mjs.
 */

import {
  PUBLIC_STATUSES,
  STATUSES,
  ledgerPath,
  readLedger,
  readPublished,
  readStatus,
  recordStatus,
} from './lib/fixed-reports.mjs';
import { syncReports } from './sync-reports.mjs';
import { resolveIntakeReconciliation } from './lib/intake-reconciliation.mjs';
import { requireFeedbackChannelId } from './lib/feedback-channel.mjs';
import { publicTitle } from './lib/sanitize-title.mjs';
import { appendFileSync } from 'node:fs';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const COLOR = {
  open: '\x1b[33m',           // amber — needs a decision
  triaged: '\x1b[36m',
  attempted: '\x1b[35m',
  'needs-info': '\x1b[34m',
  'cant-reproduce': '\x1b[2m',
  'wont-fix': '\x1b[2m',
  fixed: '\x1b[32m',          // green
};

/**
 * Mirror a note onto a thread hanging off the original report message, so the
 * trail lives next to the report itself instead of only in a local file.
 * Best-effort — a Discord outage must not lose the note, which is already on disk.
 */
async function mirrorToDiscord(report, { status, note }) {
  const { inspection, credential } = resolveIntakeReconciliation();
  if (!credential || !report.messageId) {
    const why = !credential
      ? `intake reconciliation ${inspection.status}`
      : 'no message id (run sync:reports)';
    return { ok: false, why };
  }
  let channelId;
  try {
    channelId = requireFeedbackChannelId();
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : 'intake channel unavailable' };
  }

  const headers = { Authorization: `Bot ${credential}`, 'Content-Type': 'application/json' };
  const api = 'https://discord.com/api/v10';

  const parts = [];
  if (status) parts.push(`**${status}**`);
  if (note) parts.push(note);
  const content = parts.join(' — ').slice(0, 1900);

  // Reuse the report's thread if it has one; otherwise start it FROM the message,
  // so the thread reads as a reply to the report rather than a loose post.
  // Anchors can die permanently (10008 Unknown Message — the 2026-07-29 server
  // move orphaned every pre-move report), so a dead anchor falls back to a
  // standalone channel post and gets cleared in the ledger instead of failing
  // the mirror forever.
  let threadId = null;
  let anchorDead = false;
  const existing = await fetch(`${api}/channels/${channelId}/messages/${report.messageId}`, { headers });
  if (existing.ok) {
    const message = await existing.json();
    threadId = message.thread?.id ?? null;
  } else if (existing.status === 404) {
    anchorDead = true;
  }

  if (!threadId && !anchorDead) {
    const created = await fetch(`${api}/channels/${channelId}/messages/${report.messageId}/threads`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: `${report.id} · ${report.title}`.slice(0, 100), auto_archive_duration: 10080 }),
    });
    if (created.ok) {
      threadId = (await created.json()).id;
    } else {
      const detail = await created.json().catch(() => null);
      if (detail?.code === 10008) {
        anchorDead = true;
      } else {
        const reason = detail ? ` (${detail.code ?? '?'} ${detail.message ?? ''})`.trimEnd() : '';
        return { ok: false, why: `thread create HTTP ${created.status}${reason}` };
      }
    }
  }

  if (anchorDead) {
    const posted = await fetch(`${api}/channels/${channelId}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: `**${report.id} · ${report.title}**`.slice(0, 200) + ` — ${content}`.slice(0, 1700) }),
    });
    if (!posted.ok) return { ok: false, why: `fallback post HTTP ${posted.status} (anchor purged)` };
    // Clear the dead anchor with the ledger's own append-only last-write-wins
    // convention (see sync-reports.mjs enrich pass) so future mirrors skip
    // straight to the fallback instead of re-probing a purged message.
    try {
      appendFileSync(ledgerPath(), `${JSON.stringify({ ...report, messageId: undefined })}\n`, 'utf8');
    } catch {
      // Ledger heal is cosmetic; the mirrored note is what matters.
    }
    return { ok: true, fallback: true };
  }

  const posted = await fetch(`${api}/channels/${threadId}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content }),
  });
  return posted.ok ? { ok: true, threadId } : { ok: false, why: `post HTTP ${posted.status}` };
}

function age(ts) {
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

/** Everything we know, joined: the report + its status + whether it shipped. */
function queue() {
  const reports = readLedger();
  const status = readStatus();
  const shipped = new Map(readPublished().map((entry) => [entry.id, entry]));

  const rows = [];
  for (const [id, report] of reports) {
    const state = status.get(id);
    const ship = shipped.get(id);
    rows.push({
      ...report,
      status: ship ? 'fixed' : (state?.status ?? 'open'),
      notes: state?.notes ?? [],
      fixedIn: ship?.version ?? null,
    });
  }
  return rows;
}

function printQueue() {
  const rows = queue();
  if (rows.length === 0) {
    console.log('No reports. Run `npm run sync:reports` to pull the intake channel.');
    return;
  }

  // Open first — those are the ones needing a decision. Then oldest first inside
  // each bucket: the report that has waited longest is the most overdue.
  const rank = { open: 0, 'needs-info': 1, triaged: 2, attempted: 3, 'cant-reproduce': 4, 'wont-fix': 5, fixed: 6 };
  rows.sort((a, b) => (rank[a.status] - rank[b.status]) || (a.ts - b.ts));

  const live = rows.filter((r) => r.status !== 'fixed' && r.status !== 'wont-fix').length;
  console.log(`${BOLD}${rows.length} report(s) · ${live} still open${RESET}\n`);

  for (const row of rows) {
    const color = COLOR[row.status] ?? '';
    const who = row.reporter ? `@${row.reporter}` : 'anonymous';
    // Only flag "internal" once a decision has been RECORDED — an untouched
    // report is trivially unseen, and saying so on every row is noise.
    const decided = row.status !== 'open';
    const pub = decided && !PUBLIC_STATUSES.has(row.status) ? `${DIM} · reporter not told${RESET}` : '';
    console.log(`${color}${row.status.padEnd(15)}${RESET}${BOLD}${row.id}${RESET}  ${row.title}`);
    console.log(`${DIM}                ${who} · v${row.version} · ${age(row.ts)}${row.fixedIn ? ` · fixed in v${row.fixedIn}` : ''}${RESET}${pub}`);
    const last = [...row.notes].reverse().find((n) => n.note);
    if (last) console.log(`${DIM}                ↳ ${last.note}${RESET}`);
    console.log();
  }

  const open = rows.filter((r) => r.status === 'open');
  if (open.length > 0) {
    console.log(`${DIM}To close one: fix it, then put this in the commit body:${RESET}`);
    console.log(`  ${BOLD}Fixes-Report: ${open[0].id}${RESET}`);
    console.log(`${DIM}Tried and failed? Say so, so they aren't left in silence:${RESET}`);
    console.log(`  npm run reports -- status ${open[0].id} needs-info --note "what would help"`);
  }
}

function printOne(id) {
  const row = queue().find((r) => r.id === id.toUpperCase());
  if (!row) {
    console.error(`No report ${id.toUpperCase()}. Run \`npm run sync:reports\` first.`);
    process.exit(1);
  }
  console.log(`${BOLD}${row.id}${RESET}  ${row.title}\n`);
  console.log(`  status    ${COLOR[row.status] ?? ''}${row.status}${RESET}${row.fixedIn ? ` (v${row.fixedIn})` : ''}`);
  console.log(`  reporter  ${row.reporter ? `@${row.reporter}` : 'anonymous'}`);
  console.log(`  version   ${row.version}`);
  console.log(`  filed     ${new Date(row.ts).toISOString()} (${age(row.ts)})`);
  if (row.notes.length > 0) {
    console.log(`\n  ${BOLD}history${RESET}`);
    for (const n of row.notes) {
      console.log(`  ${DIM}${new Date(n.ts).toISOString().slice(0, 10)}${RESET}  ${n.status ? `[${n.status}] ` : ''}${n.note}`);
    }
  }
}

async function annotate(id, { status, note }) {
  const upper = id.toUpperCase();
  const report = readLedger().get(upper);
  if (!report) {
    console.error(`No report ${upper}. Run \`npm run sync:reports\` first.`);
    process.exit(1);
  }
  if (status && !STATUSES.includes(status)) {
    console.error(`Unknown status "${status}". One of: ${STATUSES.join(', ')}`);
    process.exit(1);
  }
  if (status === 'fixed') {
    console.error('Never set "fixed" by hand — put `Fixes-Report: ' + upper + '` in the commit body instead.');
    console.error('That way the code and the announcement can never disagree.');
    process.exit(1);
  }

  // A public status puts this report's title in front of the world, so clean it
  // now — at the moment we decide to publish, not at ship time.
  let cleaned = null;
  if (status && PUBLIC_STATUSES.has(status)) {
    const { title, via } = await publicTitle(report.title);
    cleaned = title;
    if (via === 'redact') console.warn(`  ${DIM}(title polish unavailable — the redacted text will publish)${RESET}`);
  }

  recordStatus({
    id: upper,
    status: status ?? null,
    note: note ?? null,
    ...(cleaned ? { publicTitle: cleaned } : {}),
    ts: Date.now(),
  });
  console.log(`${upper} → ${status ?? 'note added'}`);
  if (note) console.log(`  ${DIM}${note}${RESET}`);

  const mirrored = await mirrorToDiscord(report, { status, note });
  console.log(mirrored.ok
    ? `  ${DIM}${mirrored.fallback ? 'mirrored as a standalone post (original report message was purged)' : "mirrored to the report's thread"}${RESET}`
    : `  ${DIM}not mirrored to Discord (${mirrored.why}) — recorded locally${RESET}`);

  if (status && PUBLIC_STATUSES.has(status)) {
    console.log(`\n  This reaches the reporter in-app on the next release.`);
    if (cleaned && cleaned !== report.title) console.log(`  ${DIM}published as: ${cleaned}${RESET}`);
    if (status === 'needs-info' && !note) {
      console.warn(`  ⚠ needs-info with no note says "we need something" without saying WHAT. Add --note.`);
    }
  } else if (status) {
    console.log(`\n  ${DIM}Internal only — the reporter will not see this.${RESET}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  // A leading flag (`--no-sync`) is not a command.
  const command = argv[0]?.startsWith('--') ? 'list' : argv[0];
  const rest = argv[0]?.startsWith('--') ? argv : argv.slice(1);

  const noteFlag = rest.indexOf('--note');
  const note = noteFlag >= 0 ? rest[noteFlag + 1] : null;
  const positional = (noteFlag >= 0 ? rest.slice(0, noteFlag) : rest).filter((a) => !a.startsWith('--'));

  switch (command) {
    case undefined:
    case 'list': {
      if (!rest.includes('--no-sync')) {
        try {
          const { status, fresh } = await syncReports();
          if (status === 'disabled') {
            console.warn(`${DIM}(intake reconciliation intentionally disabled; showing the local ledger)${RESET}\n`);
          }
          if (fresh.length > 0) console.log(`${DIM}pulled ${fresh.length} new report(s) from the intake channel${RESET}\n`);
        } catch (error) {
          const reason = error?.code === 'O8_INTAKE_CONFIGURATION'
            ? error.message
            : 'external intake is unreachable';
          console.warn(`${DIM}(${reason}; showing the local ledger)${RESET}\n`);
        }
      }
      printQueue();
      break;
    }
    case 'show':
      printOne(positional[0]);
      break;
    case 'note':
      await annotate(positional[0], { note: note ?? positional.slice(1).join(' ') });
      break;
    case 'status':
      await annotate(positional[0], { status: positional[1], note });
      break;
    default:
      console.error(`Unknown command "${command}". Try: list | show <id> | note <id> "…" | status <id> <${STATUSES.join('|')}> [--note "…"]`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('✗ reports failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
