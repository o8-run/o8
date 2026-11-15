import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

const exec = promisify(execFile);
const binary = process.env.O8D_BINARY ?? process.env.O8D_TEST_BINARY
  ?? join(process.cwd(), 'crates/o8d/target/debug', process.platform === 'win32' ? 'o8d.exe' : 'o8d');
let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
beforeAll(async () => {
  if (!process.env.O8D_BINARY && !process.env.O8D_TEST_BINARY) {
    await exec('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-ws']);
  }
  server = await startParityReference({ o8d: true, binary, nativeHttp: true, startupTimeoutMs: 120_000 });
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  await server.stopNext();
}, 180_000);
afterAll(async () => { await server?.stop(); });

it('binds native lane change maps to the displayed diff and rejects later tracked edits', async () => {
  const repo = join(server.directory, 'lane-change-map');
  mkdirSync(repo);
  const git = async (...args: string[]) => (await exec('git', ['-C', repo, ...args])).stdout.trim();
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Review fixture');
  await git('config', 'user.email', 'review@example.test');
  writeFileSync(join(repo, 'core.ts'), 'export const core = 1;\n');
  await git('add', '.');
  await git('commit', '-m', 'test: lane map base');
  const baseCommit = await git('rev-parse', 'HEAD');
  await git('checkout', '-b', 'lane-map-review');
  const entry = join(repo, 'entry.ts');
  writeFileSync(entry, "import { core } from './core';\nexport const entry = core;\n");
  await git('add', '.');
  await git('commit', '-m', 'test: lane map head');
  const seeded = await exec(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--eval', `
    (async () => {
      const { addRepo } = require('./src/lib/repos/registry.ts');
      const { createLane } = require('./src/lib/lane/registry.ts');
      const repo = process.env.O8_MAP_FIXTURE_REPO;
      await addRepo(repo);
      const lane = createLane({ repoPath: repo, worktreePath: repo, branch: 'lane-map-review',
        baseBranch: 'main', baseCommit: process.env.O8_MAP_FIXTURE_BASE, runtime: 'codex',
        packetId: 'fixture-native-lane-map', ownership: 'managed' });
      console.log(JSON.stringify({ laneId: lane.id }));
      require('./src/lib/db/index.ts').closeDb();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { env: { ...process.env, O8_DATA_DIR: server.directory, CORTEX_IDE_DATA_DIR: server.directory,
    CORTEX_IDE_DB_PATH: join(server.directory, 'cortex-ide.db'), WS_TOKEN: server.token,
    O8_MAP_FIXTURE_REPO: repo, O8_MAP_FIXTURE_BASE: baseCommit } });
  const { laneId } = JSON.parse(seeded.stdout.split('\n').find(line => line.startsWith('{"laneId":'))!);
  const headers = { authorization: `Bearer ${server.token}` };
  const diff = await fetch(`${origin}/api/lanes/${laneId}/diff`, { headers });
  expect(diff.status).toBe(200);
  const shown = await diff.json();
  expect(shown.revision).toMatch(/^[a-f0-9]{64}$/);
  const map = (revision: string) => fetch(`${origin}/api/review/architecture-delta?${new URLSearchParams({
    lane: laneId, expectedRevision: revision,
  })}`, { headers });
  const bound = await map(shown.revision);
  expect(bound.status).toBe(200);
  expect(await bound.json()).toMatchObject({ status: 'ready', reviewRevision: shown.revision,
    summary: { changedModules: 1, addedEdges: 1 } });
  writeFileSync(entry, "import { core } from './core';\nexport const entry = core + 1;\n");
  expect((await map(shown.revision)).status).toBe(409);
  const refreshed = await fetch(`${origin}/api/lanes/${laneId}/diff`, { headers });
  expect(refreshed.status).toBe(200);
  const latest = await refreshed.json();
  expect(latest.revision).not.toBe(shown.revision);
  const current = await map(latest.revision);
  expect(current.status).toBe(200);
  expect(await current.json()).toMatchObject({ status: 'ready', reviewRevision: latest.revision });
});
