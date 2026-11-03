/** Owned persisted fixture only. Exits before o8d starts; opens no listener. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

async function main() {
  const directory = realpathSync(process.argv[2]);
  if (readFileSync(join(directory, 'fixture-owner'), 'utf8') !== 'o8d-native-read/v1') {
    throw new Error('Refusing to seed an unowned directory');
  }
  const credential = process.env.O8_NEXT_API_TOKEN;
  if (!credential) throw new Error('Fixture credential required');
  Object.assign(process.env, { O8_DATA_DIR: directory, CORTEX_IDE_DATA_DIR: directory,
    CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'), NODE_ENV: 'test' });
  for (const key of ['WS_TOKEN', 'O8_WORKER_TOKEN', 'O8_API_TOKEN', 'O8_SPECTATOR_TOKEN', 'O8_PACKAGED_APP']) delete process.env[key];
  writeFileSync(join(directory, 'ws-token'), credential, { mode: 0o600 });
  const repo = join(directory, 'fixture-repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  const { getSqlite, closeDb } = await import('../../src/lib/db');
  getSqlite();
  const { normalizeOrchestratorMissionState } = await import('../../src/lib/orchestrator/store');
  writeFileSync(join(directory, 'orchestrator-state.json'), JSON.stringify({ version: 1,
    mission: normalizeOrchestratorMissionState({ missionId: 'fixture-mission', packets: [] }) }));
  mkdirSync(join(directory, 'chat-history'));
  const seeds = JSON.parse(readFileSync(resolve('native/o8-next/fixtures/sessions.json'), 'utf8')) as Array<Record<string, unknown>>;
  for (const seed of seeds) writeFileSync(join(directory, 'chat-history', `${seed.id}.json`), JSON.stringify({
    ...seed, repoPath: repo, repoName: 'fixture-repo', backend: 'claude', model: 'claude-code',
    savedAt: '2026-10-01T00:00:00.000Z', orchestratorVisible: true,
  }));
  const { enqueueComposerSend, holdComposerSends } = await import('../../src/lib/orchestrator/composer-queue');
  enqueueComposerSend({ repoPath: repo, threadId: 'thoughts-review', id: 'fixture-queue-item', intent: 'send-next', payload: {
    text: 'Fixture queued message', wireMessage: 'Fixture queued message', images: [],
    routing: { backend: 'claude', model: 'claude-code', effort: 'medium', permissionMode: 'full', mode: 'single', pickedMode: 'solo', collide: false },
  } });
  holdComposerSends({ repoPath: repo, threadId: 'thoughts-review' });
  // Fixed fixture times make the corpus reproducible without masking persisted fields.
  getSqlite().prepare('UPDATE composer_send_queue SET created_at = ?, updated_at = ?').run(1790812800000, 1790812800000);
  const { inboxSubject, mutateInboxPreferences, recordInboxConversationEvent } = await import('../../src/lib/inbox/store');
  mutateInboxPreferences(inboxSubject('conversation', 'thoughts-review', repo), { action: 'pin' }, () => {});
  recordInboxConversationEvent({ event: 'status', data: { threadId: 'thoughts-review', repoPath: repo, status: 'busy' } });
  getSqlite().prepare("UPDATE app_state SET value = json_set(value, '$.pinnedAt', ?, '$.runAt', ?, '$.runStartedAt', ?) WHERE key LIKE 'inbox:subject:%'")
    .run('2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
  closeDb();
}
void main().catch(() => { console.error('Owned o8d fixture seeding failed'); process.exitCode = 1; });
