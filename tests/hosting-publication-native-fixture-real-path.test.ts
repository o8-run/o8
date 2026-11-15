import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getDataDir } from '@/lib/data-dir-migration';
import { prepare, default as register } from '../scripts/next/surfaces/55-pull-requests.surface';

it('the native transport fixture supports the real shared publication route', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'o8-native-publication-'));
  execFileSync('git', ['init', '-q', repo]);
  vi.stubEnv('O8_DATA_DIR', getDataDir());
  process.argv.push('--pull-requests');
  const cleanup = await prepare({ dataDir: getDataDir(), repo } as Parameters<typeof prepare>[0]);
  try {
    const routes = await register();
    const get = routes.match!('GET', '/api/panel/prs/7')!;
    const post = routes.match!('POST', '/api/panel/prs/7')!;
    const read = await get(new NextRequest('http://localhost/api/panel/prs/7?repo=example/repo'));
    const detail = await read.json();
    expect(read.status, JSON.stringify(detail)).toBe(200);
    for (const action of ['enable-auto-merge', 'disable-auto-merge']) {
      const result = await post(new NextRequest('http://localhost/api/panel/prs/7', { method: 'POST', body: JSON.stringify({ repo: 'example/repo', action, mergeMethod: 'squash', commitSha: detail.pr.headSha }) }));
      expect(result.status, await result.text()).toBe(200);
    }
    const response = await post(new NextRequest('http://localhost/api/panel/prs/7', { method: 'POST', body: JSON.stringify({ repo: 'example/repo', action: 'merge', mergeMethod: 'squash', commitSha: detail.pr.headSha, expectedMergeGate: (await (await get(new NextRequest('http://localhost/api/panel/prs/7?repo=example/repo'))).json()).pr.mergeGate.snapshot }) }));
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result).toMatchObject({ publication: { status: 'merged' } });
    const control = routes.routes!['POST /__fixture/pr-gates'];
    await control(new NextRequest('http://localhost/__fixture/pr-gates', { method: 'POST', body: JSON.stringify({ scenario: 'merge-request-unconfirmed' }) }));
    const post10 = routes.match!('POST', '/api/panel/prs/10')!;
    const request10 = (action: string) => new NextRequest('http://localhost/api/panel/prs/10', { method: 'POST', body: JSON.stringify({ repo: 'example/repo', action, mergeMethod: 'squash', commitSha: 'a'.repeat(40) }) });
    expect((await post10(request10('merge'))).status).toBe(202);
    expect((await post10(request10('disable-auto-merge'))).status).toBe(200);
    expect((await post10(request10('merge'))).status).toBe(202);
    await control(new NextRequest('http://localhost/__fixture/pr-gates', { method: 'POST', body: JSON.stringify({ scenario: 'confirm-lost-merge' }) }));
    const reconciled = await post10(request10('merge'));
    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toMatchObject({ publication: { status: 'merged', approvedSha: 'a'.repeat(40), mergedSha: 'c'.repeat(40) } });
    const status = await routes.routes!['GET /api/panel/status'](new NextRequest('http://localhost/api/panel/status'));
    const writes = (await status.json()).providerWrites as Array<{ path: string; publication: boolean }>;
    expect(writes.filter(w => w.publication && w.path === '/repos/example/repo/pulls/10/merge')).toHaveLength(1);
  } finally {
    cleanup.close?.(); process.argv.pop(); vi.unstubAllEnvs(); rmSync(repo, { recursive: true, force: true });
  }
});
