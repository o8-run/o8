import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { prepareCliShim, SHIMMED_CLIS } from '../scripts/next/cli-shim';
import { startTerminalFixture } from '../scripts/next/terminal-fixture';

const token = 'fixture-cli-shim-token';
let root: string;
let decoys: string;
let fixture: Awaited<ReturnType<typeof startTerminalFixture>>;
const previousPath = process.env.PATH;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-cli-shim-')));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  // A "real" provider CLI the machine's PATH would find first.
  decoys = join(root, 'machine-bin');
  mkdirSync(decoys);
  for (const name of SHIMMED_CLIS) {
    writeFileSync(join(decoys, name), '#!/bin/sh\necho machine CLI\n');
    chmodSync(join(decoys, name), 0o755);
  }
  process.env.PATH = `${decoys}:${previousPath}`;
  const shim = prepareCliShim(root);
  fixture = await startTerminalFixture(root, repo, 9, token, ['cortex-cli-shim-fixture'], shim);
}, 90_000);
afterAll(async () => {
  process.env.PATH = previousPath;
  await fixture?.close();
  rmSync(root, { recursive: true, force: true });
});

it('a fixture login shell runs the stand-in CLIs, never the machine ones', async () => {
  const out = join(root, 'resolved.txt');
  const bin = join(root, 'cli-shim', 'bin');
  // Each CLI runs only once it resolved to the stand-in, so a broken shim can
  // never start a machine CLI from this test.
  const command = SHIMMED_CLIS.map(name => `p=$(command -v ${name}); echo "$p"; `
    + `if [ "$p" = '${bin}/${name}' ]; then ${name} resume 0199-shim-check; else echo 'not run'; fi`).join('; ');
  const response = await fetch(`http://127.0.0.1:${fixture.port}/terminal-spawn`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionName: 'cortex-cli-shim-check', shellCommand: `(${command}) </dev/null > '${out}' 2>&1`,
      cwd: join(root, 'repo'), cols: 80, rows: 24 }),
  });
  expect(response.status).toBe(200);
  const deadline = Date.now() + 30_000;
  while (!(existsSync(out) && readFileSync(out, 'utf8').split('\n').filter(Boolean).length >= 4)) {
    expect(Date.now(), existsSync(out) ? readFileSync(out, 'utf8') : 'no output yet').toBeLessThan(deadline);
    await new Promise(ready => setTimeout(ready, 50));
  }
  expect(readFileSync(out, 'utf8').split('\n').filter(Boolean)).toEqual([
    join(bin, 'codex'), 'fixture codex stand-in: resume 0199-shim-check',
    join(bin, 'claude'), 'fixture claude stand-in: resume 0199-shim-check',
  ]);
}, 60_000);
