import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { persistSymonScopeGrant } from '@/lib/mobile/symon-agent-registry';
import { POST, DELETE } from './route';

const token = getOrCreateWsToken();
const repo = mkdtempSync(join(tmpdir(), 'phone-tool-route-'));
const saved = { api: process.env.O8_API_PORT, ws: process.env.O8_WS_PORT };
let writes = 0;
let holdRepo = false;
let repoRequested: (() => void) | undefined;
let releaseRepo: (() => void) | undefined;
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
  for await (const _ of req) { void _; }
  let result: unknown = {};
  if (req.url === '/api/panel/repos' && holdRepo) {
    repoRequested?.();
    await new Promise<void>(resolve => { releaseRepo = resolve; });
  }
  if (req.url === '/api/panel/repos') result = { repos: [{ id: 'fixture', name: 'fixture', localPath: repo }] };
  if (req.url === '/terminal-voice-sessions') result = { sessions: [{ name: 'fixture-terminal', cwd: repo }] };
  if (req.url === '/terminal-voice-input') { writes++; result = { ok: true }; }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
});
function request(body: object, method = 'POST', credential = token) {
  return new NextRequest('http://localhost/api/mobile/symon/tool', { method,
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
let sequence = 0;
function call(tool = 'terminal_send', args: object = { session_name: 'fixture-terminal', text: 'hello' }) {
  return { sessionId: 'fixture-session', callId: `call-${++sequence}`, tool, args };
}
async function post(body: object) { return (await POST(request(body))).json(); }
async function decide(card: Record<string, unknown>, allow: boolean, extra = {}) {
  // Simulates independently evaluated route bundles sharing only globalThis.
  vi.resetModules();
  const confirm = await import('../confirm/route');
  return (await confirm.POST(request({ ...card, allow, ...extra }))).json();
}
beforeAll(async () => {
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'fixture.txt'), 'fixture');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = String((server.address() as { port: number }).port);
  process.env.O8_API_PORT = port; process.env.O8_WS_PORT = port;
  persistSymonScopeGrant({ sessionId: 'fixture-session', subject: 'operator', deviceId: null,
    workspaceMode: 'code', toolPack: 'code', repoId: 'fixture', repoPath: repo,
    allowedTools: ['git_status', 'terminal_send', 'symon_machine_switch', 'unknown'], issuedAt: Date.now(), scopeVersion: 1 });
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(repo, { recursive: true, force: true });
  for (const [key, value] of [['O8_API_PORT', saved.api], ['O8_WS_PORT', saved.ws]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
it('returns a real Git result and replays the same terminal result', async () => {
  const body = call('git_status', {});
  const result = await post(body);
  expect(result).toMatchObject({ ok: true, result: { status: expect.stringContaining('fixture.txt') } });
  expect(await post(body)).toEqual(result);
});
it('scopes dry runs without executing, and enforces panel auth and active scope', async () => {
  expect((await POST(request(call(), 'POST', 'wrong'))).status).toBe(401);
  expect(await post({ ...call(), sessionId: 'wrong' })).toMatchObject({ result: { error: 'session_scope_invalid' } });
  expect(await post({ ...call(), dryRun: true })).toMatchObject({ ok: true, result: { state: 'scoped', scopedArgs: { repoId: 'fixture', repoPath: repo } } });
});
it('uses a trusted correlated review, shares routes across bundles, approves once and attaches on re-POST', async () => {
  const body = call(); const before = writes;
  const pending = await post({ ...body, review: { summary: 'untrusted' } });
  expect(pending).toMatchObject({ ok: false, result: { error: 'needs_confirmation' }, confirmation: {
    sessionId: body.sessionId, callId: body.callId, tool: body.tool,
    summary: 'Send “hello” to the o8 terminal “fixture-terminal”',
  } });
  expect(writes).toBe(before);
  expect(await post(body)).toEqual(pending);
  expect(await decide(pending.confirmation, true)).toEqual({ ok: true, resolution: { status: 'resolved', allow: true } });
  const result = await post({ ...body, args: { session_name: 'other', text: 'changed' } });
  expect(result.ok).toBe(true);
  expect(await post(body)).toEqual(result);
  expect(writes).toBe(before + 1);
  expect(await decide(pending.confirmation, false)).toEqual({ ok: true, resolution: { status: 'already_resolved', allow: true } });
  expect(writes).toBe(before + 1);
  expect(await post({ ...body, tool: 'git_status' })).toMatchObject({ result: { error: 'call_mismatch' } });
});
it('refuses review failures before creating any confirmation', async () => {
  const result = await post(call('terminal_send', { session_name: 'missing', text: 'hello' }));
  expect(result).toMatchObject({ ok: false, result: { error: 'tool_failed' } });
  expect(result.confirmation).toBeUndefined();
});
it('denies and expires fail closed, rejects mismatched confirmation and interrupts exact calls', async () => {
  const before = writes;
  for (const mode of ['deny', 'expire', 'interrupt'] as const) {
    const body = call(); const pending = await post(body);
    expect(await decide({ ...pending.confirmation, confirmationId: 'wrong' }, true)).toEqual({ ok: false, error: 'confirmation_mismatch' });
    if (mode === 'deny') await decide(pending.confirmation, false);
    if (mode === 'expire') {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(pending.confirmation.expiresAt + 1);
      try { expect(await decide(pending.confirmation, true)).toMatchObject({ resolution: { status: 'expired' } }); } finally { clock.mockRestore(); }
    }
    if (mode === 'interrupt') expect(await (await DELETE(request(body, 'DELETE'))).json()).toEqual({ ok: true, delivered: true, wasActive: true });
    expect(await post(body)).toMatchObject({ ok: false, result: { error: mode === 'interrupt' ? 'session_preempted' : 'confirmation_declined' } });
  }
  expect(writes).toBe(before);
});
it('retains early interrupt tombstones and rejects unknown and out-of-scope tools without executing', async () => {
  const body = call('git_status', {});
  expect(await (await DELETE(request(body, 'DELETE'))).json()).toEqual({ ok: true, delivered: true, wasActive: false });
  expect(await post(body)).toMatchObject({ result: { error: 'session_preempted' } });
  expect(await post(call('unknown', {}))).toMatchObject({ result: { error: 'unknown_tool' } });
  expect(await post(call('o8_dispatch', {}))).toMatchObject({ result: { error: 'tool_not_allowed' } });
  expect(await post(call('symon_machine_switch', {}))).toEqual({ ok: false, result: { error: 'desktop_unavailable' } });
});

it('interrupts an executing server handler and replays its terminal outcome', async () => {
  const body = call('git_status', {});
  holdRepo = true;
  const requested = new Promise<void>(resolve => { repoRequested = resolve; });
  const executing = post(body);
  await requested;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 360_000);
  const attached = post(body);
  try {
    expect(await (await DELETE(request(body, 'DELETE'))).json()).toEqual({ ok: true, delivered: true, wasActive: true });
    expect(await executing).toMatchObject({ result: { error: 'session_preempted' } });
    expect(await attached).toEqual(await executing);
    expect(await post(body)).toEqual(await executing);
  } finally {
    clock.mockRestore();
    holdRepo = false; releaseRepo?.();
  }
});

it('expires completed replay slots after five minutes so a reused call can run again', async () => {
  const body = call('git_status', {});
  const initial = await post(body);
  writeFileSync(join(repo, 'later.txt'), 'later');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 360_000);
  try {
    const next = await post(body);
    expect(next.result.status).toContain('later.txt');
    expect(next).not.toEqual(initial);
  } finally { clock.mockRestore(); }
});
