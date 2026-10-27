import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { createRetainedGeneratedOutputFixture } from './generated-output-fixture';

const source = process.cwd();
const require = createRequire(import.meta.url);
const url = (file: string) => JSON.stringify(pathToFileURL(path.join(source, file)).href);

it.each(['postship', 'rebuild'] as const)('preserves legacy inventory without writer proof through the real %s entry', async operation => {
  const root = await createRetainedGeneratedOutputFixture('o8-legacy-build-proof-');
  const repo = path.join(root, 'repo'); const data = path.join(root, 'data');
  mkdirSync(repo); mkdirSync(data); mkdirSync(path.join(repo, '.fixture'));
  mkdirSync(path.join(repo, 'node_modules/next/dist/bin'), { recursive: true });
  writeFileSync(path.join(repo, 'package.json'), '{"name":"o8","version":"0.0.0"}');
  writeFileSync(path.join(repo, '.gitignore'), '.next\nout\nnode_modules\n.fixture\n.o8-generated-output-store\n');
  writeFileSync(path.join(repo, 'node_modules/next/dist/bin/next'), `
    const fs = require('node:fs'); const output = process.env.O8_RELEASE_NEXT_DIST_DIR;
    fs.writeFileSync(output + '/BUILD_ID', 'retained legacy compiler bytes');
    fs.mkdirSync('out', {recursive:true}); fs.writeFileSync('out/server.js', 'verified fixture artifact');
    fs.appendFileSync('.fixture/builds','build\\n');
  `);
  for (const args of [['init', '-q', '--initial-branch=main'], ['add', '.'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']]) {
    expect(spawnSync('git', args, { cwd: repo }).status).toBe(0);
  }
  const env = { ...process.env, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
    CORTEX_IDE_DB_PATH: path.join(data, 'fixture.db'), TSX_TSCONFIG_PATH: path.join(source, 'tsconfig.json') };
  const imports = ['--import', path.join(source, 'scripts/register-server-only-stub.mjs'), '--import', require.resolve('tsx')];
  const build = `
    const producer = await import(${url('src/lib/workspace/generated-output-producer.ts')});
    const build = await import(${url('scripts/lib/registered-build.mjs')});
    const code = await (producer.default ?? producer).runGeneratedOutputPrebuild({workspacePath:process.cwd(),preflight(){},
      operation:context => context.runBuild(run => build.runRegisteredBuild(run))});
    if(code) throw new Error('Fixture compiler failed');
    const artifact = await import(${url('scripts/lib/release-artifacts.mjs')});
    artifact.writeReleaseArtifactManifest(process.cwd(),artifact.collectReleaseArtifactRecipe(process.cwd(),'0.0.0'));
  `;
  const first = spawnSync(process.execPath, [...imports, '--input-type=module', '-e', build], { cwd: repo, env, encoding: 'utf8', timeout: 60_000 });
  expect(first.status, first.stdout + first.stderr).toBe(0);
  const file = path.join(repo, '.next/BUILD_ID'); const original = lstatSync(file);
  // Represent the persisted schema written by the closed branch. The real
  // compiler, creator authority, child closes and artifact proof stay intact.
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const database = new Database(path.join(data, 'fixture.db'));
  try {
    const row = database.prepare('SELECT rowid, payload_json FROM workspace_generated_outputs').get() as { rowid: number; payload_json: string };
    const resource = JSON.parse(row.payload_json); delete resource.buildOwnership.proof;
    database.prepare('UPDATE workspace_generated_outputs SET payload_json = ? WHERE rowid = ?').run(JSON.stringify(resource), row.rowid);
  } finally { database.close(); }
  const result = operation === 'postship'
    ? spawnSync(process.execPath, [...imports, path.join(source, 'scripts/generated-output-run.ts'), 'postship'], { cwd: repo, env, encoding: 'utf8', timeout: 60_000 })
    : spawnSync(process.execPath, [...imports, '--input-type=module', '-e', build], { cwd: repo, env, encoding: 'utf8', timeout: 60_000 });
  writeFileSync(path.join(root, 'operation.log'), result.stdout + result.stderr);
  expect(existsSync(file), 'legacy inventory cannot grant ownership retrospectively').toBe(true);
  expect(lstatSync(file).ino).toBe(original.ino);
  expect(readFileSync(file, 'utf8')).toBe('retained legacy compiler bytes');
  expect(readFileSync(path.join(repo, '.fixture/builds'), 'utf8')).toBe('build\n');
  expect(result.stdout + result.stderr).toMatch(/preserv|writer proof|unowned/i);
}, 120_000);
