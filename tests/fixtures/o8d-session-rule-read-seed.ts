import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSqlite } from '../../src/lib/db';
import { mintPacketWorkerToken } from '../../src/lib/auth/packet-worker-token';
import { createEmptyOrchestratorMissionState } from '../../src/lib/orchestrator/store';
import { writeOrchestratorControlPlaneState } from '../../src/lib/orchestrator/control-plane';
const root = process.env.CORTEX_IDE_DATA_DIR!;
if (readFileSync(join(root, 'fixture-owner'), 'utf8') !== 'o8d-native-read/v1') throw Error('Isolated fixture required');
const db = getSqlite();
for (const [id, thread, active, constraint] of [
  ['fixture-rule-first', 'thoughts-review', 1, 'no_merge'],
  ['fixture-rule-second', 'thoughts-review', 1, null],
  ['fixture-rule-inactive', 'thoughts-review', 0, null],
  ['fixture-rule-other', 'thoughts-other', 1, null],
] as const) db.prepare('INSERT INTO session_rules (id, thread_id, text, active, created_at, constraint_kind) VALUES (?,?,?,?,?,?)').run(id, thread, id, active, '2026-01-01 12:00:00', constraint);
writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'fixture-session-rules', repoPath: join(root, 'fixture-repo'), packets: [{ id: 'fixture-rule-worker', orchestratorThreadId: 'thoughts-review', status: 'running' } as never] });
writeFileSync(join(root, 'session-rule-worker-token'), mintPacketWorkerToken('fixture-rule-worker'), { mode: 0o600 });
