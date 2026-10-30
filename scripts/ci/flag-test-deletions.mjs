#!/usr/bin/env node
// Agent PRs can make a red suite green by deleting tests or their assertions.
// This check fails a pull request that deletes a test file or removes more
// assertions from test files than it adds, so a human has to look. A human
// applies the override label after reviewing the removal; nothing else clears it.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const OVERRIDE_LABEL = 'tests-removed-ok';
const TEST_FILE = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)[^/]+_tests?\.rs$/;
const ASSERTION = /\bexpect(?:TypeOf)?\s*\(|\bassert(?:\.\w+)*\s*\(|\bassert(?:_eq|_ne|_matches)?!\s*\(/g;

export function isTestFile(file) {
  return TEST_FILE.test(file) && !file.split('/').includes('node_modules');
}

// Comments do not assert anything, so commenting a check out must count as removal.
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

export function countAssertions(source) {
  return (stripComments(source ?? '').match(ASSERTION) ?? []).length;
}

/** Parses `git diff --name-status -z -M` output into { status, from, to } records. */
export function parseNameStatus(output) {
  const fields = output.split('\0').filter(Boolean);
  const records = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (/^[RC]/.test(status)) records.push({ status: status[0], from: fields[index++], to: fields[index++] });
    else { const file = fields[index++]; records.push({ status: status[0], from: file, to: file }); }
  }
  return records;
}

/**
 * readBase/readHead return a file's content at that side, or null when absent.
 * Renames compare the old path at base with the new path at head, so moving a
 * test is not a deletion; assertions moved between test files net out.
 */
export function findTestRemovals(records, readBase, readHead) {
  const deleted = [];
  const files = [];
  let before = 0;
  let after = 0;
  for (const { status, from, to } of records) {
    if (!isTestFile(from) && !isTestFile(to)) continue;
    if (status === 'D') {
      if (isTestFile(from)) deleted.push({ file: from, assertions: countAssertions(readBase(from)) });
      continue;
    }
    // A test renamed to a non-test path stops running, which is a deletion.
    if (status === 'R' && isTestFile(from) && !isTestFile(to)) {
      deleted.push({ file: from, assertions: countAssertions(readBase(from)) });
      continue;
    }
    const base = status === 'A' || status === 'C' || !isTestFile(from) ? 0 : countAssertions(readBase(from));
    const head = countAssertions(readHead(to));
    before += base;
    after += head;
    if (head < base) files.push({ file: to, before: base, after: head });
  }
  return { deleted, weakened: files, before, after, netAssertions: after - before };
}

export function verdict(result, labels) {
  const flagged = result.deleted.length > 0 || result.netAssertions < 0;
  const overridden = flagged && labels.includes(OVERRIDE_LABEL);
  return { flagged, overridden, failed: flagged && !overridden };
}

export function summarize(result, outcome) {
  const lines = [];
  for (const item of result.deleted) lines.push(`deleted test file: ${item.file} (${item.assertions} assertions)`);
  if (result.netAssertions < 0) {
    lines.push(`net assertions in changed test files: ${result.before} -> ${result.after} (${result.netAssertions})`);
    for (const item of result.weakened) lines.push(`  fewer assertions: ${item.file} (${item.before} -> ${item.after})`);
  }
  if (!outcome.flagged) lines.push(`no test deletions; net assertions ${result.netAssertions >= 0 ? '+' : ''}${result.netAssertions}`);
  else if (outcome.overridden) lines.push(`override: a maintainer applied '${OVERRIDE_LABEL}'`);
  else lines.push(`a human must review the removed coverage and apply the '${OVERRIDE_LABEL}' label to accept it`);
  return lines;
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed; fetch origin/main and the branch history`);
  return result.stdout;
}

function readAt(ref) {
  return (file) => {
    const result = spawnSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : null;
  };
}

function eventLabels() {
  if (process.env.TEST_DELETION_LABELS !== undefined) return process.env.TEST_DELETION_LABELS.split(',').map(s => s.trim()).filter(Boolean);
  if (!process.env.GITHUB_EVENT_PATH) return [];
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  return (event.pull_request?.labels ?? []).map(label => label.name);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const [base = 'origin/main', head = 'HEAD', ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error('usage: flag-test-deletions.mjs [base-ref] [head-ref]');
    const mergeBase = git(['merge-base', base, head]).trim();
    const records = parseNameStatus(git(['diff', '--name-status', '-z', '-M', mergeBase, head]));
    const result = findTestRemovals(records, readAt(mergeBase), readAt(head));
    const outcome = verdict(result, eventLabels());
    const lines = summarize(result, outcome);
    for (const line of lines) console[outcome.failed ? 'error' : 'log'](`[test-deletions] ${line}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Test deletion review\n\n${lines.map(l => `- ${l.trim()}`).join('\n')}\n`);
    if (outcome.failed) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
