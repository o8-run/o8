import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { realpathSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, expect, it } from 'vitest';
let host: ChildProcess;
let origin = '';
let workspace = '';
const token = 'fixture-inline-operator';
beforeAll(async () => {
  host = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', 'scripts/next/dev-server.ts', '--inline'], {
    env: { ...process.env, O8_NEXT_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  for await (const line of createInterface({ input: host.stdout! })) {
    try { origin = (JSON.parse(line) as { origin?: string }).origin || origin; } catch { continue; }
    if (origin) break;
  }
  const data = await (await request('/api/mobile/orchestrator/threads')).json() as { threads: Array<{ repoPath: string }> };
  workspace = realpathSync(data.threads[0].repoPath);
}, 30_000);
afterAll(async () => { if (host?.exitCode === null) { host.kill('SIGTERM'); await once(host, 'exit'); } });
function request(path: string, body?: object, credential = token) {
  return fetch(origin + path, { method: body ? 'POST' : 'GET', headers: {
    authorization: `Bearer ${credential}`, 'content-type': 'application/json',
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
it('reads real worktree hunks and preserves authentication and revision refusals', async () => {
  const path = '/api/worktrees/diff?' + new URLSearchParams({ worktreePath: workspace, baseBranch: 'main' });
  const response = await request(path); expect(response.status).toBe(200);
  const data = await response.json() as { diff: string; headSha: string; truncated: boolean };
  expect(data.diff).toContain('@@'); expect(data.headSha).toMatch(/^[a-f0-9]{40}$/); expect(data.truncated).toBe(false);
  expect((await request(path, undefined, 'fixture-invalid')).status).toBe(401);
  expect((await request(path + '&headSha=' + '0'.repeat(40))).status).toBe(409);
});
it('uses the production merge route and its body/idempotency refusals', async () => {
  expect((await request('/api/orchestrator/merge', {})).status).toBe(400);
  expect((await request('/api/orchestrator/merge', { packetId: 'next-inline' })).status).toBe(400);
  expect((await request('/api/orchestrator/merge', { packetId: 'next-inline', idempotencyKey: 'fixture-inline-decision' }, 'fixture-invalid')).status).toBe(401);
});

it('bounds binary/large diffs and refuses selected-path escapes without reading a symlink target', async () => {
  const canary = ['owned', 'inline-boundary', 'canary'].join('-');
  const outside = join(workspace, '..', 'outside-diff.txt'); writeFileSync(outside, canary);
  const link = join(workspace, 'outside-link.txt'); symlinkSync(outside, link);
  const base = '/api/worktrees/diff?' + new URLSearchParams({ worktreePath: workspace, baseBranch: 'main' });
  for (const file of ['../outside-diff.txt', outside]) expect((await request(base + '&' + new URLSearchParams({ file }))).ok).toBe(false);
  const linked = await request(base + '&file=outside-link.txt'); expect(await linked.text()).not.toContain(canary);
  unlinkSync(link);
  writeFileSync(join(workspace, 'binary.dat'), Buffer.from([0, 0xff, 0xfe]));
  const binary = await (await request(base + '&file=binary.dat')).json() as { diff: string };
  expect(binary.diff).toContain('Binary');
  writeFileSync(join(workspace, 'large.txt'), 'x'.repeat(2 * 1024 * 1024));
  const large = await (await request(base + '&file=large.txt')).json() as { diff: string; truncated: boolean };
  expect(large.truncated).toBe(true); expect(large.diff.length).toBeLessThanOrEqual(2 * 1024 * 1024);
});

it('keeps held-approval confirmation behind the production operator-token gate', async () => {
  const held = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/dev-server.ts', '--inline', '--inline-held'], {
    env: { ...process.env, O8_NEXT_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    let heldOrigin = '';
    for await (const line of createInterface({ input: held.stdout! })) {
      try { heldOrigin = (JSON.parse(line) as { origin?: string }).origin || heldOrigin; } catch { continue; }
      if (heldOrigin) break;
    }
    held.stdout!.resume();
    expect(heldOrigin).toBeTruthy();
    const send = (path: string, body?: object, credential = token) => fetch(heldOrigin + path, {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const before = await (await send('/api/orchestrator/inline-fixture-log')).json() as { held: { head: string; baseHead: string } };
    const merge = await send('/api/orchestrator/merge', { packetId: 'next-inline', expectedHeadSha: before.held.head,
      idempotencyKey: 'fixture-held-auth' });
    const receipt = await merge.json() as { result: { approvalId: string } };
    expect(receipt.result.approvalId).toBeTruthy();
    const denied = await send('/api/panel/approvals', { action: 'approve', id: receipt.result.approvalId }, 'fixture-invalid');
    expect(denied.status).toBe(401);
    expect(await (await send('/api/orchestrator/inline-fixture-log')).json()).toMatchObject({
      confirmation: null, held: { currentBase: before.held.baseHead, approval: { id: receipt.result.approvalId, status: 'pending' } },
    });
  } finally {
    if (held.exitCode === null) { held.kill('SIGTERM'); await once(held, 'exit'); }
  }
}, 60_000);
