import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { parse } from 'yaml';
import { postPrReviewComment } from './pr-review-comment.mjs';

const body = '## 🔍 PR Review Bot\n\n| Metric | Value |\n|---|---|\n| Files changed | 1 |';
const apiError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

function fixture({ comments = [], create, update, list, fork = false, summaryError } = {}) {
  const calls = { list: [], create: [], update: [], posted: [], summaries: [], writes: 0, warnings: [], info: [] };
  const context = {
    serverUrl: 'https://github.com',
    repo: { owner: 'o8-run', repo: 'o8' },
    issue: { number: 5492 },
    payload: { pull_request: { head: { repo: { full_name: fork ? 'contributor/o8' : 'o8-run/o8' } } } },
  };
  const github = {
    rest: {
      issues: {
        listComments() {},
        async createComment(params) {
          calls.create.push(params);
          await create?.(params, calls.create.length);
          calls.posted.push(params);
        },
        async updateComment(params) {
          calls.update.push(params);
          await update?.(params, calls.update.length);
        },
      },
      pulls: {
        async listFiles() {
          return { data: [{ filename: 'example.mjs', additions: 2, deletions: 1, changes: 3, status: 'added' }] };
        },
      },
    },
    async paginate(method, params) {
      assert.equal(method, github.rest.issues.listComments);
      calls.list.push(params);
      await list?.(params, calls.list.length);
      return comments;
    },
  };
  const core = {
    summary: {
      addRaw(value) {
        calls.summaries.push(value);
        return this;
      },
      async write() {
        calls.writes += 1;
        if (summaryError) throw summaryError;
      },
    },
    warning(message) { calls.warnings.push(message); },
    info(message) { calls.info.push(message); },
  };
  return { github, context, core, body, calls };
}

function assertSummary(f) {
  assert.deepEqual(f.calls.summaries, [body]);
  assert.equal(f.calls.writes, 1);
}

test('retries a 500 once, posts one report, and returns normally', async () => {
  const f = fixture({ create: (_params, attempt) => { if (attempt === 1) throw apiError(500); } });
  await assert.doesNotReject(postPrReviewComment(f));
  assert.equal(f.calls.list.length, 2);
  assert.equal(f.calls.create.length, 2);
  assert.deepEqual(f.calls.posted, [{ owner: 'o8-run', repo: 'o8', issue_number: 5492, body }]);
  assert.deepEqual(f.calls.summaries, []);
  assert.deepEqual(f.calls.warnings, []);
});

test('two 500s warn and write the report to the summary without throwing', async () => {
  const f = fixture({ create: () => { throw apiError(500); } });
  await assert.doesNotReject(postPrReviewComment(f));
  assert.equal(f.calls.create.length, 2);
  assert.deepEqual(f.calls.posted, []);
  assertSummary(f);
  assert.equal(f.calls.warnings.length, 1);
  assert.match(f.calls.warnings[0], /Could not post the PR review comment: HTTP 500/);
});

for (const status of [403, 404, 422]) {
  test(`a ${status} falls back to the summary without retrying or throwing`, async () => {
    const f = fixture({ create: () => { throw apiError(status); } });
    await assert.doesNotReject(postPrReviewComment(f));
    assert.equal(f.calls.list.length, 1);
    assert.equal(f.calls.create.length, 1);
    assertSummary(f);
    assert.equal(f.calls.warnings.length, 1);
    assert.match(f.calls.warnings[0], new RegExp(`HTTP ${status}`));
  });
}

test('updates the existing marked bot comment and preserves the report text', async () => {
  const f = fixture({ comments: [
    { id: 1, user: { type: 'User' }, body },
    { id: 2, user: { type: 'Bot' }, body: 'Another report' },
    { id: 3, user: { type: 'Bot' }, body: null },
    { id: 4, user: { type: 'Bot' }, body: '## 🔍 PR Review Bot\n\nOld report' },
  ] });
  await postPrReviewComment(f);
  assert.deepEqual(f.calls.update, [{ owner: 'o8-run', repo: 'o8', comment_id: 4, body }]);
  assert.deepEqual(f.calls.list, [{ owner: 'o8-run', repo: 'o8', issue_number: 5492, per_page: 100 }]);
  assert.deepEqual(f.calls.create, []);
  assert.deepEqual(f.calls.summaries, []);
});

test('forks write to the summary without calling the comment API', async () => {
  const f = fixture({ fork: true });
  await postPrReviewComment(f);
  assertSummary(f);
  assert.deepEqual(f.calls.list, []);
  assert.deepEqual(f.calls.create, []);
  assert.deepEqual(f.calls.update, []);
  assert.deepEqual(f.calls.warnings, []);
  assert.deepEqual(f.calls.info, ['Fork pull request detected; wrote the report to the job summary.']);
});

test('retries a network error once', async () => {
  const f = fixture({ create: (_params, attempt) => {
    if (attempt === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  } });
  await assert.doesNotReject(postPrReviewComment(f));
  assert.equal(f.calls.create.length, 2);
  assert.equal(f.calls.posted.length, 1);
  assert.deepEqual(f.calls.summaries, []);
});

test('persistent network errors stop after one retry and fall back to the summary', async () => {
  const f = fixture({ create: () => { throw new TypeError('fetch failed'); } });
  await assert.doesNotReject(postPrReviewComment(f));
  assert.equal(f.calls.create.length, 2);
  assertSummary(f);
  assert.match(f.calls.warnings[0], /fetch failed/);
});

test('a failed comment lookup falls back to the summary', async () => {
  const f = fixture({ list: () => { throw apiError(404); } });
  await assert.doesNotReject(postPrReviewComment(f));
  assert.equal(f.calls.list.length, 1);
  assert.deepEqual(f.calls.create, []);
  assert.deepEqual(f.calls.update, []);
  assertSummary(f);
  assert.match(f.calls.warnings[0], /HTTP 404/);
});

test('a transient update failure retries the update without creating a comment', async () => {
  const f = fixture({
    comments: [{ id: 4, user: { type: 'Bot' }, body }],
    update: (_params, attempt) => { if (attempt === 1) throw apiError(503); },
  });
  await assert.doesNotReject(postPrReviewComment(f));
  assert.equal(f.calls.list.length, 2);
  assert.equal(f.calls.update.length, 2);
  assert.deepEqual(f.calls.create, []);
  assert.deepEqual(f.calls.summaries, []);
});

test('retry finds a comment created before the failed response instead of duplicating it', async () => {
  const comments = [];
  const f = fixture({ comments, create: () => {
    comments.push({ id: 4, user: { type: 'Bot' }, body });
    throw apiError(502);
  } });
  await assert.doesNotReject(postPrReviewComment(f));
  assert.equal(f.calls.create.length, 1);
  assert.deepEqual(f.calls.update, [{ owner: 'o8-run', repo: 'o8', comment_id: 4, body }]);
  assert.deepEqual(f.calls.summaries, []);
});

test('summary write failures warn without failing the check', async () => {
  const f = fixture({ create: () => { throw apiError(403); }, summaryError: new Error('summary unavailable') });
  await assert.doesNotReject(postPrReviewComment(f));
  assertSummary(f);
  assert.equal(f.calls.warnings.length, 2);
  assert.match(f.calls.warnings[1], /summary unavailable/);
});

const workflow = parse(readFileSync(new URL('../../.github/workflows/pr-review.yml', import.meta.url), 'utf8'));
const script = workflow.jobs.review.steps.find(step => step.with?.script).with.script;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const analyze = new AsyncFunction('github', 'context', 'core', 'require', script);
const require = createRequire(import.meta.url);
const workflowRequire = (id) => id === 'child_process' ? { execSync: () => '' } : require(id);

test('the workflow imports the helper and preserves its report when posting fails', async () => {
  const f = fixture({ create: () => { throw apiError(422); } });
  await assert.doesNotReject(analyze(f.github, f.context, f.core, workflowRequire));
  assert.equal(f.calls.writes, 1);
  assert.equal(f.calls.warnings.length, 1);
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.summaries[0], '## 🔍 PR Review Bot\n\n'
    + '| Metric | Value |\n|---|---|\n'
    + '| Files changed | 1 |\n| Additions | +2 |\n| Deletions | -1 |\n| New files | 1 |\n\n'
    + '---\n*Automated review — [CI workflow](https://github.com/o8-run/o8/actions)*');
});

test('report-building errors still fail the workflow', async () => {
  const f = fixture();
  f.github.rest.pulls.listFiles = async () => { throw apiError(500); };
  await assert.rejects(analyze(f.github, f.context, f.core, workflowRequire), { status: 500 });
  assert.deepEqual(f.calls.list, []);
  assert.deepEqual(f.calls.summaries, []);
});
