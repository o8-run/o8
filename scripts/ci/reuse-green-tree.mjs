#!/usr/bin/env node
// Decide whether a merge-queue run may reuse the pull request's passing CI.
// The squashed group commit is reusable only when it holds exactly one pull
// request and its tree is byte-identical to the tree the pull request's
// required checks passed on. Every doubt answers reuse=false, so the full
// workflow runs.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Check names produced by the jobs that skip their work on reuse, plus the
// aggregate. tests/ci-reuse-green-tree.test.ts keeps this list equal to ci.yml.
export const REQUIRED_CHECKS = [
  'Type Check',
  'Lint',
  'Hermetic Unit Tests',
  ...[1, 2, 3, 4].map(shard => `Hermetic Unit Tests (shard ${shard}/4)`),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(shard => `o8 next Native Tests (Linux) (${shard})`),
  'Integration Tests (changed files)',
  'Security Audit',
  'Governance Smoke',
  'Server Bundle Size',
  'Rust Compile Gate (Windows)',
  'Rust Compile Gate (Linux)',
];
const CI_WORKFLOW = '.github/workflows/ci.yml';
const SHA = /^[0-9a-f]{40}$/;

class Refusal extends Error {}
function refuse(reason) {
  throw new Refusal(reason);
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
  if (result.error || result.status !== 0) refuse(`git ${args[0]} failed`);
  return result.stdout.trim();
}

async function getJson(api, token, route) {
  const response = await fetch(`${api}/${route}`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) refuse(`GitHub API ${route.split('?')[0]} answered ${response.status}`);
  return response.json();
}

export async function decideReuse({ eventName, event, repository, token, api = 'https://api.github.com', cwd = process.cwd() }) {
  if (eventName !== 'merge_group') refuse(`${eventName || 'unknown'} event`);
  const group = event?.merge_group;
  const base = group?.base_sha;
  const head = group?.head_sha;
  if (!SHA.test(base ?? '') || !SHA.test(head ?? '')) refuse('merge group shas missing');
  const ref = /^(?:refs\/heads\/)?gh-readonly-queue\/main\/pr-(\d+)-([0-9a-f]{40})$/.exec(group.head_ref ?? '');
  if (!ref) refuse('merge group ref names no pull request');
  const pr = ref[1];
  // A later queue entry is built on the entry ahead of it, not on main.
  if (ref[2] !== base) refuse(`pr-${pr} is not the first entry on its base`);
  // SQUASH writes one commit per pull request.
  if (git(cwd, ['rev-list', '--count', `${base}..${head}`]) !== '1') refuse(`group for pr-${pr} holds more than one pull request`);
  const groupTree = git(cwd, ['rev-parse', `${head}^{tree}`]);
  git(cwd, ['fetch', '--quiet', '--no-tags', 'origin', `pull/${pr}/head`]);
  if (git(cwd, ['rev-parse', 'FETCH_HEAD^{tree}']) !== groupTree) refuse(`pr-${pr} head tree differs from the group tree`);
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) refuse('repository or token missing');

  const tip = git(cwd, ['rev-parse', 'FETCH_HEAD^{commit}']);
  const listing = await getJson(api, token, `repos/${repository}/commits/${tip}/check-runs?per_page=100`);
  const runs = listing?.check_runs;
  if (!Array.isArray(runs) || listing.total_count !== runs.length) refuse('check-run listing is incomplete');
  const shas = new Set();
  const suites = new Set();
  for (const name of REQUIRED_CHECKS) {
    const matches = runs.filter(run => run?.name === name);
    if (matches.length === 0) refuse(`"${name}" has no check run`);
    for (const run of matches) {
      if (run.status !== 'completed' || run.conclusion !== 'success') refuse(`"${name}" is ${run.conclusion ?? run.status}`);
      if (run.app?.slug !== 'github-actions') refuse(`"${name}" was not reported by Actions`);
      shas.add(run.head_sha);
      suites.add(run.check_suite?.id);
    }
  }
  if (shas.size !== 1) refuse('required checks disagree on their commit');
  if (suites.size !== 1) refuse('required checks come from more than one workflow run');
  const [tested] = shas;
  const [suite] = suites;
  if (!SHA.test(tested ?? '')) refuse('check runs name no commit');
  const workflow = await getJson(api, token, `repos/${repository}/actions/runs?check_suite_id=${encodeURIComponent(suite)}`);
  const owner = workflow?.workflow_runs;
  if (!Array.isArray(owner) || owner.length !== 1 || owner[0].path !== CI_WORKFLOW
    || owner[0].event !== 'pull_request' || owner[0].head_sha !== tested) refuse('checks are not from the CI pull request run');

  // The pull request run tested GitHub's merge of the head with the main of
  // that moment. With the queue base inside the head's history that merge is
  // the head tree itself, so nothing on main went untested.
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', base, tested], { cwd, timeout: 60_000 });
  if (ancestry.status !== 0) refuse(`main moved since pr-${pr} was tested`);
  if (git(cwd, ['rev-parse', `${tested}^{tree}`]) !== groupTree) refuse(`tested tree of pr-${pr} differs from the group tree`);
  return `pr-${pr} tested ${tested.slice(0, 12)} with tree ${groupTree.slice(0, 12)}, equal to the group`;
}

async function main() {
  let reuse = false;
  let reason;
  try {
    const eventName = process.env.GITHUB_EVENT_NAME;
    const event = eventName === 'merge_group' ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
    reason = await decideReuse({
      eventName, event, repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN,
      api: process.env.GITHUB_API_URL || undefined,
    });
    reuse = true;
  } catch (error) {
    reason = error instanceof Refusal ? error.message : `unexpected error: ${error?.message ?? error}`;
  }
  console.log(`[reuse-green-tree] reuse=${reuse}: ${reason}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `reuse=${reuse}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
