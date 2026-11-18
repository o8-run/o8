import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { firstDifference, seedSessionFixture } from '../scripts/o8d/parity';
import { startParityReference } from './fixtures/ws-parity-server';

const route = '/api/cortex/directives';
const targetDir = join(process.cwd(), 'crates/o8d/target/session-reads');
const binary = process.env.O8D_TEST_BINARY ?? join(targetDir, 'debug/o8d');
beforeAll(async () => {
  if (!process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--jobs', '1', '--target-dir', targetDir]);
}, 900_000);
async function snapshot(response: Response) {
  return { status: response.status, type: response.headers.get('content-type'), cache: response.headers.get('cache-control'), body: await response.json() };
}
// An unsupported GET frame reaches the real TS producer on the same front door.
async function classic(origin: string, token: string, path: string) {
  return new Promise<Awaited<ReturnType<typeof snapshot>>>((resolve, reject) => {
    const request = httpRequest(origin + path, { headers: { authorization: `Bearer ${token}`, 'transfer-encoding': 'chunked' } }, response => {
      expect(response.headers['x-o8d-native']).toBeUndefined();
      const chunks: Buffer[] = []; response.on('data', value => chunks.push(Buffer.from(value)));
      response.on('end', () => resolve({ status: response.statusCode!, type: response.headers['content-type'] ?? null, cache: response.headers['cache-control'] ?? null, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      response.once('error', reject);
    });
    request.once('error', reject); request.end();
  });
}
it.skipIf(process.platform !== 'linux')('owns fresh directive scans and parsing with canonical Node scope and whole-response fallbacks', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-directives-')));
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  let nonce = 0;
  const control = (flags = {}) => { writeFileSync(join(directory, 'directives-control.json'), JSON.stringify({ nonce: ++nonce, ...flags })); return nonce; };
  const counts = (id: number) => {
    try { return readFileSync(join(directory, 'directives-counters.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.nonce === id); }
    catch { return []; }
  };
  const timingCount = () => {
    const path = join(directory, 'recall-metrics.db');
    if (!existsSync(path)) return 0;
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try { return (db.prepare("SELECT count(*) AS count FROM samples WHERE label = 'recall.directives'").get() as { count: number }).count; }
    finally { db.close(); }
  };
  try {
    await seedSessionFixture(directory);
    const token = readFileSync(join(directory, 'ws-token'), 'utf8').trim(), repo = join(directory, 'fixture-repo');
    writeFileSync(join(directory, 'repos.json'), JSON.stringify({ version: 1, repos: [{ id: 'directives-repo', name: 'Fixture', localPath: repo, isGitRepo: true, defaultBranch: 'main', addedAt: '2026-01-01T00:00:00.000Z' }] }));
    await promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'tests/fixtures/o8d-directives-seed.ts'], { env: { ...process.env, O8_DATA_DIR: undefined, CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db') } });
    const { projectId } = JSON.parse(readFileSync(join(directory, 'directives-fixture.json'), 'utf8'));
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const stderr = join(directory, 'daemon-stderr'), capture = join(directory, 'capture-o8d');
    writeFileSync(capture, '#!/bin/sh\nexec ' + quote(binary) + ' "$@" 2>' + quote(stderr) + '\n', { mode: 0o700 });
    server = await startParityReference({ directory, nativeHttp: true, productFrontDoor: true, o8d: true, nativeSessionReads: 'default', binary: capture, preload: resolve('tests/fixtures/o8d-directives-preload.cjs') });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const pathFor = (query = {}) => route + '?' + new URLSearchParams(query);
    const call = (path: string, bearer = token) => fetch(origin + path, { headers: { authorization: `Bearer ${bearer}` } });
    const parity = async (path: string, native: boolean) => {
      const beforeOracle = timingCount();
      const oracleId = control(), expected = await classic(origin, token, path);
      const beforeNative = timingCount();
      const scans = counts(oracleId).some(row => row.name === 'directivesScan');
      expect(beforeNative - beforeOracle).toBe(scans ? 1 : 0);
      const id = control(), response = await call(path);
      expect(response.headers.get('x-o8d-native'), 'Native route was not reached: ' + path).toBe(native ? '1' : null);
      expect(response.headers.get('x-o8d-directives-timing')).toBeNull();
      expect(firstDifference(expected, await snapshot(response))).toBeNull();
      expect(timingCount(), 'Exactly one canonical timing sample per actual scan').toBe(beforeNative + (scans ? 1 : 0));
      if (native) {
        expect(counts(id).filter(row => ['directivesScan', 'parseDirectiveFile'].includes(row.name))).toHaveLength(0);
        expect(counts(id).filter(row => row.name === 'scopeGrant')).toHaveLength(1);
        expect(counts(id).filter(row => row.name === 'completionReceipt')).toHaveLength(scans ? 1 : 0);
        expect(timingCount(), 'Native read must preserve the canonical Node timing write').toBe(beforeNative + (scans ? 1 : 0));
      }
      return { expected, oracleCounts: counts(oracleId), nativeCounts: counts(id) };
    };
    // Missing directory returns early even for an unknown explicit project.
    expect((await parity(pathFor(), true)).expected.body).toEqual({ directives: [] });
    expect((await parity(pathFor({ projectId: 'unknown' }), true)).expected.status).toBe(200);
    const directives = join(directory, 'directives'); mkdirSync(directives);
    const write = (file: string, front: string, body = 'directive body') => writeFileSync(join(directives, file + '.md'), '---\n' + front + '\n---\n' + body + '\n');
    write('global', 'id: global\ntitle: alpha\nscope: global\npriority: 10', 'body 雪\n\n## Recent Merges\n- one\n- two\n- three\n- four');
    write('case-upper', 'title: Beta\npriority: 10'); write('case-lower', 'title: beta\npriority: 10');
    write('repo', 'title: repo only\nscope: repo\nrepoName: "fixture-repo"\npriority: 5tail');
    write('legacy', "title: legacy repo\nscope: fixture-repo\npriority: -1");
    write('project-id', 'title: project via id\nscope: project\nprojectIds: ["' + projectId.toUpperCase() + '"]');
    write('project-slug', "title: project via slug\nscope: project\nprojects: ['fixture-project', FIXTURE-PROJECT]");
    write('other', 'title: other project\nscope: project\nprojects: [different]');
    writeFileSync(join(directives, 'ignored.txt'), 'not a directive');
    const paths = [pathFor(), pathFor({ repoPath: repo }), pathFor({ repoPath: repo + '/' }), pathFor({ projectId }), pathFor({ projectId, repoPath: repo }), pathFor({ repoPath: join(directory, 'outside') })];
    for (const [index, path] of paths.entries()) {
      const result = await parity(path, true);
      const ids = result.expected.body.directives.map((d: { id: string }) => d.id);
      expect(ids).not.toContain('other');
      expect(ids.includes('project-id')).toBe(index !== 5);
      expect(ids.includes('project-slug')).toBe(index !== 5);
      expect(ids.includes('repo')).toBe([1, 2, 4].includes(index));
      expect(result.oracleCounts.some(row => row.name === 'directivesScan')).toBe(true);
      expect(result.oracleCounts.some(row => row.name === 'parseDirectiveFile')).toBe(true);
      expect(result.expected.body.directives.find((d: { id: string }) => d.id === 'global')).toMatchObject({ body: 'body 雪', recentMerges: ['- four', '- three', '- two'] });
    }
    // The real handler catches ProjectNotFoundError as 500; a resolved slug
    // rejected by its explicit-id check remains the separate 404 case.
    expect((await parity(pathFor({ projectId: 'unknown' }), false)).expected.status).toBe(500);
    expect((await parity(pathFor({ projectId: 'fixture-project' }), false)).expected.status).toBe(404);
    control(); const denied = await call(pathFor(), ''); expect(denied.status).toBe(401); expect(denied.headers.get('x-o8d-native')).toBeNull();
    // A malformed file is handled by TS's established skip semantics.
    writeFileSync(join(directives, 'malformed.md'), 'not frontmatter'); await parity(pathFor(), false); rmSync(join(directives, 'malformed.md'));
    write('unsupported', 'title: unsupported\nunknownKey: yaml anchor'); await parity(pathFor(), false); rmSync(join(directives, 'unsupported.md'));
    writeFileSync(join(directives, 'oversized.md'), 'x'.repeat(2 * 1024 * 1024 + 1)); await parity(pathFor(), false); rmSync(join(directives, 'oversized.md'));
    symlinkSync(join(directives, 'global.md'), join(directives, 'link.md')); await parity(pathFor(), false); rmSync(join(directives, 'link.md'));
    for (const flag of ['missingGrant', 'malformedGrant', 'oversizedGrant']) {
      control(); const expected = await classic(origin, token, pathFor());
      control({ [flag]: true }); const response = await call(pathFor());
      expect(response.headers.get('x-o8d-native')).toBeNull(); expect(firstDifference(expected, await snapshot(response))).toBeNull();
    }
    // A completion cannot use the native payload: TS records exactly one sample,
    // and its real producer runs once, rather than recording then replaying.
    control(); const discardedOracle = await classic(origin, token, pathFor());
    const beforeDiscard = timingCount(); const discardId = control({ discardResult: true });
    const discarded = await call(pathFor());
    expect(discarded.headers.get('x-o8d-native')).toBeNull();
    expect(firstDifference(discardedOracle, await snapshot(discarded))).toBeNull();
    expect(timingCount()).toBe(beforeDiscard + 1);
    expect(counts(discardId).filter(row => row.name === 'parseDirectiveFile')).toHaveLength(8);
    // Receipt transport loss after the canonical writer commits must not replay
    // the GET and create a second sample. The failed request is closed instead.
    const beforeLoss = timingCount(); const lostId = control({ completionTransportFailure: true });
    await expect(call(pathFor())).rejects.toThrow();
    expect(timingCount()).toBe(beforeLoss + 1);
    expect(counts(lostId).filter(row => row.name === 'parseDirectiveFile')).toHaveLength(0);
    const beforeForged = timingCount(); control();
    const forged = await fetch(origin + pathFor(), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-o8d-session-read': 'complete-directives/1' }, body: JSON.stringify({ version: 1, durationMs: 1, body: { directives: [] } }) });
    expect(forged.status).toBe(400); expect(timingCount()).toBe(beforeForged);
    control(); const posted = await fetch(origin + pathFor(), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'fresh', title: 'fresh directive', scope: 'global', body: 'written by canonical Node POST', priority: 100 }) });
    expect(posted.status).toBe(200); expect(posted.headers.get('x-o8d-native')).toBeNull();
    expect(readFileSync(join(directives, 'fresh.md'), 'utf8')).toContain('written by canonical Node POST');
    const fresh = await parity(pathFor(), true); expect(fresh.expected.body.directives[0].id).toBe('fresh');
    if (process.env.O8D_DIRECTIVES_COUNTER_RECEIPT) writeFileSync(process.env.O8D_DIRECTIVES_COUNTER_RECEIPT, JSON.stringify({ directivesScan: 0, parseDirectiveFile: 0, scopeGrant: 1, timingSamples: 1, productFrontDoor: true, sessionReads: 'unset' }) + '\n');
    await server.stop(); server = undefined;
    expect((readFileSync(stderr, 'utf8') + readFileSync(join(directory, 'o8d-request-counts.jsonl'), 'utf8')).includes(token)).toBe(false);
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 300_000);
