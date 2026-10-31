#!/usr/bin/env node
// Agent PRs can make a red suite green by deleting tests or their assertions.
// This check fails a pull request that deletes a test file or removes more
// assertions from test files than it adds, so a human has to look. A human
// applies the override label after reviewing the removal; nothing else clears it.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const OVERRIDE_LABEL = 'tests-removed-ok';
const TEST_FILE = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)[^/]+_tests?\.rs$|(?:^|\/)tests\/(?:[^/]+\/)*[^/]+\.rs$/;
// `.expect(` is Rust's Result/Option unwrap, not an assertion.
const ASSERTION = /(?<![.\w])expect(?:TypeOf)?\s*\(|\bassert(?:\.\w+)*\s*\(|\bassert(?:_eq|_ne|_matches)?!\s*\(/g;
// expect(<literal>) and assert!(true) check nothing about the code under test.
const TRIVIAL = /(?<![.\w])expect\s*\(\s*(?:true|false|null|undefined|-?\d[\d_.]*|'[^'\n]*'|"[^"\n]*")\s*\)|\bassert!\s*\(\s*true\s*[,)]|\bassert\s*\(\s*true\s*[,)]/g;
const TEST_CASE = /(?:^|[^.\w])(?:it|test)(?:\.each\s*(?:\([^)]*\)|`[^`]*`))?\s*\(|#\[(?:\w+::)*test\b/g;
// Ways to keep a test in the file while stopping it from running or checking.
const DISABLED = /\b(?:it|test|describe|suite)\.(?:skip|todo|fails)\b|(?:^|[^.\w])(?:xit|xtest|xdescribe)\s*\(\s*['"`]|#\[ignore\b|\bif\s*\(\s*(?:false|0)\s*\)|=>\s*\{\s*return\s*;/g;
const FOCUSED = /\b(?:it|test|describe|suite)\.only\b|(?:^|[^.\w])(?:fit|fdescribe)\s*\(\s*['"`]/g;
const STRONG = /\.(?:toBe|toEqual|toStrictEqual|toMatchObject|toThrow(?:Error)?|toHaveBeenCalledWith|toHaveBeenNthCalledWith|toHaveBeenLastCalledWith|toContain(?:Equal)?|toMatch|toHaveLength)\s*\(/g;
const WEAK = /\.(?:toBeDefined|toBeTruthy|toBeFalsy|toBeUndefined|toBeNull|toHaveBeenCalled|toBeCalled)\s*\(\s*\)/g;
// Changes here decide whether this check, or which tests, run at all.
const PROTECTED = /^(?:scripts\/ci\/flag-test-deletions\.(?:[cm]?[jt]s|d\.mts)|\.github\/workflows\/test-deletion-review\.ya?ml|(?:[^/]+\/)*vitest(?:\.[\w-]+)*\.config\.[cm]?[jt]s|(?:[^/]+\/)*vitest\.(?:shared|workspace)\.[cm]?[jt]s|playwright\.config\.[cm]?[jt]s)$/;
// Support files that tests load; deleting one can silently drop coverage.
const TEST_SUPPORT = /(?:^|\/)(?:__fixtures__|__mocks__|test-?utils|test-?helpers|testing)\/|(?:^|\/)tests\/(?:[^/]+\/)*fixtures\/|(?:^|\/)(?:vitest|test)[.-]setup\.[cm]?[jt]sx?$|(?:^|\/)tests\/(?:helpers|support|setup)\//;

const vendored = (file) => file.split('/').some(part => part === 'node_modules' || part === 'vendor');

export function isTestFile(file) {
  return TEST_FILE.test(file) && !vendored(file);
}

export function isProtectedPath(file) {
  return PROTECTED.test(file) && !file.split('/').includes('node_modules');
}

export function isTestSupport(file) {
  return TEST_SUPPORT.test(file) && !file.split('/').includes('node_modules');
}

// Comments do not assert anything, so commenting a check out must count as removal.
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

const count = (source, pattern) => (stripComments(source ?? '').match(pattern) ?? []).length;

/** Assertions that can fail; expect(true).toBe(true) and assert!(true) do not count. */
export function countAssertions(source) {
  return Math.max(0, count(source, ASSERTION) - count(source, TRIVIAL));
}

/** Per-file signals compared between base and head. */
export function measure(source) {
  return {
    assertions: countAssertions(source),
    cases: count(source, TEST_CASE),
    disabled: count(source, DISABLED),
    focused: count(source, FOCUSED),
    strong: count(source, STRONG),
    weak: count(source, WEAK),
  };
}

const RUST_TESTS = /#\[(?:\w+::)*test\b|#\[cfg\(test\)\]/;

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
 * Rust sources with inline #[test] modules count as test files on either side.
 */
export function findTestRemovals(records, readBase, readHead) {
  const deleted = [];
  const files = [];
  const disabled = [];
  const focused = [];
  const weakenedMatchers = [];
  const protectedPaths = [];
  const deletedSupport = [];
  let before = 0;
  let after = 0;
  let casesBefore = 0;
  let casesAfter = 0;
  for (const { status, from, to } of records) {
    if (isProtectedPath(from) || isProtectedPath(to)) protectedPaths.push(status === 'R' ? `${from} -> ${to}` : to);
    if (status === 'D' && isTestSupport(from) && !isTestFile(from)) { deletedSupport.push(from); continue; }
    if (status === 'R' && isTestSupport(from) && !isTestSupport(to) && !isTestFile(from)) { deletedSupport.push(from); continue; }
    let fromTest = isTestFile(from);
    let toTest = isTestFile(to);
    let baseSource;
    let headSource;
    if (!fromTest && !toTest) {
      if ((!from.endsWith('.rs') && !to.endsWith('.rs')) || vendored(to)) continue;
      baseSource = status === 'A' || status === 'C' ? null : readBase(from);
      headSource = status === 'D' ? null : readHead(to);
      const rustTests = RUST_TESTS.test(baseSource ?? '') || RUST_TESTS.test(headSource ?? '');
      if (!rustTests) continue;
      fromTest = toTest = true;
    }
    if (status === 'D') {
      if (fromTest) deleted.push({ file: from, assertions: countAssertions(baseSource ?? readBase(from)) });
      continue;
    }
    // A test renamed to a non-test path stops running, which is a deletion.
    if (status === 'R' && fromTest && !toTest) {
      deleted.push({ file: from, assertions: countAssertions(baseSource ?? readBase(from)) });
      continue;
    }
    const baseText = status === 'A' || status === 'C' || !fromTest ? null : (baseSource ?? readBase(from));
    const headText = headSource ?? readHead(to);
    const base = measure(baseText);
    const head = measure(headText);
    before += base.assertions;
    after += head.assertions;
    casesBefore += base.cases;
    casesAfter += head.cases;
    if (head.assertions < base.assertions) files.push({ file: to, before: base.assertions, after: head.assertions });
    // A new test added already ignored/skipped is not a disabled existing test.
    const newlyDisabled = (head.disabled - base.disabled) - Math.max(0, head.cases - base.cases);
    if (newlyDisabled > 0) disabled.push({ file: to, added: newlyDisabled });
    if (head.focused > base.focused) focused.push({ file: to, added: head.focused - base.focused });
    // Exact matchers swapped for presence-only ones, not new presence checks added alongside.
    if (head.weak > base.weak && head.strong < base.strong && head.strong + head.weak <= base.strong + base.weak) weakenedMatchers.push({ file: to, strong: [base.strong, head.strong], weak: [base.weak, head.weak] });
  }
  return {
    deleted, weakened: files, before, after, netAssertions: after - before,
    netCases: casesAfter - casesBefore, disabled, focused, weakenedMatchers, protectedPaths, deletedSupport,
  };
}

/**
 * `event` is { action, senderType } from the pull_request_target payload. The
 * override only counts when a person applied or kept it on the current head:
 * a push after the label (synchronize) or a bot actor must be re-reviewed.
 */
export function verdict(result, labels, event = {}) {
  const flagged = result.deleted.length > 0 || result.netAssertions < 0 || (result.netCases ?? 0) < 0
    || (result.disabled?.length ?? 0) > 0 || (result.focused?.length ?? 0) > 0
    || (result.weakenedMatchers?.length ?? 0) > 0 || (result.protectedPaths?.length ?? 0) > 0
    || (result.deletedSupport?.length ?? 0) > 0;
  const trustedEvent = event.action !== 'synchronize' && event.senderType !== 'Bot';
  const overridden = flagged && labels.includes(OVERRIDE_LABEL) && trustedEvent;
  return { flagged, overridden, failed: flagged && !overridden, staleOverride: flagged && labels.includes(OVERRIDE_LABEL) && !trustedEvent };
}

export function summarize(result, outcome) {
  const lines = [];
  for (const item of result.deleted) lines.push(`deleted test file: ${item.file} (${item.assertions} assertions)`);
  if (result.netAssertions < 0) {
    lines.push(`net assertions in changed test files: ${result.before} -> ${result.after} (${result.netAssertions})`);
    for (const item of result.weakened) lines.push(`  fewer assertions: ${item.file} (${item.before} -> ${item.after})`);
  }
  if ((result.netCases ?? 0) < 0) lines.push(`net test cases in changed test files: ${result.netCases}`);
  for (const item of result.disabled ?? []) lines.push(`skipped/todo/ignored/disabled tests added: ${item.file} (+${item.added})`);
  for (const item of result.focused ?? []) lines.push(`.only/fit added (other tests stop running): ${item.file} (+${item.added})`);
  for (const item of result.weakenedMatchers ?? []) lines.push(`weaker matchers: ${item.file} (exact ${item.strong[0]} -> ${item.strong[1]}, presence-only ${item.weak[0]} -> ${item.weak[1]})`);
  for (const file of result.protectedPaths ?? []) lines.push(`changes test policy or runner config: ${file}`);
  for (const file of result.deletedSupport ?? []) lines.push(`deleted test support file: ${file}`);
  if (!outcome.flagged) lines.push(`no test deletions; net assertions ${result.netAssertions >= 0 ? '+' : ''}${result.netAssertions}`);
  else if (outcome.staleOverride) lines.push(`'${OVERRIDE_LABEL}' was applied before this push or by a bot; a person must remove and re-apply it after reviewing the current head`);
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

function eventContext() {
  if (!process.env.GITHUB_EVENT_PATH) return {};
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  return { action: event.action, senderType: event.sender?.type };
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
    const outcome = verdict(result, eventLabels(), eventContext());
    const lines = summarize(result, outcome);
    for (const line of lines) console[outcome.failed ? 'error' : 'log'](`[test-deletions] ${line}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Test deletion review\n\n${lines.map(l => `- ${l.trim()}`).join('\n')}\n`);
    if (outcome.failed) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
