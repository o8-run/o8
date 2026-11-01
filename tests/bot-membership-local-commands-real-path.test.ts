import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it } from 'vitest';
import type { BotMember } from '@/lib/agents/types';

const root = mkdtempSync(join(tmpdir(), 'o8-local-bot-membership-'));
const token = 'local-membership-command-fixture-0123456789';
for (const path of ['profiles', 'repo-one', 'repo-two']) mkdirSync(join(root, path));
writeFileSync(join(root, 'ws-token'), token);
Object.assign(process.env, { O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root,
  CORTEX_IDE_DB_PATH: join(root, 'membership.db'), O8_GROK_AGENT_DATA: join(root, 'profiles') });
const { getSqlite, closeDb } = await import('@/lib/db');
const { GET } = await import('@/app/api/bots/route');
const { GET: THREAD } = await import('@/app/api/bots/[id]/thread/route');
const { POST: PRESENCE } = await import('@/app/api/agents/presence/route');
afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });

function request(path: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function local<T = BotMember>(command: unknown): T {
  const result = spawnSync(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', 'scripts/bots-membership.ts'], {
    cwd: process.cwd(), env: { ...process.env }, input: JSON.stringify(command), encoding: 'utf8', timeout: 20_000,
  });
  expect(result.status, `${result.error ?? ''}\n${result.stderr}\n${result.stdout}`).toBe(0);
  const values = result.stdout.split('\n').flatMap(line => {
    try { return [JSON.parse(line) as T]; } catch { return []; }
  });
  expect(values, 'local command returns its persisted result').toHaveLength(1);
  return values[0];
}

it('local commands persist membership and existing session bindings into the production roster across process/DB restarts', async () => {
  for (const [agentId, name, repo, runtime, sessionKey] of [
    ['source-claude', 'OriginalClaude', join(root, 'repo-one'), 'claude-code', 'claude:session-one:full'],
    ['source-codex', 'OriginalCodex', join(root, 'repo-two'), 'codex', 'codex:session-two:full'],
  ]) {
    const joined = await PRESENCE(request('/api/agents/presence', { agentId, name, repo, runtime, sessionKey }));
    expect(joined.status).toBe(201);
  }
  expect((await (await GET(request('/api/bots'))).json()).bots).toEqual([]);
  const member = local({ action: 'create', house: 'claude', name: 'Build bot', iconKey: 'claude-code' });
  expect(member.id).toMatch(/^bot-/);
  expect(member.bindings).toEqual([]);
  local({ action: 'bind', memberId: member.id, agentId: 'source-claude' });
  const bound = local({ action: 'bind', memberId: member.id, agentId: 'source-codex' });
  expect(bound.bindings).toHaveLength(2);
  expect(bound.bindings.map(b => [b.repo, b.runtime, b.sessionKey]).sort()).toEqual([
    [join(root, 'repo-one'), 'claude-code', 'claude:session-one:full'],
    [join(root, 'repo-two'), 'codex', 'codex:session-two:full'],
  ]);
  const home = `thoughts-${'full-source-'.repeat(20)}`;
  local({ action: 'home', memberId: member.id, threadId: home });
  const renamed = local({ action: 'rename', memberId: member.id, name: 'Renamed build bot' });
  expect(renamed.id).toBe(member.id);
  expect(renamed.bindings).toEqual(bound.bindings);
  expect(local<BotMember[]>({ action: 'list' }).map(m => m.id)).toEqual([member.id]);
  const sourceRows = getSqlite().prepare('SELECT agent_id,name,session_key FROM agent_presence ORDER BY agent_id').all();
  expect(sourceRows).toEqual([
    { agent_id: 'source-claude', name: 'OriginalClaude', session_key: 'claude:session-one:full' },
    { agent_id: 'source-codex', name: 'OriginalCodex', session_key: 'codex:session-two:full' },
  ]);
  local({ action: 'source', memberId: member.id, sourceId: 'claude:configured' });
  writeFileSync(join(root, 'bots.json'), JSON.stringify({ bots: [
    { id: 'claude:configured', house: 'claude', name: 'Old adapter name' },
    { id: member.id, house: 'claude', name: 'Second adapter' },
  ] }));
  const bots = (await (await GET(request('/api/bots'))).json()).bots;
  expect(bots).toHaveLength(1);
  expect(bots[0]).toMatchObject({ id: member.id, name: 'Renamed build bot', status: 'online', mainThread: { kind: 'o8-thread', id: home } });
  const alias = await THREAD(request('/api/bots/claude%3Aconfigured/thread'), { params: Promise.resolve({ id: 'claude:configured' }) });
  expect(alias.status).toBe(200);
  expect((await alias.json()).bot.id).toBe(member.id);
  getSqlite().exec('DELETE FROM agent_presence');
  closeDb();
  const afterRestart = (await (await GET(request('/api/bots'))).json()).bots;
  expect(afterRestart).toEqual([{ ...bots[0], status: 'offline' }]);
  expect(getSqlite().prepare('SELECT id,agent_id,session_key FROM bot_member_bindings ORDER BY agent_id').all()).toEqual(
    bound.bindings.map(b => ({ id: b.id, agent_id: b.agentId, session_key: b.sessionKey })).sort((a, b) => a.agent_id.localeCompare(b.agent_id)),
  );
}, 60_000);

it('canonical and legacy source routes keep the provider mailbox context when the stored house differs', async () => {
  const member = local({ action: 'create', id: 'bot-local-mailbox', house: 'o8', name: 'Mailbox member' });
  const sourceId = 'grok:mailbox-adapter';
  local({ action: 'source', memberId: member.id, sourceId });
  writeFileSync(join(root, 'bots.json'), JSON.stringify({ bots: [
    { id: sourceId, house: 'grok', name: 'Source presentation', mainThread: { kind: 'mailbox', id: 'foreign-mailbox' } },
    { id: member.id, house: 'o8', name: 'Duplicate presentation' },
  ] }));
  const mailbox = join(root, 'bots', 'grok', 'foreign-mailbox');
  mkdirSync(mailbox, { recursive: true });
  writeFileSync(join(mailbox, 'thread.jsonl'), `${JSON.stringify({ id: 'original-source-id', role: 'bot', text: 'From the provider mailbox' })}\n`);
  for (const id of [member.id, sourceId]) {
    const response = await THREAD(request(`/api/bots/${encodeURIComponent(id)}/thread`), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.bot).toMatchObject({ id: member.id, house: 'grok', name: member.name });
    expect(body.messages).toEqual([{ id: 'original-source-id', key: 'id:original-source-id', role: 'bot', text: 'From the provider mailbox', at: null }]);
  }
  const bots = (await (await GET(request('/api/bots'))).json()).bots;
  expect(bots.filter((bot: { id: string }) => bot.id === member.id)).toHaveLength(1);
}, 30_000);
