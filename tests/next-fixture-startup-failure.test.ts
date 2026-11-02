import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';

const root = mkdtempSync(path.join(tmpdir(), 'o8-fixture-startup-'));
const hook = path.join(root, 'no-sqlite.cjs');
// The same failure as an install that skipped native builds.
writeFileSync(hook, `const Module = require('node:module');
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'better-sqlite3') throw new Error('Could not locate the bindings file');
  return load.call(this, request, ...rest);
};
`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('exits with an error when startup fails, so native tests fail fast', async () => {
  const child = spawn(process.execPath, [
    '--require', hook,
    '--import', './scripts/register-server-only-stub.mjs',
    '--import', 'tsx',
    'scripts/next/dev-server.ts', '--composer', '--shell', '--owned-stdio',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const code = await new Promise<number | string | null>(resolve => {
    const hung = setTimeout(() => { child.kill('SIGKILL'); resolve('still running'); }, 40_000);
    child.once('exit', status => { clearTimeout(hung); resolve(status); });
  });
  expect(code).toBe(1);
  expect(stdout).not.toContain('"origin"');
  expect(stderr).toContain('Could not locate the bindings file');
}, 60_000);
