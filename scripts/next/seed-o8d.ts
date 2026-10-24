/** Owned persisted fixture only. Exits before o8d starts; opens no listener. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
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
  if (process.argv.includes('--review')) {
    await (await import('./review-fixture')).seedReviewFixture(repo);
    // This is a transport cohort; the diff suite owns the large-file stress case.
    execFileSync('git', ['-C', repo, 'restore', '--source=main', '--staged', '--worktree', '--', 'removed.json', 'old name.md']);
    execFileSync('git', ['-C', repo, 'rm', '--quiet', 'large.ts', 'medium.ts', 'new name.md', 'added.ts']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'fix: bound native HTTP review fixture']);
    const { seedTranscriptFixtures, isolateTranscriptDiscovery } = await import('./transcript-fixtures');
    for (const extra of seedTranscriptFixtures(directory, repo)) unlinkSync(join(directory, 'chat-history', `${extra.id}.json`));
    await isolateTranscriptDiscovery(true);
    const { findLaneBySession, setLaneStatus } = await import('../../src/lib/lane/registry');
    const completedWorker = findLaneBySession('opencode-owned:next-worker');
    if (!completedWorker) throw new Error('Owned worker lane missing');
    setLaneStatus(completedWorker.id, 'awaiting_orchestrator', 'system', 'review_requested');
    const { repairFlippedOrchestratorTranscripts, repairComposerPreamblePollution } = await import('../../src/lib/mobile/orchestrator-thread-history');
    repairFlippedOrchestratorTranscripts();
    repairComposerPreamblePollution();
    const { getRuntimeInventorySnapshot } = await import('../../src/lib/runtime/inventory');
    await getRuntimeInventorySnapshot({ fresh: true });
    const { syncOrchestratorControlPlaneState } = await import('../../src/lib/orchestrator/control-plane');
    await syncOrchestratorControlPlaneState();
  }
  closeDb();
}
void main().then(() => process.exit(0)).catch(() => { console.error('Owned o8d fixture seeding failed'); process.exit(1); });
