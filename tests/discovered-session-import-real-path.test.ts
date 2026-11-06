import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, expect, it } from 'vitest';

const headers = { authorization: 'Bearer fixture-discovered-import', 'content-type': 'application/json' };
const codex = 'codex:11111111-1111-4111-8111-111111111111';
const otherCodex = 'codex:22222222-2222-4222-8222-222222222222';
const claude = 'claude-code:33333333-3333-4333-8333-333333333333';
let host: ChildProcess;
let origin: string;
let dataDir: string;
let repo: string;

beforeAll(async () => {
  host = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/dev-server.ts', '--discovered-import', '--inbox-empty', '--owned-stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, O8_NEXT_API_TOKEN: 'fixture-discovered-import' },
  });
  let errors = '';
  host.stderr!.on('data', chunk => { errors += String(chunk); });
  const lines = createInterface({ input: host.stdout! });
  await new Promise<void>((resolve, reject) => {
    host.once('error', reject);
    host.once('exit', () => reject(new Error(`Fixture exited before readiness: ${errors.slice(-2000)}`)));
    lines.on('line', line => {
      try {
        const receipt = JSON.parse(line);
        if (!receipt.origin) return;
        origin = receipt.origin; dataDir = receipt.importDataDir; repo = receipt.importRepo;
        lines.close(); resolve();
      } catch { /* other fixture output */ }
    });
  });
}, 60_000);
afterAll(async () => {
  if (host?.exitCode === null && host.signalCode === null) {
    const closed = once(host, 'close'); host.kill('SIGTERM'); await closed;
  }
});

/** Scoped to the fixture repo by default; null lists every workspace. */
async function list(workspace: string | null = repo) {
  const scope = workspace === null ? '' : `?workspace=${encodeURIComponent(workspace)}`;
  const response = await fetch(`${origin}/api/runtime/discovered-sessions${scope}`, { headers });
  expect(response.status).toBe(200);
  return response.json();
}
function histories() {
  return readdirSync(join(dataDir, 'chat-history')).filter(file => file.endsWith('.json'))
    .map(file => ({ tabId: file.slice(0, -5), ...JSON.parse(readFileSync(join(dataDir, 'chat-history', file), 'utf8')) }));
}
function importSessions(sessionKeys: unknown) {
  return fetch(`${origin}/api/runtime/discovered-sessions/import`, {
    method: 'POST', headers, body: JSON.stringify({ sessionKeys }),
  });
}

it('lists three real sessions, refuses an unknown selection atomically, imports two and reuses them on rerun', async () => {
  const pending = await list();
  expect(pending.sessions.map((row: { sessionKey: string }) => row.sessionKey).sort()).toEqual([codex, otherCodex, claude].sort());
  expect(pending.projects).toEqual([{ repoPath: repo, repoName: 'fixture-repo', sessionKeys: expect.arrayContaining([codex, otherCodex, claude]) }]);
  expect(histories()).toEqual([]);
  const everything = await list(null);
  expect(everything.sessions.filter((row: { sessionKey: string }) => row.sessionKey.startsWith('codex:bulk-'))).toHaveLength(2048);
  expect(everything.projects.map((project: { repoPath: string }) => project.repoPath).sort()).toEqual([join(dataDir, 'bulk-repo'), repo].sort());
  const unknown = await importSessions([codex, 'codex:unknown']);
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toMatchObject({ error: { code: 'unknown_discovered_session' } });
  expect(histories()).toEqual([]);
  // Bulk rows have no rollout file: every one is named, and nothing is written.
  const stale = await importSessions([codex, 'codex:bulk-0000', 'codex:bulk-0001']);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: 'session_not_resumable', sessionKey: 'codex:bulk-0000',
    sessionKeys: ['codex:bulk-0000', 'codex:bulk-0001'] } });
  expect(histories()).toEqual([]);

  const responses = await Promise.all([importSessions([codex, claude, codex]), importSessions([codex, claude])]);
  expect(responses.map(response => response.status)).toEqual([200, 200]);
  const results = await Promise.all(responses.map(response => response.json()));
  expect(results.map(result => result.created.length).sort()).toEqual([0, 2]);
  const imported = results.find(result => result.created.length === 2);
  expect(imported.created).toHaveLength(2);
  expect(imported.existing).toEqual([]);
  const saved = histories();
  expect(saved).toHaveLength(2);
  for (const [sessionKey, backend] of [[codex, 'codex'], [claude, 'claude']]) {
    const result = imported.created.find((row: { sessionKey: string }) => row.sessionKey === sessionKey);
    expect(result.tabId).toMatch(/^thoughts-/);
    const history = await (await fetch(`${origin}/api/v2/chat-history?tabId=${result.tabId}`, { headers })).json();
    expect(history).toMatchObject({ repoPath: repo, backend, messages: [], orchestratorVisible: true,
      orchestratorSessionIds: { [backend]: sessionKey.split(':')[1] } });
  }
  const visible = await (await fetch(`${origin}/api/v2/chat-history/list?include=orchestrator`, { headers })).json();
  expect(visible.conversations.map((chat: { tabId: string }) => chat.tabId).sort()).toEqual(imported.created.map((row: { tabId: string }) => row.tabId).sort());
  expect((await list()).sessions.map((row: { sessionKey: string }) => row.sessionKey)).toEqual([otherCodex]);
  const rerun = await (await importSessions([codex, claude])).json();
  expect(rerun.created).toEqual([]);
  expect(rerun.existing).toEqual(imported.created);
  expect(histories()).toEqual(saved);
});

it.each([{ selection: null }, { selection: 'all' }, { selection: [123] }, { selection: [''] }, { selection: {} }])('refuses malformed selection $selection without writing', async ({ selection }) => {
  const saved = histories();
  expect((await importSessions(selection)).status).toBe(400);
  expect(histories()).toEqual(saved);
});

it('keeps the import identity after the chat changes provider session on continuation', async () => {
  const tabId = histories().find(history => history.orchestratorSessionIds?.codex === codex.split(':')[1]).tabId;
  const response = await fetch(`${origin}/api/v2/chat-history`, { method: 'POST', headers, body: JSON.stringify({
    tabId, messages: [{ role: 'user', content: 'A later turn', timestamp: Date.now() }],
    orchestratorSessionIds: { codex: 'replacement-session' },
  }) });
  expect(response.status).toBe(200);
  const saved = histories();
  expect(await (await importSessions([codex])).json()).toEqual({ created: [], existing: [{ sessionKey: codex, tabId }] });
  expect((await list()).sessions.map((row: { sessionKey: string }) => row.sessionKey)).toEqual([otherCodex]);
  expect(histories()).toEqual(saved);
});

it('recognizes a chat made through the existing single-row save path', async () => {
  const response = await fetch(`${origin}/api/v2/chat-history`, { method: 'POST', headers, body: JSON.stringify({
    tabId: 'thoughts-single-continue', messages: [], repoPath: repo, backend: 'codex',
    title: 'Single row title', orchestratorSessionIds: { codex: otherCodex.split(':')[1] },
  }) });
  expect(response.status).toBe(200);
  const saved = histories();
  const results = await Promise.all([importSessions([otherCodex]), importSessions([otherCodex])]);
  for (const result of results) {
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ created: [], existing: [{ sessionKey: otherCodex, tabId: 'thoughts-single-continue' }] });
  }
  expect((await list()).sessions).toEqual([]);
  expect((await list()).projects).toEqual([]);
  expect(histories()).toEqual(saved);
});
