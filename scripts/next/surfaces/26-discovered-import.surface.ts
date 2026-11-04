/** Real provider files under disposable homes; no provider executable is launched. */
import Database from 'better-sqlite3';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

let restoreDiscovery: (() => void) | undefined;

export async function prepare({ dataDir, repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--discovered-import')) return {};
  const codexHome = join(dataDir, 'codex-home');
  const claudeHome = join(dataDir, 'claude-home');
  Object.assign(process.env, {
    CODEX_HOME: codexHome, CLAUDE_HOME: claudeHome,
    CORTEX_IDE_OWNED_CODEX_ROOT: join(dataDir, 'owned-codex'),
    CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT: join(dataDir, 'owned-claude'),
  });
  const rollouts = join(codexHome, 'sessions', '2026', '11', '03');
  mkdirSync(rollouts, { recursive: true });
  const db = new Database(join(codexHome, 'state_5.sqlite'));
  try {
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT,
      updated_at INTEGER, rollout_path TEXT, git_branch TEXT, git_sha TEXT,
      git_origin_url TEXT, first_user_message TEXT, model TEXT, archived INTEGER);
      CREATE TABLE logs (thread_id TEXT, process_uuid TEXT, ts INTEGER);`);
    for (const id of ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']) {
      const rollout = join(rollouts, `rollout-${id}.jsonl`);
      writeFileSync(rollout, [
        { type: 'session_meta', payload: { id, cwd: repo } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Task ${id}` }] } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
      db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)')
        .run(id, `Task ${id}`, repo, Math.floor(Date.now() / 1000) - (id.startsWith('2') ? 172_800 : 0), rollout, 'main', '', '', `Task ${id}`, 'codex');
    }
    // More rows than one 2 MiB sqlite3 read holds: a real ~/.codex has thousands of threads.
    const filler = 'x'.repeat(512);
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)');
    for (let n = 0; n < 2048; n += 1) {
      const id = `bulk-${String(n).padStart(4, '0')}`;
      insert.run(id, filler, join(dataDir, 'bulk-repo'), 1_700_000_000 - n, join(rollouts, `rollout-${id}.jsonl`), 'main', '', '', filler, 'codex');
    }
  } finally { db.close(); }
  const project = join(claudeHome, 'projects', repo.replace(/\//g, '-'));
  mkdirSync(project, { recursive: true });
  const claudeSession = join(project, '33333333-3333-4333-8333-333333333333.jsonl');
  writeFileSync(claudeSession, JSON.stringify({
    type: 'user', uuid: 'fixture-user', sessionId: '33333333-3333-4333-8333-333333333333',
    cwd: repo, gitBranch: 'main', timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'Continue the Claude fixture task' },
  }) + '\n');
  const yesterday = new Date(Date.now() - 86_400_000);
  utimesSync(claudeSession, yesterday, yesterday);
  const { codexRuntime } = await import('../../../src/lib/runtimes/codex');
  const { claudeCodeRuntime } = await import('../../../src/lib/runtimes/claude-code');
  const codexDiscovery = codexRuntime.discoverSessions;
  const claudeDiscovery = claudeCodeRuntime.discoverSessions;
  restoreDiscovery = () => {
    codexRuntime.discoverSessions = codexDiscovery;
    claudeCodeRuntime.discoverSessions = claudeDiscovery;
  };
  return {};
}

export default async function register({ dataDir, repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--discovered-import')) return {};
  restoreDiscovery?.();
  const { GET: history, POST: save } = await import('../../../src/app/api/v2/chat-history/route');
  return {
    priority: 10,
    routes: {
      'GET /api/runtime/discovered-sessions': async request => (await import('../../../src/app/api/runtime/discovered-sessions/route')).GET(request),
      'POST /api/runtime/discovered-sessions/import': async request => (await import('../../../src/app/api/runtime/discovered-sessions/import/route')).POST(request),
      'GET /api/v2/chat-history': history,
      'POST /api/v2/chat-history': save,
    },
    admit: () => 200,
    receipt: { importDataDir: dataDir, importRepo: repo },
  };
}
