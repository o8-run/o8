import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Runs the merge-queue reuse decision through its CLI entry point against a
// real fixture origin and a local GitHub API stub.
const repo = process.cwd();
const script = path.join(repo, 'scripts/ci/reuse-green-tree.mjs');
const workflow = parse(readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8'));
const gate = "needs.reuse.outputs.reuse != 'true'";
const root = mkdtempSync(path.join(tmpdir(), 'o8-ci-reuse-'));
const origin = path.join(root, 'origin.git');
const work = path.join(root, 'work');
const runner = path.join(root, 'runner');
const repository = 'o8-run/o8';
const token = 'fixture-token';
const suite = 4242;

type CheckRun = { name: string; status: string; conclusion: string | null; head_sha: string;
  app: { slug: string }; check_suite: { id: number } };
type Listing = { total_count: number; check_runs: CheckRun[] } | 'error';
const listings = new Map<string, Listing>();
let workflowRun: Record<string, unknown> = {};
const requests: string[] = [];
let server: Server;
let api = '';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  expect(result.status, `git ${args.join(' ')}: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

function commitFile(file: string, contents: string, message: string): string {
  writeFileSync(path.join(work, file), contents);
  git(work, 'add', '--', file);
  git(work, 'commit', '-qm', message);
  return git(work, 'rev-parse', 'HEAD');
}

// The squash the queue writes: one commit on the base holding the given tree.
function squash(tree: string, base: string, pr: number): string {
  return git(work, 'commit-tree', tree, '-p', base, '-m', `squash pr-${pr}`);
}

function checkNames(): string[] {
  const names: string[] = [];
  for (const [id, job] of Object.entries<{ name: string; needs?: string | string[]; strategy?: { matrix: { shard: number[] } } }>(workflow.jobs)) {
    if (id !== 'test' && ![job.needs ?? []].flat().includes('reuse')) continue;
    const shards = job.strategy?.matrix.shard;
    if (!shards) names.push(job.name);
    else for (const shard of shards) {
      names.push(job.name.includes('${{ matrix.shard }}')
        ? job.name.replaceAll('${{ matrix.shard }}', String(shard)) : `${job.name} (${shard})`);
    }
  }
  return names;
}

function green(sha: string): { total_count: number; check_runs: CheckRun[] } {
  const runs = [...checkNames(), 'PR Review'].map(name => ({
    name, status: 'completed', conclusion: 'success', head_sha: sha,
    app: { slug: 'github-actions' }, check_suite: { id: suite },
  }));
  return { total_count: runs.length, check_runs: runs };
}

function arm(tip: string, listing: Listing = green(tip), tested = tip): void {
  listings.clear();
  listings.set(tip, listing);
  workflowRun = { path: '.github/workflows/ci.yml', event: 'pull_request', head_sha: tested };
}

async function decide(event: object, { eventName = 'merge_group', env = {} }: { eventName?: string; env?: Record<string, string> } = {}) {
  const eventPath = path.join(root, 'event.json');
  const outputPath = path.join(root, 'output.txt');
  writeFileSync(eventPath, JSON.stringify(event));
  writeFileSync(outputPath, '');
  requests.length = 0;
  const child = spawn(process.execPath, [script], {
    cwd: runner,
    env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token, GITHUB_API_URL: api, ...env },
  });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  const status = await new Promise<number | null>(resolve => child.on('close', resolve));
  expect(status, stdout).toBe(0);
  const lines = stdout.trim().split('\n');
  expect(lines, 'the decision is logged in one line').toHaveLength(1);
  return { output: readFileSync(outputPath, 'utf8'), log: lines[0] };
}

function group(pr: number, head: string, base: string, refBase = base) {
  return { merge_group: { head_sha: head, base_sha: base, base_ref: 'refs/heads/main',
    head_ref: `refs/heads/gh-readonly-queue/main/pr-${pr}-${refBase}` } };
}

let main0 = '';
let prHead = '';
let unmoved = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    requests.push(url.pathname + url.search);
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.headers.authorization !== `Bearer ${token}`) return reply(401, { message: 'Bad credentials' });
    const checks = new RegExp(`^/repos/${repository}/commits/([0-9a-f]{40})/check-runs$`).exec(url.pathname);
    if (checks && url.searchParams.get('per_page') === '100') {
      const listing = listings.get(checks[1]);
      if (!listing || listing === 'error') return reply(500, { message: 'fixture failure' });
      return reply(200, listing);
    }
    if (url.pathname === `/repos/${repository}/actions/runs` && url.searchParams.get('check_suite_id') === String(suite)) {
      return reply(200, { total_count: 1, workflow_runs: [workflowRun] });
    }
    return reply(404, { message: 'Not Found' });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  git(root, 'init', '-q', '--bare', '--initial-branch=main', origin);
  mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.name', 'CI Fixture');
  git(work, 'config', 'user.email', 'fixture@example.invalid');
  git(work, 'remote', 'add', 'origin', origin);
  main0 = commitFile('README.md', 'fixture\n', 'main');
  git(work, 'checkout', '-qb', 'pr-7');
  prHead = commitFile('feature.ts', 'export const feature = 7;\n', 'pr 7');
  unmoved = squash(git(work, 'rev-parse', `${prHead}^{tree}`), main0, 7);
  git(work, 'push', '-q', 'origin', `${main0}:refs/heads/main`, `${prHead}:refs/pull/7/head`,
    `${unmoved}:refs/heads/gh-readonly-queue/main/pr-7-${main0}`);
  // The runner checkout: full history of branches, no pull request refs.
  git(root, 'clone', '-q', '--no-tags', origin, runner);
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

// Push extra fixture commits so the runner sees them as a fresh queue checkout.
function publish(refs: Record<string, string>): void {
  git(work, 'push', '-q', '-f', 'origin', ...Object.entries(refs).map(([ref, sha]) => `${sha}:${ref}`));
  git(runner, 'fetch', '-q', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*');
}

describe('merge-queue reuse decision', () => {
  it('reuses an unmoved-main squash whose tree equals the tested pull request head', async () => {
    arm(prHead);
    const { output, log } = await decide(group(7, unmoved, main0));
    expect(output).toBe('reuse=true\n');
    expect(log).toMatch(new RegExp(`^\\[reuse-green-tree\\] reuse=true: pr-7 tested ${prHead.slice(0, 12)}`));
    expect(requests).toEqual([
      `/repos/${repository}/commits/${prHead}/check-runs?per_page=100`,
      `/repos/${repository}/actions/runs?check_suite_id=${suite}`,
    ]);
  });

  it('runs fully when main moved, because the squashed tree differs', async () => {
    git(work, 'checkout', '-q', 'main');
    git(work, 'reset', '-q', '--hard', main0);
    const moved = commitFile('other.ts', 'export const other = 1;\n', 'main moved');
    git(work, 'cherry-pick', '-n', prHead);
    git(work, 'commit', '-qm', 'squash pr-7 onto moved main');
    const squashed = git(work, 'rev-parse', 'HEAD');
    expect(git(work, 'rev-parse', `${squashed}^{tree}`)).not.toBe(git(work, 'rev-parse', `${prHead}^{tree}`));
    publish({ 'refs/heads/main': moved, [`refs/heads/gh-readonly-queue/main/pr-7-${moved}`]: squashed });
    arm(prHead);
    const { output, log } = await decide(group(7, squashed, moved));
    expect(output).toBe('reuse=false\n');
    expect(log).toContain('head tree differs from the group tree');
    expect(requests, 'differing trees never reach the API').toEqual([]);
  });

  it('runs fully when main moved without changing the tree, since the tested merge may differ', async () => {
    git(work, 'checkout', '-q', 'main');
    git(work, 'reset', '-q', '--hard', main0);
    git(work, 'commit', '-q', '--allow-empty', '-m', 'empty main commit');
    const moved = git(work, 'rev-parse', 'HEAD');
    const squashed = squash(git(work, 'rev-parse', `${prHead}^{tree}`), moved, 7);
    publish({ 'refs/heads/main': moved, [`refs/heads/gh-readonly-queue/main/pr-7-${moved}`]: squashed });
    arm(prHead);
    const { output, log } = await decide(group(7, squashed, moved));
    expect(output).toBe('reuse=false\n');
    expect(log).toContain('main moved since pr-7 was tested');
  });

  it('reuses a moved main the pull request already merged in', async () => {
    git(work, 'checkout', '-q', 'main');
    git(work, 'reset', '-q', '--hard', main0);
    const moved = commitFile('upstream.ts', 'export const upstream = 1;\n', 'main moved');
    git(work, 'checkout', '-q', '-B', 'pr-8', prHead);
    git(work, 'merge', '-q', '--no-edit', moved);
    const merged = git(work, 'rev-parse', 'HEAD');
    const squashed = squash(git(work, 'rev-parse', `${merged}^{tree}`), moved, 8);
    publish({ 'refs/heads/main': moved, [`refs/heads/gh-readonly-queue/main/pr-8-${moved}`]: squashed });
    git(work, 'push', '-q', '-f', 'origin', `${merged}:refs/pull/8/head`);
    arm(merged);
    expect((await decide(group(8, squashed, moved))).output).toBe('reuse=true\n');
  });

  it('refuses a group holding two pull requests', async () => {
    const tree = git(work, 'rev-parse', `${prHead}^{tree}`);
    const first = squash(tree, main0, 7);
    git(work, 'checkout', '-q', '-B', 'pr-9', main0);
    const pr9 = commitFile('second.ts', 'export const second = 9;\n', 'pr 9');
    git(work, 'checkout', '-q', '--detach', first);
    git(work, 'cherry-pick', '-n', pr9);
    git(work, 'commit', '-qm', 'squash pr-9');
    const second = git(work, 'rev-parse', 'HEAD');
    publish({ 'refs/heads/main': main0, [`refs/heads/gh-readonly-queue/main/pr-9-${first}`]: second });
    git(work, 'push', '-q', '-f', 'origin', `${pr9}:refs/pull/9/head`);
    arm(pr9);
    const named = await decide(group(9, second, main0, first));
    expect(named.output).toBe('reuse=false\n');
    expect(named.log).toContain('pr-9 is not the first entry on its base');
    // Even a ref naming the base cannot hide a second squashed commit.
    const counted = await decide(group(9, second, main0));
    expect(counted.output).toBe('reuse=false\n');
    expect(counted.log).toContain('holds more than one pull request');
    expect(requests).toEqual([]);
  });

  it('requires every reuse-gated check to be present', async () => {
    const names = checkNames();
    expect(names).toEqual(expect.arrayContaining(['Type Check', 'Lint', 'Test Classification', 'Hermetic Unit Tests', 'Security Audit',
      'Governance Smoke', 'Rust Compile Gate (Windows)', 'Rust Compile Gate (Linux)', 'Integration Tests (changed files)',
      'Server Bundle Size', ...[1, 2, 3, 4].map(shard => `o8 next Native Tests (Linux) (${shard})`)]));
    for (const name of names) {
      const listing = green(prHead);
      listing.check_runs = listing.check_runs.filter(run => run.name !== name);
      listing.total_count = listing.check_runs.length;
      arm(prHead, listing);
      const { output, log } = await decide(group(7, unmoved, main0));
      expect(output, name).toBe('reuse=false\n');
      expect(log).toContain(`"${name}" has no check run`);
    }
  }, 60_000);

  it.each(['failure', 'cancelled', 'skipped', 'neutral', null])('refuses a required check concluded %s', async conclusion => {
    const listing = green(prHead);
    const lint = listing.check_runs.find(run => run.name === 'Lint')!;
    lint.conclusion = conclusion;
    if (conclusion === null) lint.status = 'in_progress';
    arm(prHead, listing);
    const { output } = await decide(group(7, unmoved, main0));
    expect(output).toBe('reuse=false\n');
  });

  it('refuses when a duplicate run of a required check did not pass', async () => {
    const listing = green(prHead);
    listing.check_runs.push({ ...listing.check_runs.find(run => run.name === 'Security Audit')!, conclusion: 'failure' });
    listing.total_count = listing.check_runs.length;
    arm(prHead, listing);
    expect((await decide(group(7, unmoved, main0))).output).toBe('reuse=false\n');
  });

  it('compares the commit the checks ran on, not the pull request tip', async () => {
    git(work, 'checkout', '-q', '-B', 'pr-7-old', main0);
    const older = commitFile('feature.ts', 'export const feature = 6;\n', 'pr 7 earlier');
    git(work, 'push', '-q', '-f', 'origin', `${older}:refs/heads/fixture-older`);
    git(runner, 'fetch', '-q', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*');
    arm(prHead, green(older), older);
    const stale = await decide(group(7, unmoved, main0));
    expect(stale.output).toBe('reuse=false\n');
    expect(stale.log).toContain('tested tree of pr-7 differs from the group tree');

    const split = green(prHead);
    split.check_runs.find(run => run.name === 'Rust Compile Gate (Windows)')!.head_sha = older;
    arm(prHead, split);
    const disagree = await decide(group(7, unmoved, main0));
    expect(disagree.output).toBe('reuse=false\n');
    expect(disagree.log).toContain('disagree on their commit');
  });

  it('refuses checks from another workflow, event or run', async () => {
    arm(prHead);
    workflowRun = { ...workflowRun, path: '.github/workflows/other.yml' };
    expect((await decide(group(7, unmoved, main0))).output).toBe('reuse=false\n');
    arm(prHead);
    workflowRun = { ...workflowRun, event: 'push' };
    expect((await decide(group(7, unmoved, main0))).output).toBe('reuse=false\n');
    const twoRuns = green(prHead);
    twoRuns.check_runs.find(run => run.name === 'Governance Smoke')!.check_suite = { id: suite + 1 };
    arm(prHead, twoRuns);
    expect((await decide(group(7, unmoved, main0))).log).toContain('more than one workflow run');
    const foreign = green(prHead);
    foreign.check_runs.find(run => run.name === 'Type Check')!.app = { slug: 'other-app' };
    arm(prHead, foreign);
    expect((await decide(group(7, unmoved, main0))).output).toBe('reuse=false\n');
  });

  it('fails closed on pagination gaps, API errors, missing credentials and other events', async () => {
    const partial = green(prHead);
    partial.total_count += 1;
    arm(prHead, partial);
    expect((await decide(group(7, unmoved, main0))).log).toContain('listing is incomplete');
    arm(prHead, 'error');
    expect((await decide(group(7, unmoved, main0))).log).toContain('answered 500');
    arm(prHead);
    expect((await decide(group(7, unmoved, main0), { env: { GITHUB_TOKEN: '' } })).output).toBe('reuse=false\n');
    expect((await decide(group(7, unmoved, main0), { env: { GITHUB_API_URL: 'http://127.0.0.1:1' } })).output)
      .toBe('reuse=false\n');
    expect((await decide({ merge_group: { ...group(7, unmoved, main0).merge_group, head_ref: 'refs/heads/main' } })).output)
      .toBe('reuse=false\n');
    expect((await decide(group(70, unmoved, main0))).output, 'an unknown pull request').toBe('reuse=false\n');
    for (const eventName of ['pull_request', 'push', 'schedule', 'workflow_dispatch']) {
      const { output, log } = await decide({}, { eventName });
      expect(output).toBe('reuse=false\n');
      expect(log).toBe(`[reuse-green-tree] reuse=false: ${eventName} event`);
    }
  });
});

describe('merge-queue reuse wiring', () => {
  it('runs the decision first on every event and only skips steps, never jobs', () => {
    const jobs = workflow.jobs;
    expect(Object.keys(jobs)[0]).toBe('reuse');
    expect(jobs.reuse.if).toBeUndefined();
    expect(jobs.reuse.needs).toBeUndefined();
    expect(jobs.reuse.outputs).toEqual({ reuse: '${{ steps.decide.outputs.reuse }}' });
    const decision = jobs.reuse.steps.find((step: { id?: string }) => step.id === 'decide');
    expect(decision.run).toBe('node scripts/ci/reuse-green-tree.mjs');
    const gated = Object.keys(jobs).filter(id => [jobs[id].needs ?? []].flat().includes('reuse'));
    expect(gated.sort()).toEqual(['classification', 'governance-smoke', 'integration-changed', 'lint', 'o8-next-tests',
      'rust-check-linux', 'rust-check-windows', 'security', 'server-bundle-size', 'test-shards', 'typecheck']);
    for (const id of gated) {
      expect(String(jobs[id].if ?? ''), `${id} job condition`).not.toContain('reuse');
      for (const step of jobs[id].steps) {
        expect(step.if === gate || (step.if.startsWith(`${gate} && `) && !step.if.includes('||')),
          `${id} step ${step.name ?? step.uses ?? step.run}`).toBe(true);
      }
    }
    expect(jobs.test.needs).toEqual(['test-shards', 'o8-next-tests', 'classification']);
    expect(jobs.test.if).toBe("always() && github.event.schedule != '41 13 * * 1'");
  });
});
