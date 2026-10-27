import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const runFile = promisify(execFile);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each([0, 300_001])('warms configured update routes and measures the publication budget with prior lag=%s', async lag => {
  const root = mkdtempSync(join(tmpdir(), 'o8-update-publication-'));
  roots.push(root);
  const state = join(root, 'manifest.json');
  writeFileSync(state, JSON.stringify({ version: '0.0.1' }));
  const visits: string[] = [];
  const cacheControls: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    visits.push(request.url!);
    cacheControls.push(request.headers['cache-control']);
    response.setHeader('Content-Type', 'application/json');
    response.end(readFileSync(state));
    // Publication happens between requests, after one endpoint answered current.
    if (visits.length === 1) writeFileSync(state, JSON.stringify({ version: '0.0.2' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  const base = `http://127.0.0.1:${address.port}`;
  mkdirSync(join(root, 'src-tauri'));
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ plugins: { updater: { endpoints: [
    `${base}/primary/{{target}}/{{arch}}/{{current_version}}`, `${base}/fallback/latest.json`,
  ] } } }));
  const receipt = join(root, 'publication.json');
  try {
    await runFile(process.execPath, [join(process.cwd(), 'scripts/warm-release-updates.mjs'),
      '--version', '0.0.2', '--previous-version', '0.0.1', '--published-at', new Date(Date.now() - lag).toISOString(),
      '--receipt', receipt, '--retry-ms', '10', '--timeout-ms', '2000'], { cwd: root });
    const recorded = JSON.parse(readFileSync(receipt, 'utf8'));
    expect(recorded).toMatchObject({ schema: 'o8/update-publication-receipt/v1', version: '0.0.2',
      previousVersion: '0.0.1', status: 'offered', withinPublishToOfferBudget: lag === 0, publishToOfferBudgetMs: 300_000 });
    expect(recorded.checks).toHaveLength(4);
    expect(recorded.checks.every((check: { version: string; status: number }) => check.version === '0.0.2' && check.status === 200)).toBe(true);
    if (lag === 0) expect(recorded.publishToOfferMs).toBeLessThan(5 * 60_000);
    else expect(recorded.publishToOfferMs).toBeGreaterThanOrEqual(lag);
    expect(visits).toContain('/primary/darwin/aarch64/0.0.1');
    expect(visits).toContain('/primary/darwin/x86_64/0.0.1');
    expect(visits).toContain('/fallback/latest.json');
    expect(visits.length).toBeGreaterThan(4);
    expect(cacheControls.every(value => value === undefined)).toBe(true);
    expect(JSON.stringify(recorded)).not.toContain(base);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it('bounds stalled refreshes and records an unverified receipt instead of claiming an offer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o8-update-publication-timeout-'));
  roots.push(root);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"version":');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  mkdirSync(join(root, 'src-tauri'));
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ plugins: { updater: {
    endpoints: [0, 1].map(index => `http://127.0.0.1:${address.port}/${index}/{{current_version}}`),
  } } }));
  const receipt = join(root, 'publication.json');
  const started = performance.now();
  try {
    await expect(runFile(process.execPath, [join(process.cwd(), 'scripts/warm-release-updates.mjs'),
      '--version', '0.0.2', '--previous-version', '0.0.1', '--published-at', new Date().toISOString(),
      '--receipt', receipt, '--retry-ms', '10', '--timeout-ms', '200'], { cwd: root })).rejects.toMatchObject({ code: 1 });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({ status: 'pending', publishToOfferMs: null, withinPublishToOfferBudget: null,
      checks: expect.arrayContaining([expect.objectContaining({ version: null, errorCode: 'request_failed' })]) });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
