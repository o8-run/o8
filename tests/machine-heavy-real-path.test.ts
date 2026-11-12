import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  for (const child of children) { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* settled */ } }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function runner(dir: string, args: string[]) {
  const child = spawn(process.execPath, [bundle, 'run-heavy', ...args], {
    detached: true, env: { ...process.env, NODE_PATH: path.resolve('node_modules'), O8_MACHINE_LEASE_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
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
  const second = spawn(process.execPath, ['scripts/verify-ci.mjs'], { detached: true, env: { ...process.env, NODE_PATH: path.resolve('node_modules'), O8_MACHINE_LEASE_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(second);
  let output = '';
  second.stderr!.on('data', chunk => { output += chunk; });
  const code = await new Promise(resolve => second.once('close', resolve));
  expect(code).toBe(1);
  expect(output).toContain(first.output().match(/holder pid \d+/)![0].replace('holder ', ''));
  expect(output).toContain('--allow-concurrent');
});
