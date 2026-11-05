#!/usr/bin/env node
// Read-only roadmap status. Reads every open issue labeled `tracking`, counts the
// checkboxes in its `## Checklist` section, and prints a table. Never writes ROADMAP.md.
// Requires the GitHub CLI (`gh`) to be installed and authenticated.
import { execFileSync } from 'node:child_process';

const REPO = process.env.ROADMAP_REPO || 'o8-run/o8';
const CHECK = process.argv.includes('--check');
import { readFileSync } from 'node:fs';

function gh(path) {
  const out = execFileSync('gh', ['api', '--paginate', '-H', 'Accept: application/vnd.github+json', path], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  // --paginate concatenates JSON arrays; splice them back into one array.
  return JSON.parse(`[${out.trim().replace(/^\[/, '').replace(/\]$/, '').replace(/\]\s*\[/g, ',')}]`);
}

// The last `## Checklist` section with boxes wins, so a converted epic's comment
// beats its body. The count and the --check items both read this one section.
export function lastChecklist(texts) {
  let lines = [];
  for (const text of texts) {
    if (!text || !/^##\s+Checklist\s*$/m.test(text)) continue;
    const section = text.split(/^##\s+Checklist\s*$/m).pop().split(/^##\s+/m)[0];
    const boxes = section.split('\n').filter((line) => /^\s*-\s*\[([ xX])\]/.test(line));
    if (boxes.length > 0) lines = boxes;
  }
  return lines;
}
export function countChecklist(texts) {
  const lines = lastChecklist(texts);
  const checked = lines.filter((line) => !/^\s*-\s*\[ \]/.test(line)).length;
  return { checked, total: lines.length };
}

// --check: a checked child must be closed, and every issue linked from the Now
// section of ROADMAP.md must be open. An unchecked child that is already closed
// is reported as awaiting release, not as drift: the box is checked only once
// the fix is in a shipped release.
function issueState(num) {
  const out = execFileSync('gh', ['api', `repos/${REPO}/issues/${num}`], { encoding: 'utf8' });
  return JSON.parse(out).state;
}
export function checklistItems(texts) {
  const items = [];
  for (const line of lastChecklist(texts)) {
    const m = /^\s*-\s*\[([ xX])\]\s*#(\d+)/.exec(line);
    if (m) items.push({ checked: m[1] !== ' ', num: Number(m[2]) });
  }
  return items;
}
function nowLinks() {
  let md = '';
  try { md = readFileSync(new URL('../ROADMAP.md', import.meta.url), 'utf8'); } catch { return []; }
  const now = md.split(/^## Now\s*$/m)[1]?.split(/^## /m)[0] || '';
  return [...now.matchAll(/issues\/(\d+)/g)].map((m) => Number(m[1]));
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n - 1) + ' ' : s + ' '.repeat(n - s.length);
}

function main() {
  const issues = gh(`repos/${REPO}/issues?state=open&labels=tracking&per_page=100`).filter((i) => !i.pull_request);
  if (issues.length === 0) {
    console.log('No open issues labeled `tracking`.');
    process.exit(0);
  }

  const rows = [];
  const problems = [];
  const awaiting = [];
  for (const issue of issues) {
    const texts = [issue.body || ''];
    if (issue.comments > 0) {
      for (const c of gh(`repos/${REPO}/issues/${issue.number}/comments?per_page=100`)) texts.push(c.body || '');
    }
    const { checked, total } = countChecklist(texts);
    if (CHECK) {
      for (const item of checklistItems(texts)) {
        const state = issueState(item.num);
        if (item.checked && state !== 'closed') problems.push(`#${issue.number}: checked #${item.num} is ${state}`);
        if (!item.checked && state !== 'open') awaiting.push(`#${issue.number}: #${item.num} is closed, box stays open until it ships`);
      }
    }
    const pct = total > 0 ? Math.round((checked / total) * 20) * 5 : null;
    rows.push({ number: issue.number, title: issue.title, checked, total, pct });
  }
  rows.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || a.number - b.number);

  console.log(`${pad('ISSUE', 7)}${pad('TITLE', 52)}${pad('SHIPPED', 10)}PERCENT`);
  console.log('-'.repeat(76));
  for (const r of rows) {
    const shipped = r.total > 0 ? `${r.checked}/${r.total}` : 'none';
    const pct = r.pct === null ? 'no checklist' : `${r.pct}%`;
    console.log(`${pad('#' + r.number, 7)}${pad(r.title, 52)}${pad(shipped, 10)}${pct}`);
  }
  const done = rows.reduce((a, r) => a + r.checked, 0);
  const all = rows.reduce((a, r) => a + r.total, 0);
  console.log('-'.repeat(76));
  console.log(`${rows.length} tracking issues, ${done} of ${all} children shipped.`);

  if (CHECK) {
    if (awaiting.length) {
      console.log('\nawaiting release:');
      for (const a of awaiting) console.log(`  ${a}`);
    }
    for (const num of nowLinks()) {
      const state = issueState(num);
      if (state !== 'open') problems.push(`ROADMAP.md Now links #${num}, which is ${state}`);
    }
    if (problems.length) {
      console.error('\nroadmap drift:');
      for (const p of problems) console.error(`  ${p}`);
      process.exit(1);
    }
    console.log('roadmap check: no drift.');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
