import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { listBots, sanitizeBot, type BotProvider } from './registry';
import { grokDeepLink, listGrokBots } from './grok';
import { mailboxPath, readMailbox } from './mailbox';

const AGENT = 'bf4d168a-f3a4-4625-9603-d43837e19abd';
let root: string;
let agents: string;
let data: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'o8-bots-'));
  agents = join(root, 'agents');
  data = join(root, 'data');
  mkdirSync(join(agents, AGENT), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(agents, AGENT, 'profile.json'), JSON.stringify({ name: 'cash', description: 'private' }));
  mkdirSync(join(agents, 'not-an-agent'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('grok provider lists local agents by profile name with a mailbox thread and deep link', () => {
  const [bot, ...rest] = listGrokBots(agents, data);
  expect(rest).toEqual([]);
  expect(bot).toEqual({
    id: `grok:${AGENT}`,
    house: 'grok',
    name: 'cash',
    icon: { key: 'grok' },
    mainThread: { kind: 'mailbox', id: AGENT, url: grokDeepLink(AGENT) },
    status: 'unknown',
  });
  expect(JSON.stringify(bot)).not.toContain('private');
});

it('grok status follows mailbox freshness', () => {
  const path = mailboxPath('grok', AGENT, data)!;
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
  expect(listGrokBots(agents, data)[0].status).toBe('online');
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(path, old, old);
  expect(listGrokBots(agents, data)[0].status).toBe('offline');
});

it('missing agent root yields no bots', () => {
  expect(listGrokBots(join(root, 'nope'), data)).toEqual([]);
});

it('listBots keeps provider order, appends static entries and drops duplicates or invalid ones', () => {
  const grok: BotProvider = { house: 'grok', list: () => listGrokBots(agents, data) };
  const broken: BotProvider = { house: 'x', list: () => { throw new Error('boom'); } };
  writeFileSync(join(data, 'bots.json'), JSON.stringify({ bots: [
    { id: 'codex:main', house: 'Codex', name: 'Codex bot', icon: { key: 'codex' }, mainThread: { kind: 'o8-thread', id: 't1' }, status: 'online' },
    { id: `grok:${AGENT}`, house: 'grok', name: 'dup' },
    { id: 'bad id!', house: 'claude' },
  ] }));
  const bots = listBots([grok, broken], data);
  expect(bots.map((b) => [b.id, b.house, b.name])).toEqual([
    [`grok:${AGENT}`, 'grok', 'cash'],
    ['codex:main', 'codex', 'Codex bot'],
  ]);
});

it('sanitizeBot rejects unknown thread kinds and status', () => {
  expect(sanitizeBot({ id: 'a', house: 'h', mainThread: { kind: 'socket' }, status: 'busy' }))
    .toMatchObject({ mainThread: null, status: 'unknown', name: 'a' });
});

it('mailbox reads valid lines, skips torn ones and refuses unsafe paths', async () => {
  expect(mailboxPath('grok', '../etc', data)).toBeNull();
  const path = mailboxPath('grok', AGENT, data)!;
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, [
    JSON.stringify({ id: 'm1', role: 'user', text: 'hi', at: '2026-10-31T22:00:00Z' }),
    '{"torn',
    JSON.stringify({ role: 'bot', text: 'hello' }),
    JSON.stringify({ role: 'tool', text: 'x' }),
  ].join('\n'));
  expect(await readMailbox(path)).toEqual([
    { id: 'm1', role: 'user', text: 'hi', at: '2026-10-31T22:00:00Z' },
    { id: expect.stringMatching(/^byte-\d+$/), role: 'bot', text: 'hello', at: null },
  ]);
});
