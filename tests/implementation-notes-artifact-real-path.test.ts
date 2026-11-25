import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-notes-real-path-data-'));
const tempDirs: string[] = [];
const WS_TOKEN = 'operator-notes-real-path-token';
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
writeFileSync(join(dataDir, 'ws-token'), `${WS_TOKEN}\n`, 'utf8');

const mergePreviewRoute = await import('@/app/api/orchestrator/merge-preview/route');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function operatorGet(url: string): NextRequest {
  return new NextRequest(url, {
    method: 'GET',
    headers: { host: 'localhost:3001', authorization: `Bearer ${WS_TOKEN}` },
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('implementation notes artifact real path', () => {
  it('merge preview ignores an oversized deletion of the retired root worker-notes file', async () => {
    const packetId = `pkt-worker-notes-${Date.now()}`;
    const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-worker-notes-repo-'));
    tempDirs.push(repoPath);
    git(repoPath, ['init', '-q', '-b', 'main']);
    git(repoPath, ['config', 'user.email', 'test@o8.dev']);
    git(repoPath, ['config', 'user.name', 'o8 test']);
    writeFileSync(
      join(repoPath, 'implementation-notes.md'),
      `${Array.from({ length: 80 }, (_, index) => `worker plan line ${index}`).join('\n')}\n`,
    );
    git(repoPath, ['add', 'implementation-notes.md']);
    git(repoPath, ['commit', '-q', '-m', 'base']);
    git(repoPath, ['checkout', '-q', '-b', 'inline/worker-notes']);
    rmSync(join(repoPath, 'implementation-notes.md'));
    git(repoPath, ['add', '-A']);
    git(repoPath, ['commit', '-q', '-m', 'remove worker scratch']);

    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'inline/worker-notes',
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      sessionKey: `codex-owned:${packetId}`,
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_ready');

    const response = await mergePreviewRoute.GET(operatorGet(
      `http://localhost:3001/api/orchestrator/merge-preview?packetId=${packetId}`,
    ));
    expect(response.status).toBe(200);
    const preview = await response.json();

    // Merging itself is held by PR-first policy and the durable-review gate; this case covers the budget.
    expect(preview.blockers).not.toContain('diff-budget');
    expect(preview.checks.find((check: { name: string }) => check.name === 'diff-budget')?.verdict).toBe('pass');
  });
});
