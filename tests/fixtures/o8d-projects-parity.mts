import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
// Keep constructor-based missing-ledger timestamps deterministic too.
const SystemDate = Date;
const fixtureClock = 1794873600000;
globalThis.Date = new Proxy(SystemDate, {
  construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [fixtureClock], newTarget); },
  apply() { return new SystemDate(fixtureClock).toString(); },
});
Date.now = () => fixtureClock;
const { firstDifference, generateRequests, normalize } = require('../../scripts/o8d/parity.ts') as typeof import('../../scripts/o8d/parity');
const { freeReadParityPort, startReadParityBridge } = require('./o8d-read-parity-bridge.ts') as typeof import('./o8d-read-parity-bridge');
const { getSqlite } = require('../../src/lib/db/index.ts') as typeof import('../../src/lib/db');
const registry = require('../../src/lib/repos/registry.ts') as typeof import('../../src/lib/repos/registry');
const readiness = require('../../src/lib/repos/readiness.ts') as typeof import('../../src/lib/repos/readiness');
const icons = require('../../src/lib/repos/project-icon-resolver.ts') as typeof import('../../src/lib/repos/project-icon-resolver');
const [binary, output] = process.argv.slice(2);
const directory = process.env.CORTEX_IDE_DATA_DIR!;
assert.ok(directory.includes('o8d-projects-parity-'));
assert.equal(process.env.HOME, directory);
const token = 'owned-projects-parity-fixture';
writeFileSync(join(directory, 'ws-token'), token, { mode: 0o600 });
writeFileSync(join(directory, 'instance-id'), 'fixture-projects-instance');
writeFileSync(join(directory, 'boot-id'), 'fixture-projects-boot');
const fixtureBin = join(directory, 'bin');
mkdirSync(fixtureBin);
writeFileSync(join(fixtureBin, 'gh'), '#!/bin/sh\nprintf \'[{"full_name":"fixture/repo","private":true,"description":"fixture"}]\\n\'\n', { mode: 0o700 });
for (const name of ['ssh', 'codex', 'claude']) writeFileSync(join(fixtureBin, name), '#!/bin/sh\nexit 127\n', { mode: 0o700 });
process.env.PATH = fixtureBin + ':/usr/bin:/bin';
const repoRoot = join(directory, 'fixture-repo');
mkdirSync(repoRoot);
execFileSync('git', ['init', '-q', join(directory, 'fixture-git')]);
const db = getSqlite();
const port = await freeReadParityPort();
let server: Awaited<ReturnType<typeof startReadParityBridge>> | undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  assert.ok(url.startsWith('http://127.0.0.1:'), 'External fixture network disabled');
  return originalFetch(input, init);
};
async function read(path: string, headers: Record<string, string> = {}, method = 'GET') {
  const response = await fetch(server!.origin + path, { method,
    signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${token}`, ...headers },
    ...(method === 'POST' ? { body: '{}' } : {}) });
  const bytes = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get('content-type');
  const names = ['content-type', 'cache-control', 'allow', ...(!type?.includes('json')
    ? ['x-content-type-options', 'content-security-policy', 'content-length'] : [])];
  return { native: response.headers.get('x-o8d-native-session-read') === '1', wire: normalize({
    status: response.status, headers: Object.fromEntries(names.map(name => [name, response.headers.get(name)])),
    body: type?.includes('json') ? JSON.parse(bytes.toString()) : { base64: bytes.toString('base64') } }) };
}
function portable(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(directory, '$FIXTURE_ROOT').replaceAll(process.cwd(), '$SOURCE_ROOT');
  if (Array.isArray(value)) return value.map(portable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portable(item)]));
  return value;
}
function portableRequest(path: string) {
  const url = new URL(path, 'http://fixture.invalid');
  const query = new URLSearchParams();
  for (const [name, value] of url.searchParams) query.append(name, value.replaceAll(directory, '$FIXTURE_ROOT'));
  return url.pathname + (query.size ? '?' + query : '');
}
function snapshot() {
  const files: Record<string, string> = {};
  function walk(folder: string) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('o8d-request-counts') || entry.name.endsWith('-shm')) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[path.slice(directory.length + 1)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  }
  walk(directory);
  return files;
}
async function seed(index: number, randomCreation = false) {
  const kind = Math.floor(index / 10) % 8;
  const repos = kind === 0 ? [] : [{ id: 'repo-a', name: kind === 7 ? '雪 repo' : 'Alpha',
    localPath: kind === 6 ? join(directory, 'fixture-git') : repoRoot,
    setup: { workspaceIsolationPreference: ['git-worktree', 'apfs-cow-clone', 'worktree', 'auto'][index % 4] },
    isGitRepo: kind === 6, remoteUrl: null, defaultBranch: 'main', addedAt: '2026-01-01T00:00:00.000Z',
    lastOpenedAt: '2026-11-16T00:00:00.000Z', extraField: 'retained-fixture' },
  { id: 'repo-b', name: 'Beta', localPath: join(directory, 'missing-repo'), isGitRepo: false, remoteUrl: null,
    addedAt: '2026-01-02T00:00:00.000Z', setup: { installCommand: '  fixture command  ', envFiles: [], envMode: 'skip' },
    lastOpenedAt: '2026-01-02T00:00:00.000Z' }];
  writeFileSync(join(directory, 'repos.json'), kind === 4 ? '{ broken' : JSON.stringify({ version: 1, repos }));
  db.exec('DELETE FROM project_repos; DELETE FROM projects;');
  db.prepare("DELETE FROM app_state WHERE key LIKE 'project-merge-mode:%' OR key LIKE 'repository-icon:%' OR key='active_project_id'").run();
  const pid = 'proj-01234567-89a', extra = 'proj-12345678-90a';
  const insert = db.prepare('INSERT INTO projects(id,name,slug,description,main_repo_id,created_at,updated_at,color,sort_order) VALUES(?,?,?,?,?,?,?,?,?)');
  insert.run(pid, 'Alpha', 'alpha', (kind === 5 || (kind === 2 && !randomCreation)) ? 'Imported from the desktop project rail. fixture' : null,
    kind === 2 ? null : 'repo-a', 10, 20, '#7fa68f', 1);
  insert.run(extra, '雪 project', 'snow', ' Fixture description ', null, 30, 40, null, 0);
  if (kind !== 0 && (kind !== 2 || !randomCreation)) {
    const link = db.prepare('INSERT INTO project_repos(project_id,repo_id,role,suggestion_origin,added_at) VALUES(?,?,?,?,?)');
    link.run(pid, 'repo-a', 'fullstack', 'manual', 12); link.run(pid, 'repo-b', null, 'fixture-origin', 11);
  }
  const ledger: { projects: Array<{ id: string; sqliteProjectId?: string; name: string; repoPaths: string[]; createdAt: string; color?: string }>; activeProjectId: string } = { projects: [{ id: 'legacy-alpha', sqliteProjectId: pid, name: 'Alpha', repoPaths: [],
    createdAt: '2026-01-01T00:00:00.000Z', color: '#a39565' }, { id: extra, name: '雪 project', repoPaths: [],
    createdAt: '2026-01-02T00:00:00.000Z' }], activeProjectId: kind === 2 ? 'repo:repo-a' : 'legacy-alpha' };
  // Dirty descriptions exercise the deterministic TS repair writer; random-ID
  // creation is proved separately against the saved SQL rows after fallback.
  if (kind === 3) rmSync(join(directory, 'projects.json'), { force: true });
  else writeFileSync(join(directory, 'projects.json'), JSON.stringify(ledger));
  if (index % 3 !== 0) db.prepare('INSERT OR REPLACE INTO app_state(key,value,updated_at)VALUES(?,?,?)')
    .run('project-merge-mode:' + pid, index % 3 === 1 ? 'direct' : 'pr_only', 1);
  if (index % 4 === 0) writeFileSync(join(directory, '.dogfood-pr-only'), 'fixture');
  else rmSync(join(directory, '.dogfood-pr-only'), { force: true });
  rmSync(join(repoRoot, 'favicon.svg'), { force: true });
  if (kind === 7) {
    writeFileSync(join(repoRoot, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="M0 0h1v1H0z"/></svg>');
    utimesSync(join(repoRoot, 'favicon.svg'), fixtureClock / 1000, fixtureClock / 1000);
  }
  if (kind === 1) db.prepare('INSERT OR REPLACE INTO app_state(key,value,updated_at)VALUES(?,?,?)')
    .run('repository-icon:repo-a', JSON.stringify({ faviconPath: null, projectIcon: { kind: 'emoji', emoji: ' 🦀 ' } }), 1);
  for (const repo of repos) { readiness.invalidateRepoReadiness(repo.localPath); icons.projectIconResolver.invalidate(repo.localPath); }
  try { await registry.listReposFresh(); } catch { /* Malformed registry stays with its owner. */ }
  return { kind, pid, extra };
}
const routes = [
  { path: '/api/panel/repos', parameters: [
    { name: 'source', valid: ['local', 'github'], invalid: ['unknown'], boundary: ['', '雪'] },
    { name: 'readiness', valid: ['repo-a', 'repo-b'], invalid: ['missing'], boundary: ['', '雪'] },
    { name: 'restorePath', valid: [repoRoot, join(directory, 'fixture-git')], invalid: ['relative', '../fixture-escape'], boundary: ['', '雪', join(directory, 'missing-repo')] },
    { name: 'restoreValidationOnly', valid: ['1'], invalid: ['0', 'true'], boundary: [''] },
  ] },
  { path: '/api/panel/projects', parameters: [] },
  { path: '/api/projects', parameters: [] },
  { path: '/api/panel/repo-icon', parameters: [{ name: 'id', valid: ['repo-a', 'repo-b'], invalid: ['unknown', '雪'], boundary: ['', 'x'.repeat(200)] }] },
  { path: '/api/projects/[id]', parameters: [{ name: 'id', valid: ['proj-01234567-89a', 'proj-12345678-90a'], invalid: ['unknown', '雪'], boundary: ['', 'x'.repeat(200)] }] },
];
const records: unknown[] = [], summary: unknown[] = [], auth: unknown[] = [], timings: unknown[] = [];
const references = new Map<string, Awaited<ReturnType<typeof read>>>();
const authReferences = new Map<string, Awaited<ReturnType<typeof read>>>();
const reserved = ['/api/projects/locks'];
const retired = ['/api/projects/context', '/api/projects/dismissed-suggestions'];
const retiredReferences = new Map<string, Awaited<ReturnType<typeof read>>>();
const retiredProof: unknown[] = [];
const reservedReferences = new Map<string, Awaited<ReturnType<typeof read>>>();
const reservedProof: unknown[] = [];
let creationFallback: unknown;
const releaseReceipt = process.env.O8D_PROJECTS_RELEASE_RECEIPT;
if (releaseReceipt) {
  const receipt = JSON.parse(readFileSync(releaseReceipt, 'utf8'));
  assert.equal(receipt.profile, 'release');
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), receipt.binarySha256);
}
let mutationPointer: string | null = null;
try {
  for (const enabled of [false, true]) {
    server = await startReadParityBridge(binary, port, enabled);
    for (const route of routes) {
      const generated = generateRequests({ path: route.path, parameters: route.parameters, count: 100 });
      let native = 0;
      for (const request of generated) {
        const fixture = await seed(request.caseIndex);
        let path = request.path;
        if (route.path === '/api/projects/[id]') {
          const id = new URL(path, 'http://fixture.invalid').searchParams.get('id');
          path = '/api/projects/' + encodeURIComponent(id ?? fixture.pid);
        }
        const before = snapshot(); const actual = await read(path);
        const key = route.path + ':' + request.caseIndex;
        if (!enabled) { assert.equal(actual.native, false); references.set(key, actual); continue; }
        if (actual.native) assert.deepEqual(snapshot(), before, `Native read changed durable files: ${path}`);
        const expected = references.get(key)!;
        const pointer = firstDifference(expected.wire, actual.wire);
        assert.equal(pointer, null, JSON.stringify({ seed: request.seed, caseIndex: request.caseIndex, path, pointer }));
        if (actual.native) native++;
        if (request.caseIndex === 0) assert.equal(actual.native, true, `Native route was not reached: ${path}`);
        records.push({ request: { ...request, path: portableRequest(path) }, route: route.path, fixture: fixture.kind,
          expected: portable(expected.wire), native: actual.native });
      }
      if (enabled) {
        const result = { route: route.path, attempted: generated.length, native, fallback: generated.length - native, differences: 0 };
        summary.push(result); console.log(JSON.stringify(result));
      }
      await seed(0);
      const path = route.path === '/api/projects/[id]' ? '/api/projects/proj-01234567-89a' : route.path;
      const headersList = [{ authorization: '' }, { authorization: 'Bearer wrong' }, { authorization: 'Bearer o8ro_fixture' },
        { host: 'untrusted.invalid' }, { origin: 'https://untrusted.invalid' }, { 'x-o8-relay-forward': '1' },
        { 'x-o8d-peer': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1', 'x-o8d-bridge': 'spoofed' }];
      for (const [index, headers] of headersList.entries()) {
        const actual = await read(path, headers); const key = route.path + ':' + index;
        if (!enabled) authReferences.set(key, actual);
        else {
          const expected = authReferences.get(key)!;
          assert.equal(firstDifference(expected.wire, actual.wire), null, `Auth differs: ${path}`);
          auth.push({ route: route.path, expected: portable(expected.wire), native: actual.native });
        }
      }
    }
    await seed(0);
    for (const path of reserved) {
      const count = server.probes.length; const actual = await read(path);
      if (!enabled) reservedReferences.set(path, actual);
      else {
        assert.equal(actual.native, false);
        assert.equal(firstDifference(reservedReferences.get(path)!.wire, actual.wire), null);
        assert.deepEqual(server.probes.slice(count), [{ path, status: 409 }], 'Reserved GET executed during admission');
        reservedProof.push({ path, admissionStatus: 409, native: false });
      }
    }
    // Retired literal names must not become project data through [id].
    for (const path of retired) {
      const count = server.probes.length; const actual = await read(path);
      assert.equal(actual.native, false);
      assert.equal((actual.wire as { status: number }).status, 404);
      if (!enabled) retiredReferences.set(path, actual);
      else {
        assert.equal(firstDifference(retiredReferences.get(path)!.wire, actual.wire), null);
        assert.deepEqual(server.probes.slice(count), [{ path, status: 409 }], 'Retired name admitted as project data');
        retiredProof.push({ path, admissionStatus: 409, status: 404, native: false });
      }
    }
    if (releaseReceipt) for (const route of routes) {
      await seed(0);
      const path = route.path === '/api/projects/[id]' ? '/api/projects/proj-01234567-89a'
        : route.path === '/api/panel/repo-icon' ? route.path + '?id=unknown' : route.path;
      for (let index = 0; index < 10; index++) await read(path);
      const samples = []; let status = 0;
      for (let index = 0; index < 100; index++) {
        const start = performance.now(); const actual = await read(path); samples.push(performance.now() - start);
        assert.equal(actual.native, enabled, `Latency route not reached: ${path}`);
        status = (actual.wire as { status: number }).status;
      }
      const sorted = [...samples].sort((a, b) => a - b);
      timings.push({ path, status, native: enabled, p50Ms: sorted[49], p95Ms: sorted[94], samplesMs: samples });
    }
    if (!enabled) assert.deepEqual(server.probes, [], 'Reference child attempted native admission');
    else {
      // This separate ownership edge allows real random IDs and checks persisted
      // correspondence rather than weakening the frozen oracle's ID comparison.
      await seed(20, true);
      const before = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
      const created = await read('/api/projects'); assert.equal(created.native, false);
      const after = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
      assert.ok(after.n > before.n, 'TS fallback did not create the missing project');
      const body = (created.wire as { body: { projects: Array<{ id: string }> } }).body;
      for (const project of body.projects) assert.ok(db.prepare('SELECT id FROM projects WHERE id=?').get(project.id));
      creationFallback = { native: false, addedProjects: after.n - before.n, responseIdsPersisted: true };
      await seed(0); const actual = await read('/api/panel/repos'); assert.equal(actual.native, true);
      const mutated = structuredClone(actual.wire) as { body: { repos: unknown } }; mutated.body.repos = null;
      mutationPointer = firstDifference(actual.wire, mutated); assert.ok(mutationPointer?.startsWith('$/body/repos'));
    }
    await server.stop(); server = undefined;
  }
  writeFileSync(output, JSON.stringify({ records, summary, auth, timings, reservedProof, retiredProof, creationFallback, separateChildLaunchFlags: [false, true],
    referenceAdmissionProbes: 0, mutationPointer }, null, 2) + '\n');
} finally { db.close(); await server?.stop(); }
process.exit(0);
