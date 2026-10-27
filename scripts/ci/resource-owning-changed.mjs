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
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Intersects changed paths with the manifest's resourceOwning list. */
export function selectResourceOwning(changedPaths, classification) {
  const owning = new Set((classification.resourceOwning ?? []).map((entry) => entry.path));
  return [...new Set(changedPaths)].filter((path) => owning.has(path)).sort();
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
  const untracked = workingTree ? runGit(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean) : [];
  const files = selectResourceOwning([...parseNameStatus(diff), ...untracked], classification);
  for (const file of files) console.log(file);
  console.error(`[resource-owning-changed] ${files.length} resource-owning test file(s) touched since ${mergeBase.slice(0, 12)}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `count=${files.length}\nfiles=${files.join(' ')}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
