import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, expect, it } from 'vitest';

let server: ChildProcess;
let origin = '';
const headers = { authorization: 'Bearer fixture-next-pr-operator', 'Content-Type': 'application/json' };
beforeEach(async () => {
  server = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/dev-server.ts', '--pull-requests'], {
    env: { ...process.env, O8_NEXT_API_TOKEN: 'fixture-next-pr-operator' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  for await (const line of createInterface({ input: server.stdout! })) {
    try { origin = (JSON.parse(line) as { origin: string }).origin; } catch { continue; }
    if (origin) break;
  }
  expect(origin, 'disposable production route host').toBeTruthy();
}, 30_000);
afterEach(async () => {
  if (server?.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
});

const control = (body: unknown) => fetch(`${origin}/__fixture/pr-gates`, { method: 'POST', headers, body: JSON.stringify(body) });
const merge = (expectedMergeGate?: string, action = 'merge') => fetch(`${origin}/api/panel/prs/7`, { method: 'POST', headers,
  body: JSON.stringify({ repo: 'example/repo', action, commitSha: 'a'.repeat(40), mergeMethod: 'squash', ...(expectedMergeGate ? { expectedMergeGate } : {}) }) });
const providerMerges = async () => {
  const value = await (await fetch(`${origin}/api/panel/status`, { headers })).json();
  return value.providerWrites.filter((r: { publication: boolean }) => r.publication);
};

it('retains submitted review bodies and their exact revisions across refresh and changed code', async () => {
  await control({ scenario: 'submitted-reviews' });
  const read = async () => {
    const response = await fetch(`${origin}/api/panel/prs/7?repo=example/repo`, { headers });
    expect(response.status).toBe(200);
    return (await response.json()).pr;
  };
  const detail = await read();
  expect(detail.reviewComments).toEqual([]);
  expect(detail.submittedReviews).toEqual([
    { id: 501, author: 'fixture-reviewer', body: 'Close/reset may rebind a stopped packet.', state: 'COMMENTED',
      submittedAt: '2026-11-10T01:02:19Z', reviewedHeadSha: 'c'.repeat(40), url: 'https://github.com/example/repo/pull/7#pullrequestreview-501' },
    { id: 502, author: 'fixture-reviewer', body: 'Re-review: APPROVE. The correction covers reassigned lanes.', state: 'COMMENTED',
      submittedAt: '2026-11-10T01:09:36Z', reviewedHeadSha: 'a'.repeat(40), url: 'https://github.com/example/repo/pull/7#pullrequestreview-502' },
  ]);
  expect(detail.reviewDecision).toBeNull();
  const ui = spawnSync(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/pull-request-desktop-probe.ts'], { input: JSON.stringify({ mode: 'reviews', detail }), encoding: 'utf8', timeout: 20_000 });
  expect(ui.status, ui.stderr).toBe(0);
  const rendered = JSON.parse(ui.stdout);
  expect(rendered.initialText).toContain('Close/reset may rebind a stopped packet.');
  expect(rendered.initialText).toContain('Reviewed cccccccc');
  expect(rendered.initialText).toContain('Different revision');
  expect(rendered.initialText).toContain('Current revision');
  expect(rendered.initialText.match(/Commented/g)).toHaveLength(2);
  expect(rendered.links).toEqual(detail.submittedReviews.map((review: { url: string }) => ({ href: review.url, label: 'Open review by fixture-reviewer on GitHub' })));
  expect(rendered.repeatedText).toBe(rendered.initialText);
  expect(rendered.focusRetained).toBe(true);
  expect(rendered.changedText.match(/Different revision/g)).toHaveLength(2);
  expect(rendered.changedText).not.toContain('Current revision');
  expect(rendered.unknownText).toContain('Reviewed revision unavailable');
  expect((await read()).submittedReviews).toEqual(detail.submittedReviews);
  await control({ scenario: 'head-advanced' });
  const changed = await read();
  expect(changed.headSha).toBe('d'.repeat(40));
  expect(changed.submittedReviews).toEqual(detail.submittedReviews);
  expect(changed.reviewDecision).toBeNull();
  await control({ scenario: 'reviews-incomplete' });
  expect((await read()).discussionIncomplete).toBe(true);
  await control({ scenario: 'reviews-unavailable' });
  const interrupted = await fetch(`${origin}/api/panel/prs/7?repo=example/repo`, { headers });
  expect(interrupted.ok).toBe(false);
  expect((await interrupted.json()).pr).toBeUndefined();
  await control({ scenario: 'ready' });
  expect((await read()).submittedReviews).toEqual(detail.submittedReviews);
  expect(await providerMerges()).toEqual([]);
}, 60_000);

it.each(['merge', 'enable-auto-merge'])('rejects a new held packet between the read and the desktop %s POST', async (action) => {
  const detail = await (await fetch(`${origin}/api/panel/prs/7?repo=example/repo`, { headers })).json();
  expect(detail.pr.mergeGate.allowed).toBe(true);
  await control({ packet: 'held' });
  const response = await merge(detail.pr.mergeGate.snapshot, action);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ mergeRefused: true, ok: false });
  expect(await providerMerges()).toEqual([]);
});

it.each(['merge', 'enable-auto-merge'])('rechecks after broker metadata is read and before %s publication', async (action) => {
  await control({ scenario: 'link-on-metadata' });
  const response = await merge(undefined, action);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ mergeRefused: true, ok: false });
  expect(await providerMerges()).toEqual([]);
});

it.each(['checks-failed', 'checks-pending', 'checks-unavailable', 'reviews-incomplete', 'review-changes', 'blocked', 'runtime-live', 'runtime-unknown', 'owner-unavailable'])('enforces %s for a desktop caller without a client snapshot', async (scenario) => {
  await control({ scenario });
  const response = await merge();
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ mergeRefused: true, ok: false });
  expect(await providerMerges()).toEqual([]);
});

it.each(['merge', 'enable-auto-merge'])('allows unchanged, unlinked %s with its reviewed snapshot', async (action) => {
  const detail = await (await fetch(`${origin}/api/panel/prs/7?repo=example/repo`, { headers })).json();
  expect(detail.pr.mergeGate.allowed).toBe(true);
  expect((await merge(detail.pr.mergeGate.snapshot, action)).status).toBe(200);
  expect(await providerMerges()).toHaveLength(1);
});

it('serves paged PRs and details and refuses unauthenticated mutations through middleware', async () => {
  const list = await fetch(`${origin}/api/panel/prs?repo=example/repo&view=list&state=open&sort=updated&page=1`, { headers });
  expect(list.status).toBe(200);
  expect(await list.json()).toMatchObject({ repo: 'example/repo', nextPage: 2, prs: [{ number: 7 }] });
  const detail = await fetch(`${origin}/api/panel/prs/7?repo=example/repo`, { headers });
  expect(await detail.json()).toMatchObject({ pr: { number: 7, headSha: 'a'.repeat(40), files: [{ path: 'change.rs' }], statusCheckRollup: [{ name: 'CI' }] } });
  const body = JSON.stringify({ repo: 'example/repo', action: 'comment', comment: 'Fixture feedback' });
  expect((await fetch(`${origin}/api/panel/prs/7`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })).status).toBe(401);
  expect((await fetch(`${origin}/api/panel/prs/7`, { method: 'POST', body, headers })).status).toBe(200);
  const refreshed = await fetch(`${origin}/api/panel/prs/7?repo=example/repo`, { headers });
  expect((await refreshed.json()).pr.issueComments).toEqual(expect.arrayContaining([expect.objectContaining({ body: 'Fixture feedback' })]));
});
