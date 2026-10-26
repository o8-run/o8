import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ installationId: 84500 }));
vi.mock('@/lib/github-broker/env', () => ({ getGitHubAppConfig: () => null }));
vi.mock('@/lib/github-broker/managed', () => ({
  readManagedGithubToken: () => ({ token: 'ci-steps-fixture', installationId: state.installationId, accountLogin: 'example' }),
}));
vi.mock('@/lib/github-broker/repo', () => ({
  DEFAULT_GITHUB_REPO: 'example/default',
  resolveRepoSlug: async (repo: string | null, fallback: string) => repo ?? fallback,
  normalizeRepoSlug: (repo: string) => repo,
}));

import { GET } from './route';

const read = () => GET(new Request('http://fixture.invalid/api/panel/ci/11?repo=example/steps'), {
  params: Promise.resolve({ id: '11' }),
});
function upstreamJobs(jobs: unknown[]) {
  const upstream = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/jobs?')) return Response.json({ jobs });
    if (url.includes('/annotations?')) return Response.json([{
      path: 'fixture.ts', start_line: 7, annotation_level: 'failure', message: 'Fixture failure',
    }]);
    if (url.endsWith('/actions/runs/11')) return Response.json({ id: 11, pull_requests: [] });
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  vi.stubGlobal('fetch', upstream);
  return upstream;
}

beforeEach(() => { state.installationId++; });
afterEach(() => { vi.unstubAllGlobals(); });

it('returns ordered job steps through the real GET and broker without losing annotations', async () => {
  const steps = [
    { name: 'Checkout', status: 'completed', conclusion: 'success', number: 1 },
    { name: 'Unit tests', status: 'completed', conclusion: 'failure', number: 3 },
    { name: 'Upload', status: 'completed', conclusion: 'skipped', number: 4 },
  ];
  const upstream = upstreamJobs([{
    id: 22, name: 'Verify', status: 'completed', conclusion: 'failure',
    html_url: 'https://github.com/example/steps/actions/runs/11/job/22',
    check_run_url: 'https://api.github.com/repos/example/steps/check-runs/33', steps,
  }, { id: 23, name: 'Build', steps: [{ name: 'Compile', status: 'in_progress', conclusion: null, number: 2 }] }]);
  const response = await read();
  expect(response.status).toBe(200);
  const detail = await response.json();
  expect(detail.run.jobs[0].steps).toEqual(steps);
  expect(detail.run.jobs[1].steps).toEqual([{ name: 'Compile', status: 'in_progress', conclusion: '', number: 2 }]);
  expect(detail).toMatchObject({ repo: 'example/steps', run: {
    databaseId: 11, jobs: [{ databaseId: 22, name: 'Verify', conclusion: 'failure', checkRunId: 33,
      annotations: [{ path: 'fixture.ts', startLine: 7, message: 'Fixture failure' }],
    }, { databaseId: 23, name: 'Build' }],
    annotations: [{ path: 'fixture.ts', jobName: 'Verify', message: 'Fixture failure' }],
  } });
  expect(upstream).toHaveBeenCalledTimes(3);
});

it.each([{ label: 'omitted', steps: undefined }, { label: 'empty', steps: [] }])('returns empty steps when a job has $label step details', async ({ steps }) => {
  upstreamJobs([{ id: 22, steps }]);
  const response = await read();
  expect(response.status).toBe(200);
  expect((await response.json()).run.jobs[0].steps).toEqual([]);
});

it('normalizes absent optional step fields while preserving zero and empty values', async () => {
  upstreamJobs([{ id: 22, steps: [{}, { name: null, status: null, conclusion: null, number: null },
    { name: '', status: '', conclusion: '', number: 0 }] }]);
  const response = await read();
  expect(response.status).toBe(200);
  expect((await response.json()).run.jobs[0].steps).toEqual([
    { name: '', status: '', conclusion: '', number: 0 },
    { name: '', status: '', conclusion: '', number: 0 },
    { name: '', status: '', conclusion: '', number: 0 },
  ]);
});

it('keeps an upstream job read failure as an error instead of presenting empty steps', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).includes('/jobs?')
    ? Response.json({ message: 'Fixture jobs unavailable' }, { status: 502 })
    : Response.json({ id: 11, pull_requests: [] })));
  const response = await read();
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: expect.stringContaining('Fixture jobs unavailable') });
});
