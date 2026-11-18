import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as rawRequest } from 'node:http';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { beforeAll, expect, it } from 'vitest';
import { seedSessionFixture } from '../scripts/o8d/parity';
const route = '/api/orchestrator/session-rules';
const binary = process.env.O8D_TEST_BINARY ?? join(process.cwd(), 'crates/o8d/target/session-reads/debug/o8d');
beforeAll(async () => { if (!process.env.O8D_TEST_BINARY) await new Promise<void>((resolve, reject) => { const build = spawn('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--jobs', '1', '--target-dir', 'crates/o8d/target/session-reads'], { stdio: 'inherit' }); build.once('exit', code => code === 0 ? resolve() : reject(Error('o8d build failed'))); build.once('error', reject); }); }, 300000);
async function fixture(run: (origin: string, root: string, token: string) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-session-rules-'))), token = 'fixture-session-rule-operator';
  let daemon: ReturnType<typeof spawn> | undefined; let stderr = '';
  try {
    await seedSessionFixture(root); writeFileSync(join(root, 'ws-token'), token);
    daemon = spawn(binary, ['--experimental-ws', '--listen', '127.0.0.1:0', '--app-upstream', '127.0.0.1:1'], { env: { ...process.env, O8_API_FRONT_DOOR: '1', O8D_NATIVE_OWNED: '1', O8D_NATIVE_SESSION_READS: undefined, O8D_BRIDGE_KEY: 'fixture-session-rule-bridge', O8D_EPOCH: 'fixture-session-rule', O8D_SESSION_DATA_DIR: root, O8D_SESSION_DB_PATH: join(root, 'cortex-ide.db'), O8D_REQUEST_COUNTS_PATH: join(root, 'o8d-request-counts.jsonl') }, stdio: ['pipe', 'pipe', 'pipe'] });
    daemon.stderr!.on('data', chunk => stderr += chunk);
    const origin = await new Promise<string>((resolve, reject) => { let text = ''; const timer = setTimeout(() => reject(Error('daemon timeout')), 10000); daemon!.stdout!.on('data', chunk => { text += chunk; for (const line of text.split('\n')) try { const row = JSON.parse(line); if (row.listening) { clearTimeout(timer); resolve('http://' + row.listening); } } catch { /* incomplete startup frame */ } }); daemon!.once('error', reject); });
    await run(origin, root, token);
    expect(stderr).not.toContain(token);
  } finally {
    if (daemon && daemon.exitCode === null) { daemon.kill('SIGTERM'); await new Promise<void>(resolve => daemon!.once('exit', () => resolve())); }
    rmSync(root, { recursive: true, force: true });
  }
}
async function post(origin: string, token: string, body: unknown, query = '') {
  const response = await fetch(origin + route + query, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  expect(response?.headers.get('x-o8d-native'), 'Native route was not reached: ' + route + query).toBe('1');
  return response!;
}
it('native session-rule mutations work with Node stopped', async () => fixture(async (origin, root, token) => {
  const made = await post(origin, token, { threadId: 'thoughts-review', text: ' Hold merges ', constraint: 'no_merge' });
  expect(made.status).toBe(200); const { rule } = (await made.json()).result;
  expect(rule).toMatchObject({ threadId: 'thoughts-review', text: 'Hold merges', constraint: 'no_merge', active: true });
  const removed = await fetch(origin + route + '?id=' + rule.id, { method: 'DELETE', headers: { authorization: 'Bearer ' + token } });
  expect(removed.headers.get('x-o8d-native')).toBe('1'); expect(await removed.json()).toEqual({ ok: true, result: { removed: true } });
  const db = new Database(join(root, 'cortex-ide.db'), { readonly: true }); expect(db.prepare('SELECT count(*) n FROM session_rules').get()).toEqual({ n: 0 }); db.close();
}), 120000);
it('native correction hold commits atomically, replays and refuses mismatches', async () => fixture(async (origin, root, token) => {
  const body = { id: 'correction-native-hold', repoPath: join(root, 'fixture-repo'), threadId: 'thoughts-review', payload: { message: 'Hold this merge', mode: 'send', holdMerges: true, targets: [] }, fences: [{ scope: 'parent:' + join(root, 'fixture-repo') + '\nthoughts-review', version: 0 }] };
  const response = await post(origin, token, body, '?operation=correction-hold'); expect(response.status).toBe(200); const receipt = (await response.json()).result;
  const db = new Database(join(root, 'cortex-ide.db'), { readonly: true });
  expect(db.prepare('SELECT id FROM session_rules WHERE id=?').get(receipt.ruleId)).toEqual({ id: receipt.ruleId });
  expect(db.prepare('SELECT rule_id FROM worker_corrections WHERE id=?').get(body.id)).toEqual({ rule_id: receipt.ruleId }); db.close();
  expect((await (await post(origin, token, body, '?operation=correction-hold')).json()).result).toEqual(receipt);
  expect((await post(origin, token, { ...body, payload: { ...body.payload, message: 'different' } }, '?operation=correction-hold')).status).toBe(409);
}), 120000);
it('failed correction insert rolls back the preceding rule insert', async () => fixture(async (origin, root, token) => {
  const db = new Database(join(root, 'cortex-ide.db'));
  db.exec("CREATE TRIGGER correction_fixture_abort BEFORE INSERT ON worker_corrections BEGIN SELECT RAISE(ABORT, 'fixture correction insert failure'); END");
  const response = await post(origin, token, { id: 'correction-failed-hold', repoPath: join(root, 'fixture-repo'), threadId: 'thoughts-review', payload: { message: 'Must roll back', mode: 'send', holdMerges: true, targets: [] }, fences: [{ scope: 'parent:' + join(root, 'fixture-repo') + '\nthoughts-review', version: 0 }] }, '?operation=correction-hold');
  expect(response.status).toBe(500);
  for (const table of ['session_rules', 'worker_corrections', 'worker_correction_deliveries', 'workspace_lifecycle_leases']) expect(db.prepare('SELECT count(*) n FROM ' + table).get()).toEqual({ n: 0 }); db.close();
}), 120000);

it('operator gate refusals never reach a session-rule write', async () => fixture(async (origin, root, token) => {
  for (const headers of [{ authorization: 'Bearer wrong' }, { authorization: 'Bearer o8ro_fixture' }, { authorization: 'Bearer ' + token, host: 'foreign.invalid' }] as Record<string, string>[]) {
    const status = await new Promise<number>(resolve => {
      const req = rawRequest(origin + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode ?? 0)); });
      req.once('error', () => resolve(0)); req.setTimeout(10000, () => req.destroy()); req.end(JSON.stringify({ threadId: 'thoughts-review', text: 'must refuse' }));
    });
    expect(status === 0 || status >= 400).toBe(true);
  }
  const db = new Database(join(root, 'cortex-ide.db'), { readonly: true }); expect(db.prepare('SELECT count(*) n FROM session_rules').get()).toEqual({ n: 0 }); db.close();
}), 120000);

it('changed stop fences refuse the entire native correction transaction', async () => fixture(async (origin, root, token) => {
  const response = await post(origin, token, { id: 'fenced-correction-hold', repoPath: join(root, 'fixture-repo'), threadId: 'thoughts-review', payload: { message: 'Must refuse', mode: 'send', holdMerges: true, targets: [] }, fences: [{ scope: 'parent:' + join(root, 'fixture-repo') + '\nthoughts-review', version: 1 }] }, '?operation=correction-hold');
  expect(response.status).toBe(409); expect((await response.json()).error.message).toContain('stopped during correction preparation');
  const db = new Database(join(root, 'cortex-ide.db'), { readonly: true }); for (const table of ['session_rules','worker_corrections','worker_correction_deliveries']) expect(db.prepare('SELECT count(*) n FROM ' + table).get()).toEqual({ n: 0 }); db.close();
}), 120000);

it('operator mutation responses match the real TypeScript route in an isolated classic oracle', async () => fixture(async (origin, root, token) => {
  const oracle = realpathSync(mkdtempSync(join(tmpdir(), 'o8-session-rule-oracle-')));
  try {
    await seedSessionFixture(oracle); writeFileSync(join(oracle, 'ws-token'), token); writeFileSync(join(oracle, 'session-rule-oracle-owner'), 'classic-only');
    for (const body of [{}, { threadId: 'thoughts-review' }, { threadId: 'thoughts-review', text: 'x', constraint: 'bad' }, { threadId: ' thoughts-review ', text: '  native parity  ', constraint: 'no_merge' }, { threadId: 'thoughts-review', text: 'a'.repeat(1999) + '𝒳', constraint: null }]) {
      const response = await post(origin, token, body); const actual = { status: response.status, cache: response.headers.get('cache-control'), type: response.headers.get('content-type'), body: await response.json() };
      writeFileSync(join(oracle, 'session-rule-oracle-input.json'), JSON.stringify({ method: 'POST', body, rule: actual.body.result?.rule }));
      await promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'tests/fixtures/o8d-session-rule-oracle.ts'], { env: { ...process.env, O8_API_FRONT_DOOR: undefined, O8_DATA_DIR: undefined, CORTEX_IDE_DATA_DIR: oracle, CORTEX_IDE_DB_PATH: join(oracle, 'cortex-ide.db') } });
      expect(actual).toEqual(JSON.parse(readFileSync(join(oracle, 'session-rule-oracle-output.json'), 'utf8')));
    }
  } finally { rmSync(oracle, { recursive: true, force: true }); }
}), 120000);
