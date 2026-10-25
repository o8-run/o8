import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, expect, it } from 'vitest';

let server: ChildProcess;
let origin = '';
const headers = { authorization: 'Bearer fixture-next-pr-operator', 'Content-Type': 'application/json' };
beforeAll(async () => {
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
afterAll(async () => {
  if (server?.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
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
