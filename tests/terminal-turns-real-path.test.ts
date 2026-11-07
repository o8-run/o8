import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Turns typed in Terminal View reach the chat through the real routes, from
// the CLIs' real session-file formats, once, and on the chat's own session.
const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'o8-terminal-turns-')));
const repo = path.join(root, 'repo');
const claudeHome = path.join(root, 'claude');
const codexHome = path.join(root, 'codex');
mkdirSync(repo);
mkdirSync(path.join(claudeHome, 'projects', '-fixture-repo'), { recursive: true });
mkdirSync(path.join(codexHome, 'sessions', '2026', '11', '06'), { recursive: true });
vi.stubEnv('O8_DATA_DIR', path.join(root, 'data'));
vi.stubEnv('CLAUDE_HOME', claudeHome);
vi.stubEnv('CODEX_HOME', codexHome);

const claudeSession = '33333333-3333-4333-8333-333333333333';
const codexSession = '0199aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const claudeFile = path.join(claudeHome, 'projects', '-fixture-repo', `${claudeSession}.jsonl`);
const codexFile = path.join(codexHome, 'sessions', '2026', '11', '06', `rollout-2026-11-06T10-00-00-${codexSession}.jsonl`);
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const sql = (value: string) => `'${value.replaceAll("'", "''")}'`;
execFileSync('sqlite3', [path.join(codexHome, 'state_5.sqlite'), `
  CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, rollout_path TEXT,
    git_branch TEXT, git_sha TEXT, git_origin_url TEXT, first_user_message TEXT, model TEXT, archived INTEGER);
  INSERT INTO threads VALUES (${sql(codexSession)}, 'Fixture', ${sql(repo)}, 1, ${sql(codexFile)}, '', '', '', 'Start', '', 0);
`]);

const history = await import('@/app/api/v2/chat-history/route');
const turns = await import('@/app/api/v2/chat-history/terminal-turns/route');
const { TERMINAL_IMPORT_MAX_MESSAGES } = await import('@/lib/runtime/terminal-turns');

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
});
async function save(tabId: string, backend: string, ids: Record<string, string>, messages: unknown[]) {
  const response = await history.POST(post('/api/v2/chat-history', {
    tabId, messages, repoPath: repo, backend, orchestratorSessionIds: ids }));
  expect(response.status).toBe(200);
}
async function act(tabId: string, action: string) {
  const response = await turns.POST(post('/api/v2/chat-history/terminal-turns', { tabId, action }));
  return { status: response.status, body: await response.json() };
}
async function read(tabId: string) {
  const response = await history.GET(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${tabId}`));
  return response.json() as Promise<{ messages: Array<{ id: string; role: string; content: string }>; orchestratorSessionIds: Record<string, string> }>;
}

describe('Terminal View turns copied into the chat (#5309)', () => {
  it('imports a Claude Code terminal turn once, after the mark, on the same session', async () => {
    const tabId = 'thoughts-terminal-claude';
    writeFileSync(claudeFile, line({ type: 'user', uuid: 'u0', message: { role: 'user', content: 'Turn o8 ran from chat' } }));
    await save(tabId, 'claude', { claude: claudeSession }, [{ id: 'user-1', role: 'user', content: 'Turn o8 ran from chat', timestamp: 1 }]);
    expect((await act(tabId, 'mark')).body).toEqual({ marked: true, turns: 0 });

    appendFileSync(claudeFile, [
      line({ type: 'user', uuid: 'u1', timestamp: '2026-11-06T10:00:00Z', message: { role: 'user', content: 'Typed in the terminal' } }),
      line({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'First part.' }] } }),
      line({ type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }),
      line({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }),
      line({ type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: [{ type: 'text', text: 'Second part.' }] } }),
      line({ type: 'user', uuid: 'u3', isMeta: true, message: { role: 'user', content: 'meta' } }),
    ].join(''));
    expect((await act(tabId, 'import')).body).toEqual({ turns: 1, more: false });
    const after = await read(tabId);
    expect(after.messages.map(m => [m.role, m.content])).toEqual([
      ['user', 'Turn o8 ran from chat'], ['user', 'Typed in the terminal'], ['assistant', 'First part.\n\nSecond part.'],
    ]);
    expect(after.messages.slice(1).every(m => m.id.startsWith('cli-claude-'))).toBe(true);
    expect(after.orchestratorSessionIds).toEqual({ claude: claudeSession });
    // Importing again adds nothing.
    expect((await act(tabId, 'import')).body).toEqual({ turns: 0, more: false });
    expect((await read(tabId)).messages).toHaveLength(3);
  });

  it('imports a Codex terminal turn from its rollout and skips turns o8 ran between visits', async () => {
    const tabId = 'thoughts-terminal-codex';
    writeFileSync(codexFile, line({ type: 'session_meta', payload: { id: codexSession } }));
    await save(tabId, 'codex', { codex: codexSession }, [{ id: 'user-1', role: 'user', content: 'Start', timestamp: 1 }]);
    expect((await act(tabId, 'mark')).body).toEqual({ marked: true, turns: 0 });
    appendFileSync(codexFile, [
      line({ type: 'event_msg', timestamp: '2026-11-06T10:01:00Z', payload: { type: 'user_message', message: 'From the terminal' } }),
      line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'dup' }] } }),
      line({ type: 'event_msg', payload: { type: 'agent_message', message: 'Terminal reply' } }),
    ].join(''));
    expect((await act(tabId, 'import')).body).toEqual({ turns: 1, more: false });
    // o8 runs a chat turn on the same session; the next visit's mark skips it.
    appendFileSync(codexFile, line({ type: 'event_msg', payload: { type: 'user_message', message: 'Sent from chat' } }));
    await act(tabId, 'mark');
    appendFileSync(codexFile, line({ type: 'event_msg', payload: { type: 'user_message', message: 'Second terminal turn' } }));
    expect((await act(tabId, 'import')).body).toEqual({ turns: 1, more: false });
    const after = await read(tabId);
    expect(after.messages.map(m => m.content)).toEqual(['Start', 'From the terminal', 'Terminal reply', 'Second terminal turn']);
    expect(after.orchestratorSessionIds).toEqual({ codex: codexSession });
  });

  it('imports a visit that never closed (the app quit) before the next mark', async () => {
    const tabId = 'thoughts-terminal-claude';
    await act(tabId, 'mark');
    appendFileSync(claudeFile, line({ type: 'user', uuid: 'u9', message: { role: 'user', content: 'Typed before quitting' } }));
    // No import: the next open catches up first, then marks.
    expect((await act(tabId, 'mark')).body).toEqual({ marked: true, turns: 1 });
    expect((await read(tabId)).messages.at(-1)?.content).toBe('Typed before quitting');
    expect((await act(tabId, 'import')).body).toEqual({ turns: 0, more: false });
  });

  it('caps one import and continues from where it stopped', async () => {
    const tabId = 'thoughts-terminal-cap';
    writeFileSync(codexFile, '');
    await save(tabId, 'codex', { codex: codexSession }, [{ id: 'user-1', role: 'user', content: 'Start', timestamp: 1 }]);
    await act(tabId, 'mark');
    const total = TERMINAL_IMPORT_MAX_MESSAGES + 5;
    appendFileSync(codexFile, Array.from({ length: total }, (_, i) =>
      line({ type: 'event_msg', payload: { type: 'user_message', message: `turn ${i}` } })).join(''));
    expect((await act(tabId, 'import')).body).toEqual({ turns: TERMINAL_IMPORT_MAX_MESSAGES, more: true });
    expect((await act(tabId, 'import')).body).toEqual({ turns: 5, more: false });
    expect((await read(tabId)).messages).toHaveLength(total + 1);
  });

  it('refuses unknown chats and actions', async () => {
    expect((await act('thoughts-missing', 'import')).status).toBe(404);
    expect((await act('thoughts-terminal-codex', 'erase')).status).toBe(400);
    expect((await act('../escape', 'mark')).status).toBe(400);
  });
});
