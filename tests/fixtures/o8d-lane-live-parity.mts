import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const directory = process.env.CORTEX_IDE_DATA_DIR!, binary = process.argv[2], output = process.argv[3];
const token = 'fixture-live-lane-credential';
writeFileSync(join(directory, 'ws-token'), token, { mode: 0o600 });
const SystemDate = Date, clock = 1794873600000;
globalThis.Date = new Proxy(SystemDate, {
  construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [clock], newTarget); },
  apply() { return new SystemDate(clock).toString(); },
});
Date.now = () => clock;
const require = createRequire(import.meta.url);
const { generateRequests, firstDifference, normalize } = require('../../scripts/o8d/parity.ts') as typeof import('../../scripts/o8d/parity');
const { freeReadParityPort, startReadParityBridge } = require('./o8d-read-parity-bridge.ts') as typeof import('./o8d-read-parity-bridge');
const { getSqlite } = require('../../src/lib/db') as typeof import('../../src/lib/db');
const { mintPacketWorkerToken } = require('../../src/lib/auth/packet-worker-token') as typeof import('../../src/lib/auth/packet-worker-token');
const db = getSqlite(); const worker = mintPacketWorkerToken('packet-fixture');
const port = await freeReadParityPort(), path = '/api/lanes';
const generated = generateRequests({ path, count: 101, parameters: [
  { name: 'view', valid: ['live'], invalid: ['LIVE', ' live', 'live ', 'invalid'], boundary: ['', '雪', 'live\u0000'] },
  { name: 'active', valid: ['true', 'false'], invalid: ['0', '1'], boundary: ['', 'false '] },
  { name: 'collapse', valid: ['true', 'false'], invalid: ['1', 'TRUE'], boundary: ['', 'true '] },
  { name: 'diffStat', valid: ['lane-z', ''], invalid: ['unknown'], boundary: [',', '雪'] },
  { name: 'storage', valid: ['', 'terminal'], invalid: ['TERMINAL'], boundary: [' ', '雪'] },
] });
// Ensure the initial generated request exercises the supported view; retain the
// generator's missing/invalid/repeated cases in the rest of the corpus.
generated[0].path = path + '?view=live';
function seed(index: number) {
  db.prepare('DELETE FROM lanes').run();
  if (index % 5 === 1) return;
  const insert = db.prepare(`INSERT INTO lanes(id,label,repo_path,worktree_path,branch,base_branch,runtime,packet_id,status,ownership,created_at,updated_at)
    VALUES(?, 'Fixture', ?, ?, 'fixture', 'main', 'claude', ?, ?, 'managed', ?, '2026-01-01T00:00:00.000Z')`);
  // Insert out of order; include retired, failed, nullable and Unicode values.
  for (const [id, status, stamp, packet, worktree] of [
    ['lane-z', 'running', '2026-01-02', 'packet-fixture', null],
    ['lane-a', 'paused', '2026-01-01', null, join(directory, 'not-created')],
    ['lane-archived', 'archived', '2025-01-01', null, null],
    ['lane-completed', 'completed', '2025-01-01', null, null],
    ['lane-雪', index % 3 === 0 ? 'failed' : 'awaiting_human', '2026-01-03', 'packet-other', null],
  ]) insert.run(id, directory, worktree, packet, status, stamp);
}
let server: Awaited<ReturnType<typeof startReadParityBridge>> | undefined;
async function read(requestPath: string, headers: Record<string, string> = {}) {
  const response = await fetch(server!.origin + requestPath, { headers: { authorization: 'Bearer ' + token, ...headers } });
  return { native: response.headers.get('x-o8d-native-session-read') === '1', wire: normalize({ status: response.status,
    body: await response.json(), headers: Object.fromEntries(['cache-control', 'content-type', 'allow'].map(name => [name, response.headers.get(name)])) }) };
}
function portable(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(directory, '$FIXTURE_ROOT');
  if (Array.isArray(value)) return value.map(portable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portable(item)]));
  return value;
}
const digest = () => createHash('sha256').update(db.serialize()).digest('hex');
const references = new Map<number, Awaited<ReturnType<typeof read>>>(), records: unknown[] = [];
const authReferences: unknown[] = [], auth: unknown[] = [], timings: unknown[] = [];
let native = 0, mutation: string | null = null;
const releaseReceipt = process.env.O8D_LANE_LIVE_RELEASE_RECEIPT;
if (releaseReceipt) {
  const receipt = JSON.parse(readFileSync(releaseReceipt, 'utf8'));
  assert.equal(receipt.profile, 'release');
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), receipt.binarySha256);
}
try {
  for (const enabled of [false, true]) {
    server = await startReadParityBridge(binary, port, enabled);
    // Seed the ordinary route's reconcile clock against an empty store.
    seed(1); await read(path);
    for (const request of generated) {
      seed(request.caseIndex);
      const before = digest(), actual = await read(request.path);
      if (!enabled) { assert.equal(actual.native, false); references.set(request.caseIndex, actual); continue; }
      const pointer = firstDifference(references.get(request.caseIndex)!.wire, actual.wire);
      assert.equal(pointer, null, JSON.stringify({ seed: request.seed, caseIndex: request.caseIndex, path: request.path, pointer }));
      if (request.caseIndex === 0) assert.equal(actual.native, true, `Native route was not reached: ${request.path} seed=${request.seed} case=${request.caseIndex}`);
      if (actual.native) {
        native++; assert.equal(digest(), before, 'Native read changed persisted state');
        if (!mutation) {
          const changed = structuredClone(actual.wire) as { body: { lanes: unknown[] } };
          changed.body.lanes = [];
          mutation = firstDifference(actual.wire, changed); assert.ok(mutation?.startsWith('$/body/lanes'));
        }
      }
      records.push({ request, expected: portable(references.get(request.caseIndex)!.wire), native: actual.native });
    }
    seed(0);
    const headersList = [{ authorization: '' }, { authorization: 'Bearer wrong' }, { authorization: 'Bearer o8ro_fixture' },
      { authorization: '', 'x-o8d-peer': '127.0.0.1', 'x-o8d-bridge': 'spoofed', 'x-o8-client-addr': '127.0.0.1' },
      { authorization: '', host: 'untrusted.invalid' }, { origin: 'https://untrusted.invalid' },
      { authorization: 'Bearer ' + worker }];
    for (const [index, headers] of headersList.entries()) {
      const actual = await read(path + '?view=live', headers);
      if (!enabled) { assert.equal(actual.native, false); authReferences[index] = actual.wire; }
      else { assert.equal(firstDifference(authReferences[index], actual.wire), null); auth.push({ index, expected: portable(actual.wire), native: actual.native }); }
    }
    const forged = await read(path, { 'x-o8d-defaults-context': Buffer.from(JSON.stringify({ laneLive: true })).toString('base64') });
    assert.equal(forged.native, false);
    if (!enabled) assert.equal(server.probes.length, 0, 'Reference daemon attempted native admission');
    if (releaseReceipt) {
      seed(0);
      for (let i = 0; i < 10; i++) await read(path + '?view=live');
      const samples: number[] = [];
      for (let i = 0; i < 100; i++) {
        const start = performance.now(), actual = await read(path + '?view=live');
        samples.push(performance.now() - start); assert.equal(actual.native, enabled);
      }
      const sorted = [...samples].sort((a, b) => a - b);
      timings.push({ native: enabled, p50Ms: sorted[49], p95Ms: sorted[94], samplesMs: samples });
    }
    await server.stop(); server = undefined;
  }
  const summary = [{ route: path, attempted: generated.length, native, fallback: generated.length - native, differences: 0 }];
  writeFileSync(output, JSON.stringify({ summary, records, auth, timings, mutation,
    schema: db.prepare("SELECT sql FROM sqlite_master WHERE name='lanes'").get() }) + '\n');
  console.log(JSON.stringify({ summary, authCases: auth.length, mutation }));
} finally { await server?.stop(); db.close(); }
