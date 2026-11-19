import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { NextRequest } from 'next/server';
import { afterAll, expect, it } from 'vitest';
import type { LegacyOutputPark } from '@/lib/workspace/legacy-output-parking';
import { startParityReference } from './fixtures/ws-parity-server';

// Synthetic recorded metadata only; these tests never park output or run a build.
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-parked-preview-')));
const data = path.join(root, 'data');
const previous = { O8_DATA_DIR: process.env.O8_DATA_DIR, CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR, CORTEX_IDE_DB_PATH: process.env.CORTEX_IDE_DB_PATH };
Object.assign(process.env, { O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data, CORTEX_IDE_DB_PATH: path.join(data, 'cortex-ide.db') });
const { getSqlite, closeDb } = await import('@/lib/db');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = (name: string) => { const stat = lstatSync(name); return { canonicalPath: name, device: stat.dev, inode: stat.ino }; };
const token = getOrCreateWsToken();
const source = process.cwd();
function fixture(kind: 'legacy' | 'failed-prebuild') {
  const operationId = randomUUID(); const workspacePath = path.join(root, operationId); mkdirSync(workspacePath);
  const retainedPath = path.join(workspacePath, `.o8-retained-${kind === 'legacy' ? 'legacy' : 'prebuild'}-${operationId}`);
  mkdirSync(retainedPath); writeFileSync(path.join(retainedPath, 'proof'), 'unchanged output');
  const rawTarget = '../../../node_modules/fixture-package'; const relative = 'dev/node_modules/fixture-package-0123456789abcdef';
  mkdirSync(path.dirname(path.join(retainedPath, relative)), { recursive: true }); symlinkSync(rawTarget, path.join(retainedPath, relative));
  const workspace = identity(workspacePath); const output = { ...identity(retainedPath), canonicalPath: path.join(workspacePath, '.next') };
  const entries = [{ ...output, relative: '.', kind: 'directory', mode: 448, bytes: 0, sha256: null },
    { ...identity(path.join(retainedPath, 'proof')), relative: 'proof', kind: 'file', mode: 384, bytes: 16, sha256: 'a'.repeat(64) },
    { ...identity(path.join(retainedPath, relative)), relative, kind: 'symlink', mode: 511, bytes: Buffer.byteLength(rawTarget), sha256: null, rawTarget }];
  for (const relative of ['dev', 'dev/node_modules']) entries.push({ ...identity(path.join(retainedPath, relative)), relative, kind: 'directory', mode: 448, bytes: 0, sha256: null });
  const common = path.join(root, `common-${operationId}`); const registrations = path.join(common, 'worktrees'); const admin = path.join(registrations, 'fixture'); mkdirSync(admin, { recursive: true });
  const receipt = { device: workspace.device, inode: workspace.inode, sha256: 'a'.repeat(64) };
  const custody = { schema: 'o8/linked-git-build-custody/v1', common: identity(common), registrations: identity(registrations), admin: identity(admin), gitFile: receipt, backPointer: receipt, commonFile: receipt };
  const evidence = ['source', 'stop'].map(name => { const file = path.join(root, `${operationId}-${name}.json`); writeFileSync(file, '{}'); return { path: file, sha256: 'b'.repeat(64) }; });
  const retainedBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const processIdentity = { version: 1, platform: process.platform, bootId: 'fixture-boot', startId: 'fixture-start' };
  const resource = { schema: 'o8/generated-output-resource/v1', resourceId: randomUUID(), workspace, output, state: 'failed-held', origin: 'managed-creation', version: 3, createdAt: 1, updatedAt: 2,
    revision: { head: 'c'.repeat(40), tree: 'd'.repeat(40), dirty: false, workingDigest: 'e'.repeat(64) },
    creationAuthority: { kind: 'prebuild', pid: 999999, identity: processIdentity, linkedGit: custody },
    attempt: { id: randomUUID(), mode: 'build', ownerPid: 999999, ownerIdentity: processIdentity, children: [{ pid: 999998, identity: processIdentity, exitCode: 17, signal: null, observedClosed: true }] } };
  const record = kind === 'legacy' ? { schema: 'o8/retained-legacy-output/v1', operationId, state: 'parked', version: 2, workspace, output, originalPath: output.canonicalPath, retainedPath, custody, intent: 'Fixture parking', evidence, entries, contentDigest: hash(entries), retainedBytes, createdAt: 1, updatedAt: 2 }
    : { schema: 'o8/failed-prebuild-park/v1', operationId, state: 'parked', version: 2, resource, retainedPath, intent: 'Fixture parking', evidence, entries, retainedBytes };
  const db = getSqlite();
  if (kind === 'legacy') db.prepare('INSERT INTO workspace_legacy_output_parks VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(operationId, workspacePath, retainedPath, output.device, output.inode, 'parked', JSON.stringify(record), 2);
  else {
    db.prepare('INSERT INTO workspace_generated_outputs (resource_id, workspace_path, state, payload_json, version, created_at, updated_at, retained_operation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(resource.resourceId, workspacePath, 'failed-held', JSON.stringify(resource), 3, 1, 2, operationId);
    db.prepare('INSERT INTO workspace_failed_prebuild_parks VALUES (?, ?, ?, ?, ?, ?)').run(operationId, resource.resourceId, workspacePath, 'parked', JSON.stringify(record), 2);
  }
  return { kind, operationId, record, resource, retainedPath, workspace, entries, dependency: { relative, rawTarget } };
}
const legacy = fixture('legacy'); const failed = fixture('failed-prebuild');
const worker = mintPacketWorkerToken('fixture-worker');
const endpoint = 'http://localhost/api/orchestrator/workspace/output-disposition';
async function request(selection: Record<string, string>, bearer = token) {
  const { GET } = await import('@/app/api/orchestrator/workspace/output-disposition/route');
  return GET(new NextRequest(`${endpoint}?${new URLSearchParams(selection)}`, { headers: { host: 'localhost', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } }));
}
function snapshot() { return ['workspace_legacy_output_parks', 'workspace_failed_prebuild_parks', 'workspace_generated_outputs', 'workspace_retention_holds', 'workspace_exact_claims'].map(table => getSqlite().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()); }
afterAll(() => { closeDb(); for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); });
it.each([legacy, failed])('previews persisted $kind without mutation or dependency-target access', async selected => {
  const before = snapshot(); const bytes = readFileSync(path.join(selected.retainedPath, 'proof')); closeDb();
  const response = await request({ kind: selected.kind, operationId: selected.operationId }); expect(response.status).toBe(200);
  const result = (await response.json()).result;
  expect(result).toMatchObject({ schema: 'o8/parked-output-disposition-preview/v1', kind: selected.kind, operationId: selected.operationId, operationVersion: 2, executionSupported: false, reclaimedBytes: 0, workspace: selected.workspace,
    inventory: { entries: 5, recordedBytes: selected.record.retainedBytes, dependencyTargetsOwned: false }, freshness: { filesystem: 'not_checked', processes: 'not_checked', evidence: 'recorded_only' } });
  expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(result.dependencies.items).toEqual([{ relative: selected.dependency.relative, rawTarget: selected.dependency.rawTarget, ownership: 'link_node_only' }]);
  expect(result.producer.outcome).toBe(selected.kind === 'legacy' ? 'unknown' : 'terminal_failure');
  if (selected.kind === 'failed-prebuild') expect(result.producer.children[0].exitCode).toBe(17);
  expect(snapshot()).toEqual(before); expect(readFileSync(path.join(selected.retainedPath, 'proof'))).toEqual(bytes);
});
it('binds preview fingerprints to persisted independent holds and continuation consumers', async () => {
  const selection = { kind: failed.kind, operationId: failed.operationId };
  const first = (await (await request(selection)).json()).result;
  const ws = failed.workspace; getSqlite().prepare('INSERT INTO workspace_retention_holds VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ws.canonicalPath, root, 'fixture-repository', 'fixture-worktree', 'fixture-packet', 'fixture-lane', 'fixture-hold', 'Preserve diagnostics', ws.device, ws.inode, 1, null, 1);
  const consumer = { ...failed.resource, resourceId: randomUUID(), workspace: { ...ws, canonicalPath: path.join(root, 'consumer') }, output: { ...failed.resource.output, canonicalPath: path.join(root, 'consumer/.next') }, continuedFrom: { resourceId: failed.resource.resourceId, operationId: failed.operationId } };
  getSqlite().prepare('INSERT INTO workspace_generated_outputs (resource_id, workspace_path, state, payload_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(consumer.resourceId, consumer.workspace.canonicalPath, consumer.state, JSON.stringify(consumer), 3, 1, 2);
  const before = snapshot(); const second = (await (await request(selection)).json()).result;
  expect(second.holds.items).toContainEqual(expect.objectContaining({ holdId: 'fixture-hold' }));
  expect(second.consumers.items).toContainEqual(expect.objectContaining({ resourceId: consumer.resourceId }));
  expect(second.fingerprint).not.toBe(first.fingerprint); expect(snapshot()).toEqual(before);
});
it.each<Record<string, string>>([{}, { kind: 'legacy' }, { kind: 'other', operationId: legacy.operationId }, { kind: 'legacy', operationId: '../other' }])('refuses malformed selection %j', async selection => { expect((await request(selection)).status).toBe(400); });
it.each(['', 'invalid', 'worker'])('denies non-operator bearer %s before reading a selection', async bearer => { const before = snapshot(); const response = await request({ kind: 'legacy', operationId: legacy.operationId }, bearer === 'worker' ? worker : bearer); expect([401, 403]).toContain(response.status); expect(snapshot()).toEqual(before); });
it('refuses unknown and non-parked operations', async () => {
  expect((await request({ kind: 'legacy', operationId: randomUUID() })).status).toBe(409);
  const original = getSqlite().prepare('SELECT payload_json FROM workspace_legacy_output_parks WHERE operation_id = ?').get(legacy.operationId) as { payload_json: string };
  const next = { ...legacy.record, state: 'restoring', version: 3 };
  getSqlite().prepare('UPDATE workspace_legacy_output_parks SET state = ?, version = ?, payload_json = ? WHERE operation_id = ?').run('restoring', 3, JSON.stringify(next), legacy.operationId);
  expect((await request({ kind: 'legacy', operationId: legacy.operationId })).status).toBe(409);
  getSqlite().prepare('UPDATE workspace_legacy_output_parks SET state = ?, version = ?, payload_json = ? WHERE operation_id = ?').run('parked', 2, original.payload_json, legacy.operationId);
});
it('projects the same selection through the existing generated-output script entry point', async () => {
  const before = snapshot(); const { stdout } = await promisify(execFile)(process.execPath, [path.join(source, 'scripts/generated-output.mjs'), 'disposition-preview', '--kind', 'failed-prebuild', '--operation', failed.operationId], { cwd: source, env: process.env, timeout: 30_000, maxBuffer: 1024 ** 2 });
  const cli = JSON.parse(stdout.trim().split('\n').at(-1)!); const api = (await (await request({ kind: 'failed-prebuild', operationId: failed.operationId })).json()).result;
  expect(cli).toEqual(api); expect(snapshot()).toEqual(before);
});

it('reports a bounded hold inventory and an exact claim without changing either', async () => {
  const ws = legacy.workspace; const db = getSqlite();
  for (let index = 0; index < 55; index += 1) db.prepare('INSERT INTO workspace_retention_holds VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(path.join(root, `historical-hold-${index}`), root, 'fixture-repository', 'fixture-worktree', 'fixture-packet', 'fixture-lane', `bounded-hold-${index}`, 'Preserve evidence', ws.device, ws.inode, 1, null, 1);
  const claimId = randomUUID();
  db.prepare(`INSERT INTO workspace_exact_claims (kind, repository_path, worktree_id, operation_id, expected_path, source_path, claim_path, state, parent_device, parent_inode, parent_canonical_path, source_device, source_inode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('restore-creation', root, 'fixture-worktree', claimId, legacy.retainedPath, legacy.retainedPath, path.join(root, 'claim'), 'prepared', ws.device, ws.inode, ws.canonicalPath, ws.device, ws.inode, 1, 1);
  const before = snapshot(); const result = (await (await request({ kind: 'legacy', operationId: legacy.operationId })).json()).result;
  expect(result.holds.items).toHaveLength(50); expect(result.holds.truncated).toBe(true);
  expect(result.claims.items).toContainEqual(expect.objectContaining({ operationId: claimId, state: 'prepared' }));
  expect(result.executionSupported).toBe(false); expect(result.reclaimableBytes).toBeNull(); expect(snapshot()).toEqual(before);
});
it('refuses inconsistent recorded inventory bytes and a lost failed-resource binding', async () => {
  const db = getSqlite(); const original = JSON.stringify(legacy.record);
  try {
    db.prepare('UPDATE workspace_legacy_output_parks SET payload_json = ? WHERE operation_id = ?').run(JSON.stringify({ ...legacy.record, retainedBytes: legacy.record.retainedBytes + 1 }), legacy.operationId);
    expect((await request({ kind: 'legacy', operationId: legacy.operationId })).status).toBe(409);
  } finally { db.prepare('UPDATE workspace_legacy_output_parks SET payload_json = ? WHERE operation_id = ?').run(original, legacy.operationId); }
  try {
    db.prepare('UPDATE workspace_generated_outputs SET retained_operation_id = NULL WHERE resource_id = ?').run(failed.resource.resourceId);
    expect((await request({ kind: 'failed-prebuild', operationId: failed.operationId })).status).toBe(409);
  } finally { db.prepare('UPDATE workspace_generated_outputs SET retained_operation_id = ? WHERE resource_id = ?').run(failed.operationId, failed.resource.resourceId); }
});
it('refuses duplicate selectors and mutation-like query additions', async () => {
  const { GET } = await import('@/app/api/orchestrator/workspace/output-disposition/route');
  for (const extra of ['&kind=failed-prebuild', '&action=delete']) {
    const response = await GET(new NextRequest(`${endpoint}?kind=legacy&operationId=${legacy.operationId}${extra}`, { headers: { host: 'localhost', authorization: `Bearer ${token}` } }));
    expect(response.status).toBe(400);
  }
});

it.each(['workspace-inode', 'output-inode', 'directory-bytes', 'file-hash', 'empty-evidence', 'internal-evidence'])('refuses coherent indexes with malformed recorded %s', async defect => {
  const corrupt = structuredClone(legacy.record) as LegacyOutputPark;
  if (defect === 'workspace-inode') corrupt.workspace.inode = -1;
  if (defect === 'output-inode') { corrupt.output.inode = 0; corrupt.entries[0].inode = 0; }
  if (defect === 'directory-bytes') { corrupt.entries[0].bytes = 123; corrupt.retainedBytes += 123; }
  if (defect === 'file-hash') corrupt.entries[1].sha256 = 'not-a-hash';
  if (defect === 'empty-evidence') corrupt.evidence = [{}, {}] as LegacyOutputPark['evidence'];
  if (defect === 'internal-evidence') corrupt.evidence[0].path = path.join(corrupt.workspace.canonicalPath, 'evidence.json');
  corrupt.contentDigest = hash(corrupt.entries);
  const update = getSqlite().prepare('UPDATE workspace_legacy_output_parks SET payload_json = ?, source_device = ?, source_inode = ? WHERE operation_id = ?');
  try {
    update.run(JSON.stringify(corrupt), corrupt.output.device, corrupt.output.inode, legacy.operationId);
    const before = snapshot(); expect((await request({ kind: 'legacy', operationId: legacy.operationId })).status).toBe(409); expect(snapshot()).toEqual(before);
  } finally { const original = legacy.record as LegacyOutputPark; update.run(JSON.stringify(original), original.output.device, original.output.inode, legacy.operationId); }
});

it.each([legacy, failed])('preserves the existing $kind status script command', async selected => {
  const before = snapshot(); const command = selected.kind === 'legacy' ? 'legacy-status' : 'failed-prebuild-status';
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(source, 'scripts/generated-output.mjs'), command, '--operation', selected.operationId], { cwd: source, env: process.env, timeout: 30_000, maxBuffer: 1024 ** 2 });
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
  expect(result.ok).toBe(true); expect(result.command).toBe(command);
  expect(selected.kind === 'legacy' ? result.legacy[0].operationId : result.retention.operationId).toBe(selected.operationId);
  expect(snapshot()).toEqual(before);
});

it('serves the recorded operator preview through the public WS front door with Next absent', async () => {
  const selection = new URLSearchParams({ kind: legacy.kind, operationId: legacy.operationId });
  const expected = await (await request(Object.fromEntries(selection))).json();
  const before = snapshot(); const bytes = readFileSync(path.join(legacy.retainedPath, 'proof'));
  closeDb();
  const server = await startParityReference({ directory: data, productFrontDoor: true, nativeHttp: true, o8d: false });
  try {
    await server.stopNext();
    const url = server.url.replace('ws:', 'http:').replace('/ws', '') + new URL(endpoint).pathname;
    const read = (query: string, bearer = server.token, method = 'GET') => fetch(`${url}?${query}`, {
      method, headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });
    const response = await read(String(selection));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    expect(expected.result.executionSupported).toBe(false);
    expect(expected.result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    for (const bearer of ['', 'invalid', mintPacketWorkerToken('socket-fixture-worker')]) {
      expect([401, 403]).toContain((await read(String(selection), bearer)).status);
    }
    for (const query of ['', 'kind=legacy', `kind=other&operationId=${legacy.operationId}`,
      'kind=legacy&operationId=../other', `${selection}&kind=failed-prebuild`, `${selection}&action=delete`]) {
      const refused = await read(query);
      expect(refused.status).toBe(400);
      expect((await refused.json()).error.code).toBe('invalid_request');
    }
    expect((await read(`kind=legacy&operationId=${randomUUID()}`)).status).toBe(409);
    // Only GET is registered; no new mutation method is introduced.
    expect((await read(String(selection), server.token, 'POST')).status).toBe(502);
    expect(snapshot()).toEqual(before);
    expect(readFileSync(path.join(legacy.retainedPath, 'proof'))).toEqual(bytes);
  } finally { await server.stop(); }
}, 60_000);
