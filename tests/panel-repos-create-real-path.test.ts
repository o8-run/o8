import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Real-path test for New project: POST /api/panel/repos { action: 'create' }
 * runs `gh repo create <name> --<visibility> --clone` in the projects folder
 * and registers the clone. A fake `gh` first on PATH records its argv and cwd,
 * then clones (git init) or fails with gh's own message.
 */
const saved = { HOME: process.env.HOME, PATH: process.env.PATH, CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR, O8_DATA_DIR: process.env.O8_DATA_DIR };
const tmpHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-create-test-')));
const bin = path.join(tmpHome, 'bin');
const argvLog = path.join(tmpHome, 'gh-argv.jsonl');
const failure = path.join(tmpHome, 'gh-failure');
process.env.HOME = tmpHome;
process.env.CORTEX_IDE_DATA_DIR = path.join(tmpHome, '.o8-data');
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;
process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
mkdirSync(process.env.CORTEX_IDE_DATA_DIR, { recursive: true });
mkdirSync(bin);
writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (fs.existsSync(${JSON.stringify(failure)})) {
  process.stderr.write(fs.readFileSync(${JSON.stringify(failure)}, 'utf8'));
  process.exit(1);
}
const dest = path.join(process.cwd(), args[2]);
fs.mkdirSync(dest);
execFileSync('git', ['init', '--initial-branch=main'], { cwd: dest, stdio: 'ignore' });
`);
chmodSync(path.join(bin, 'gh'), 0o755);

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmpHome, { recursive: true, force: true });
});
beforeEach(() => { rmSync(argvLog, { force: true }); rmSync(failure, { force: true }); });

async function postRepos(body: unknown) {
  const { POST } = await import('@/app/api/panel/repos/route');
  return POST(new Request('http://127.0.0.1/api/panel/repos', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}
const calls = () => existsSync(argvLog)
  ? readFileSync(argvLog, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[]; cwd: string })
  : [];

describe('POST /api/panel/repos action=create', () => {
  it('creates the repository with gh in the projects folder and registers its clone', async () => {
    const response = await postRepos({ action: 'create', name: 'new-site', visibility: 'private' });
    const data = await response.json() as { error?: string; repo?: { localPath: string; name: string } };
    expect(response.status, data.error).toBe(201);
    const projects = path.join(tmpHome, 'Developer');
    expect(calls()).toEqual([{ args: ['repo', 'create', 'new-site', '--private', '--clone'], cwd: projects }]);
    expect(data.repo?.localPath).toBe(path.join(projects, 'new-site'));
    const store = JSON.parse(readFileSync(path.join(process.env.CORTEX_IDE_DATA_DIR!, 'repos.json'), 'utf8')) as { repos: Array<{ localPath: string }> };
    expect(store.repos.map(repo => repo.localPath)).toContain(path.join(projects, 'new-site'));
  }, 60_000);

  it.each([
    ['gh not signed in', 'To get started with GitHub CLI, please run:  gh auth login\n'],
    ['name taken', 'GraphQL: Name already exists on this account (createRepository)\n'],
  ])('returns gh\'s own message when %s and registers nothing', async (_case, message) => {
    writeFileSync(failure, message);
    const response = await postRepos({ action: 'create', name: 'taken-name', visibility: 'public' });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe(message.trim());
    expect(calls()[0].args).toEqual(['repo', 'create', 'taken-name', '--public', '--clone']);
    expect(existsSync(path.join(tmpHome, 'Developer', 'taken-name'))).toBe(false);
  }, 60_000);

  it('refuses an option-shaped name and an unknown visibility before running gh', async () => {
    expect((await postRepos({ action: 'create', name: '--web', visibility: 'private' })).status).toBe(400);
    expect((await postRepos({ action: 'create', name: 'site', visibility: 'secret' })).status).toBe(400);
    expect((await postRepos({ action: 'create', name: 'site.git', visibility: 'private' })).status).toBe(400);
    expect(calls()).toEqual([]);
  });
});
