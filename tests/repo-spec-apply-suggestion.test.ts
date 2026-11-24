import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import * as repoSpecRoute from '@/app/api/repo-spec/route';
import { extractRoughdraftReviewIndex } from '@/lib/o8md/rfm';

const tempRepos: string[] = [];

function tempRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'o8-repo-spec-apply-'));
  tempRepos.push(repoPath);
  return repoPath;
}

function actionRequest(repoPath: string, action: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(
    `http://localhost:3001/api/repo-spec?action=${encodeURIComponent(action)}&repoPath=${encodeURIComponent(repoPath)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
}

describe('repo-spec note settlement', () => {
  afterEach(() => {
    while (tempRepos.length > 0) {
      const repoPath = tempRepos.pop();
      if (repoPath) rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('accepts an existing suggestion through the route and writes the edit at its anchor', async () => {
    const repoPath = tempRepo();
    const specPath = join(repoPath, 'o8.md');
    const content = '# Plan\n{~~Ship the old workflow.~>Ship the focused workflow.~~}{id="s1" by="AI"}\n';
    writeFileSync(specPath, content, 'utf-8');
    expect(extractRoughdraftReviewIndex(content).items.find((item) => item.kind === 'suggestion')?.id).toBe('s1');

    const response = await repoSpecRoute.POST(actionRequest(repoPath, 'apply-suggestion', { targetId: 's1', content }));

    expect(response.status).toBe(200);
    expect(readFileSync(specPath, 'utf-8')).toBe('# Plan\nShip the focused workflow.\n');
    expect(extractRoughdraftReviewIndex(readFileSync(specPath, 'utf-8')).summary.suggestions).toBe(0);
  });

  it('adds an operator comment for the classic shell voice tool', async () => {
    const repoPath = tempRepo();
    writeFileSync(join(repoPath, 'o8.md'), '# Plan\n', 'utf-8');
    const response = await repoSpecRoute.POST(actionRequest(repoPath, 'comment', { body: 'Check the plan.', author: 'Voice' }));
    expect(response.status).toBe(200);
    const index = extractRoughdraftReviewIndex(readFileSync(join(repoPath, 'o8.md'), 'utf-8'));
    expect(index.items.find((item) => item.kind === 'comment')?.text).toContain('Check the plan.');
  });

  it.each(['review', 'prewarm-review', 'scoped-reply', 'suggest'])('refuses the removed %s action', async (action) => {
    const repoPath = tempRepo();
    writeFileSync(join(repoPath, 'o8.md'), '# Plan\n', 'utf-8');
    const response = await repoSpecRoute.POST(actionRequest(repoPath, action, {}));
    expect(response.status).toBe(400);
    expect(readFileSync(join(repoPath, 'o8.md'), 'utf-8')).toBe('# Plan\n');
  });
});
