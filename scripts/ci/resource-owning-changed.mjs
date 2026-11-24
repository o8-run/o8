#!/usr/bin/env node
// Lists the resource-owning test files a branch touches, for the PR lane of
// the integration suite (#2391). The diff is taken from the merge-base with
// the base ref, so the result covers every commit on the branch, not only
// the last one.
//
//   node scripts/ci/resource-owning-changed.mjs <base-ref> [head-ref]
//
// Prints one path per line. When GITHUB_OUTPUT is set, also writes
// `count=<n>` and `files=<space-separated paths>` for later workflow steps.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectedTestsRequireBrowser } from '../lib/test-classification.mjs';

/**
 * Parses `diff --name-status -z -M` output into the paths that exist on the
 * head side. Deleted files are dropped; renames and copies keep the new path.
 */
export function parseNameStatus(output) {
  const fields = output.split('\0').filter((field) => field.length > 0);
  const paths = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index];
    const code = status.charAt(0);
    if (code === 'R' || code === 'C') {
      paths.push(fields[index + 2]);
      index += 3;
      continue;
    }
    if (code !== 'D') paths.push(fields[index + 1]);
    index += 2;
  }
  return paths.filter((path) => typeof path === 'string' && path.length > 0);
}

/**
 * The workflow mirror tests pin the shape of ci.yml and its composite actions.
 * A workflow change must run them even when the tests themselves are untouched;
 * otherwise their assertions rot on main until the next PR that edits the test.
 */
export const WORKFLOW_MIRROR_TESTS = ['tests/ci-gates-real-path.test.ts', 'tests/verify-ci-real-path.test.ts'];
const WORKFLOW_INPUT = /^\.github\/(?:workflows\/ci\.yml|actions\/)/;

/**
 * Suites that enumerate every registered surface, route, MCP tool or CLI command.
 * A change almost anywhere can break them, so they run on every merge group and
 * every local verify:ci, not only when their own files change (#6761).
 */
export const ENUMERATING_SUITES = [
  'tests/api-front-door-real-path.test.ts',
  'tests/cli-agent-help-real-path.test.ts',
  'tests/mcp-schema-compatibility-real-path.test.ts',
  'tests/next-surface-boundary-real-path.test.ts',
  'tests/o8d-mcp-parity-real-path.test.ts',
  'tests/o8d-native-route-inventory-real-path.test.ts',
  'tests/o8d-native-route-table-real-path.test.ts',
  'tests/o8d-next-surfaces-real-path.test.ts',
  'tests/o8d-repos-bootstrap-native-real-path.test.ts',
];

/** Enumerating suites the manifest no longer classifies as resource-owning. */
export function unclassifiedEnumeratingSuites(classification, exists = () => true) {
  const owning = new Set((classification.resourceOwning ?? []).map((entry) => entry.path));
  return ENUMERATING_SUITES.filter((path) => exists(path) && !owning.has(path));
}

/** Intersects changed paths with the manifest's resourceOwning list. */
export function selectResourceOwning(changedPaths, classification) {
  const owning = new Set((classification.resourceOwning ?? []).map((entry) => entry.path));
  const changed = new Set([...changedPaths, ...ENUMERATING_SUITES]);
  if ([...changed].some((path) => WORKFLOW_INPUT.test(path))) {
    for (const test of WORKFLOW_MIRROR_TESTS) changed.add(test);
  }
  return [...changed].filter((path) => owning.has(path)).sort();
}

function runGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  }
  return result.stdout;
}

function main() {
  const [base, head = 'HEAD'] = process.argv.slice(2);
  if (!base) {
    console.error('usage: node scripts/ci/resource-owning-changed.mjs <base-ref> [head-ref]');
    process.exit(2);
  }
  const workingTree = head === '--worktree';
  const mergeBase = runGit(['merge-base', base, workingTree ? 'HEAD' : head]).trim();
  const diff = runGit(['diff', '--name-status', '-z', '-M', mergeBase, ...(workingTree ? [] : [head])]);
  const classification = JSON.parse(readFileSync(join(process.cwd(), 'tests/test-classification.json'), 'utf8'));
  const missing = unclassifiedEnumeratingSuites(classification, (path) => existsSync(join(process.cwd(), path)));
  if (missing.length > 0) {
    // A renamed or reclassified suite would otherwise drop out of every merge group silently.
    console.error(`[resource-owning-changed] enumerating suites are not resource-owning: ${missing.join(', ')}`);
    process.exit(1);
  }
  const untracked = workingTree ? runGit(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean) : [];
  const files = selectResourceOwning([...parseNameStatus(diff), ...untracked], classification);
  for (const file of files) console.log(file);
  console.error(`[resource-owning-changed] ${files.length} resource-owning test file(s) touched since ${mergeBase.slice(0, 12)}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      `count=${files.length}\nfiles=${files.join(' ')}\nbrowser=${selectedTestsRequireBrowser(files, classification)}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
