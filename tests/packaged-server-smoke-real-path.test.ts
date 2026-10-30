import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { smokePackagedServer } from '../scripts/lib/packaged-server-smoke.mjs';
import { stageRuntimeInputs } from './helpers/packaged-runtime-inputs';

const roots: string[] = [];

function fixture(source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'o8-packaged-server-fixture-'));
  roots.push(root);
  stageRuntimeInputs(root);
  writeFileSync(join(root, 'server.js'), source);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('packaged server startup gate', () => {
  it('rejects a module failure from the actual packaged server process', async () => {
    const root = fixture("require('next/dist/compiled/find-up');\n");
    await expect(smokePackagedServer(root, { timeoutMs: 5000 }))
      .rejects.toThrow("Cannot find module 'next/dist/compiled/find-up'");
  });

  it('accepts a server that serves the instance identity on its assigned port', async () => {
    const root = fixture(`const http = require('node:http');
http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({product: 'o8', apiPort: Number(process.env.PORT), bootId: process.env.O8_BOOT_ID, version: 'test'}));
}).listen(Number(process.env.PORT), '127.0.0.1');`);
    await expect(smokePackagedServer(root, { timeoutMs: 5000 }))
      .resolves.toMatchObject({ version: 'test' });
  });

  it.skipIf(process.platform === 'win32')('keeps a supervised smoke server in the caller process group and waits for its exit', async () => {
    const root = fixture(`const http = require('node:http');
const fs = require('node:fs');
const cp = require('node:child_process');
fs.writeFileSync('identity.json', JSON.stringify({pid: process.pid, group: cp.execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], {encoding: 'utf8'}).trim()}));
http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({product: 'o8', apiPort: Number(process.env.PORT), bootId: process.env.O8_BOOT_ID, version: 'supervised'}));
}).listen(Number(process.env.PORT), '127.0.0.1');`);
    await expect(smokePackagedServer(root, { timeoutMs: 5000, supervised: true }))
      .resolves.toMatchObject({ version: 'supervised' });
    const identity = JSON.parse(readFileSync(join(root, 'identity.json'), 'utf8'));
    const group = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
    expect(identity.group).toBe(group);
    expect(() => process.kill(identity.pid, 0)).toThrow();
  });
});
