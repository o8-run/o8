import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { root } from '../speed/common.mjs';

export function seedWorkerSessions({ count, transcriptMiB, ownedRoot, repo, env }) {
  const files = [];
  for (let index = 0; index < count; index++) {
    const id = `memory-worker-${index}`;
    const sessionKey = `codex-owned:${id}`;
    const sessionDir = path.join(ownedRoot, id);
    const runsDir = path.join(sessionDir, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const stdoutPath = path.join(runsDir, 'stdout.jsonl');
    const stderrPath = path.join(runsDir, 'stderr.log');
    const fd = fs.openSync(stdoutPath, 'w', 0o600);
    try {
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/bench/session-memory-worker.mjs'),
        String(index), String(transcriptMiB)], { env, stdio: ['ignore', fd, 'pipe'], timeout: 30_000 });
      assert.equal(result.status, 0, 'Offline worker must finish successfully');
    } finally { fs.closeSync(fd); }
    fs.writeFileSync(stderrPath, '');
    const at = new Date().toISOString();
    const run = { id, mode: 'launch', prompt: 'Memory fixture output', startedAt: at, finishedAt: at,
      pid: 0, stdoutPath, stderrPath, outcome: 'finished' };
    fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({ surfaceId: sessionKey,
      sessionDir, cwd: repo, repoPath: repo, title: `Memory worker ${index}`, createdAt: at,
      updatedAt: at, latestPrompt: run.prompt, latestSummary: 'finished', activeRun: null, recentRuns: [run] }));
    files.push({ sessionKey, file: stdoutPath,
      archivedFile: path.join(`${ownedRoot}-archive`, id, 'runs', 'stdout.jsonl') });
  }
  return files;
}
