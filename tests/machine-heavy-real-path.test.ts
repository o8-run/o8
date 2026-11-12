import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeAll, afterAll, expect, it } from 'vitest';

import { build } from 'esbuild';
import { cliBuildOptions } from '../cli/build-options.mjs';
const bundleDir = mkdtempSync(path.join(tmpdir(), 'o8-heavy-cli-'));
const bundle = path.join(bundleDir, 'o8.mjs');
beforeAll(async () => { await build(cliBuildOptions({ outfile: bundle, version: 'test' })); }, 60_000);
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) {
    const file = path.join(dir, 'leases.db');
    if (!existsSync(file)) continue;
    const sqlite = new Database(file);
    const owners = sqlite.prepare('SELECT owner_pid FROM resource_leases').all() as { owner_pid: number }[];
    sqlite.close();
    for (const owner of owners) {
      try { process.kill(-owner.owner_pid, 'SIGKILL'); } catch { /* settled */ }
    }
  }

  for (const child of children.splice(0)) { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* settled */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function runner(dir: string, args: string[], prefix: string[] = [], env: Partial<NodeJS.ProcessEnv> = {}) {
  const child = spawn(process.execPath, [bundle, ...prefix, 'run-heavy', ...args], {
    detached: true, env: { ...process.env, NODE_PATH: path.resolve('node_modules'), O8_MACHINE_LEASE_DIR: dir, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  child.stdout!.on('data', chunk => { output += chunk; });
  child.stderr!.on('data', chunk => { output += chunk; });
  const done = new Promise<number | null>(resolve => child.once('close', resolve));
  return { child, done, output: () => output };
}
async function until(test: () => boolean, output: () => string = () => '') {
  const deadline = Date.now() + 15_000;
  while (!test() && Date.now() < deadline) {
    if (/unknown command/i.test(output())) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  expect(test(), output()).toBe(true);
}
function directory() { const dir = mkdtempSync(path.join(tmpdir(), 'o8-heavy-test-')); dirs.push(dir); return dir; }
const command = (dir: string) => ['--', process.execPath, '-e', 'console.log("entered holder pid " + process.ppid); const timer = setInterval(() => { if (require("fs").existsSync(process.argv[1])) { clearInterval(timer); } }, 25)', path.join(dir, 'release')];
it.skipIf(process.platform === 'win32')('serializes heavy commands and reports queue position', async () => {
  const dir = directory();
  const first = runner(dir, command(dir));
  await until(() => first.output().includes('entered'), first.output);
  const second = runner(dir, command(dir));
  await until(() => second.output().includes('Waiting'), second.output);
  expect(second.output()).toContain('position 1');
  expect(second.output()).not.toContain('entered');
  writeFileSync(path.join(dir, 'release'), '');
  expect(await first.done).toBe(0);
  expect(await second.done).toBe(0);
  expect(second.output()).toContain('entered');
});
it.skipIf(process.platform === 'win32')('reclaims a crashed holder', async () => {
  const dir = directory();
  const first = runner(dir, command(dir));
  await until(() => first.output().includes('entered'), first.output);
  const sqlite = new Database(path.join(dir, 'leases.db'));
  const holder = sqlite.prepare('SELECT owner_pid FROM resource_leases').get() as { owner_pid: number };
  sqlite.close();
  expect(holder).toBeTruthy();
  first.child.kill('SIGKILL');
  process.kill(holder.owner_pid, 'SIGKILL');
  writeFileSync(path.join(dir, 'release'), '');
  await first.done;
  const next = runner(dir, ['--', process.execPath, '-e', 'console.log("recovered")']);
  expect(await next.done).toBe(0);
  expect(next.output()).toContain('recovered');
});
it.skipIf(process.platform === 'win32')('verify:ci refuses a second copy and names the holder before running any checks', async () => {
  const dir = directory();
  const first = runner(dir, ['--resource', 'verify-ci', ...command(dir)]);
  await until(() => first.output().includes('entered'), first.output);
  const second = spawn(process.execPath, ['scripts/verify-ci.mjs'], { detached: true, env: { ...process.env, NODE_PATH: path.resolve('node_modules'), O8_MACHINE_LEASE_DIR: dir, O8_VERIFY_CI_FIXTURE_STOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(second);
  let output = '';
  second.stderr!.on('data', chunk => { output += chunk; });
  const code = await new Promise(resolve => second.once('close', resolve));
  expect(code).toBe(1);
  expect(output).toContain(first.output().match(/holder pid \d+/)![0].replace('holder ', ''));
  expect(output).toContain('--allow-concurrent');
});

it('nested run-heavy executes without waiting on its own lease', async () => {
  const run = runner(directory(), ['--', process.execPath, bundle, 'run-heavy', '--', process.execPath, '-e', 'console.log("nested complete")']);
  expect(await run.done).toBe(0);
  expect(run.output()).toContain('nested complete');
}, 15_000);
it('passes operator stdin to the command', async () => {
  const run = runner(directory(), ['--', process.execPath, '-e', 'process.stdin.once("data", chunk => console.log("input:" + chunk))']);
  run.child.stdin!.end('operator input');
  expect(await run.done).toBe(0);
  expect(run.output()).toContain('input:operator input');
}, 15_000);
it.each([['SIGINT', 130], ['SIGTERM', 143]] as const)('returns signal status and forwards %s once', async (signal, code) => {
  const run = runner(directory(), ['--', process.execPath, '-e', 'let count = 0; for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { console.log("signal:" + ++count); setTimeout(() => process.exit(0), 100); }); console.log("ready"); setInterval(() => {}, 1000)']);
  await until(() => run.output().includes('ready'), run.output);
  process.kill(-run.child.pid!, signal);
  expect(await run.done).toBe(code);
  expect(run.output().match(/signal:/g)).toHaveLength(1);
}, 15_000);
it('prints a heartbeat while queue position remains unchanged', async () => {
  const dir = directory();
  const first = runner(dir, command(dir));
  await until(() => first.output().includes('entered'), first.output);
  const second = runner(dir, command(dir));
  await until(() => second.output().includes('Waiting'), second.output);
  const sqlite = new Database(path.join(dir, 'leases.db'));
  sqlite.exec('CREATE TABLE poll_receipt (at INTEGER); CREATE TRIGGER count_waiter_poll AFTER UPDATE ON resource_lease_waiters BEGIN INSERT INTO poll_receipt VALUES (1); END');
  await new Promise(resolve => setTimeout(resolve, 31_100));
  const polls = (sqlite.prepare('SELECT count(*) AS n FROM poll_receipt').get() as { n: number }).n;
  sqlite.close();
  expect(polls).toBeLessThan(50);

  expect(second.output().match(/Waiting for/g)!.length).toBeGreaterThanOrEqual(2);
  writeFileSync(path.join(dir, 'release'), '');
  expect(await first.done).toBe(0);
  expect(await second.done).toBe(0);
}, 45_000);

it('cancels a queued command with signal status before it starts', async () => {
  const dir = directory();
  const first = runner(dir, command(dir));
  await until(() => first.output().includes('entered'), first.output);
  const queued = runner(dir, ['--', process.execPath, '-e', 'console.log("should not enter")']);
  await until(() => queued.output().includes('Waiting'), queued.output);
  process.kill(-queued.child.pid!, 'SIGINT');
  expect(await queued.done).toBe(130);
  expect(queued.output()).not.toContain('should not enter');
  writeFileSync(path.join(dir, 'release'), '');
  expect(await first.done).toBe(0);
}, 15_000);

it('returns 128 plus the signal when the command terminates itself', async () => {
  const run = runner(directory(), ['--', process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")']);
  expect(await run.done).toBe(143);
}, 15_000);

it('reports inaccessible queue as issue 6009 and does not run the command', async () => {
  const dir = directory();
  chmodSync(dir, 0o500);
  try {
    const run = runner(dir, ['--', process.execPath, '-e', 'console.log("UNQUEUED COMMAND RAN")']);
    expect(await run.done).toBe(1);
    expect(run.output()).toContain('#6009');
    expect(run.output()).toContain('Command was not run');
    expect(run.output()).not.toContain('UNQUEUED COMMAND RAN');
    expect(run.output()).not.toMatch(/EPERM|SQLITE_CANTOPEN/);
  } finally { chmodSync(dir, 0o700); }
}, 15_000);

it('parses run-heavy after global flags without shifting command arguments', async () => {
  const run = runner(directory(), ['--', process.execPath, '-e', 'console.log("global flag complete")'], ['--human']);
  expect(await run.done).toBe(0);
  expect(run.output()).toContain('global flag complete');
});
it.each(['1', '99999999', 'unrelated-supervisor'])('does not trust unbound nested marker %s', async marker => {
  const dir = directory();
  const first = runner(dir, command(dir));
  await until(() => first.output().includes('entered'), first.output);
  const sqlite = new Database(path.join(dir, 'leases.db'));
  const owner = sqlite.prepare('SELECT owner_pid FROM resource_leases').get() as { owner_pid: number };
  sqlite.close();
  const second = runner(dir, command(dir), [], { O8_RUN_HEAVY_ACTIVE: marker === 'unrelated-supervisor' ? String(owner.owner_pid) : marker });
  await until(() => second.output().includes('Waiting'), second.output);
  expect(second.output()).not.toContain('entered');
  writeFileSync(path.join(dir, 'release'), '');
  expect(await first.done).toBe(0);
  expect(await second.done).toBe(0);
}, 15_000);
