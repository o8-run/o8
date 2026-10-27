import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createRetainedGeneratedOutputFixture } from './generated-output-fixture';

const exec = promisify(execFile);
const source = process.cwd();
const require = createRequire(import.meta.url);
const url = (relative: string) => JSON.stringify(pathToFileURL(path.join(source, relative)).href);

it('disposes thousands of registered output files through the postship runner and admits the next prebuild', async () => {
  const root = await createRetainedGeneratedOutputFixture('o8-postship-large-');
  const repo = path.join(root, 'repo');
  const data = path.join(root, 'data');
  mkdirSync(repo); mkdirSync(data, { mode: 0o700 });
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'o8', version: '0.0.0' }));
  writeFileSync(path.join(repo, '.gitignore'), '.next\nout\n.fixture\n.o8-generated-output-store\n');
  for (const args of [['init', '-q', '--initial-branch=main'], ['add', '.'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']]) await exec('git', args, { cwd: repo });
  const env: NodeJS.ProcessEnv = { ...process.env, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
    CORTEX_IDE_DB_PATH: path.join(data, 'fixture.db'), O8_MASTER_KEY: randomBytes(32).toString('base64url'),
    TSX_TSCONFIG_PATH: path.join(source, 'tsconfig.json') };
  delete env.O8_RELEASE_BUILD_DATA_DIR;
  const times: Record<string, number> = {};
  let sequence = 0;
  async function run(phase: string, args: string[], cwd = repo) {
    const started = performance.now();
    try {
      const result = await exec(process.execPath, args, { cwd, env, timeout: 300_000, maxBuffer: 4 * 1024 ** 2 });
      writeFileSync(path.join(root, `command-${++sequence}.json`), JSON.stringify({ phase, ...result }));
      return result;
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      writeFileSync(path.join(root, `command-${++sequence}.json`), JSON.stringify({ phase,
        stdout: result.stdout, stderr: result.stderr }));
      throw new Error(result.stderr || result.message);
    } finally {
      times[phase] = Math.round(performance.now() - started);
      writeFileSync(path.join(root, 'phase-times.json'), JSON.stringify(times));
      console.log(`[postship-large] ${phase}=${times[phase]}ms`);
    }
  }
  const cold = (phase: string, script: string) => run(phase, ['--import', path.join(source, 'scripts/register-server-only-stub.mjs'),
    '--import', require.resolve('tsx'), '--input-type=module', '-e', script]);
  const producer = `
    const fs = require('node:fs'); const path = require('node:path'); const output = process.argv[1];
    for (let group = 0; group < 192; group++) {
      const directory = path.join(output, 'standalone/node_modules/next/dist/compiled/server/app', 'route-' + group);
      fs.mkdirSync(directory, { recursive: true });
      for (let file = 0; file < 64; file++) fs.writeFileSync(path.join(directory, file + '.js'), Buffer.alloc(4096, 42));
    }
    // Logical build size also covers large caches without allocating gigabytes in the fixture.
    const fd = fs.openSync(path.join(output, 'cache.pack'), 'wx'); fs.ftruncateSync(fd, 6 * 1024 ** 3); fs.closeSync(fd);
    fs.mkdirSync('out'); fs.writeFileSync('out/server.js', 'preserved fixture artifact');
  `;
  const prebuild = `
    const ns = await import(${url('src/lib/workspace/generated-output-producer.ts')});
    const code = await (ns.default ?? ns).runGeneratedOutputPrebuild({ workspacePath: process.cwd(), preflight() {},
      operation: context => context.runBuild(async run => {
        const code = await run(process.execPath, ['-e', ${JSON.stringify(producer)}, run.buildOutput.directory]);
        if (code === 0) await run.buildOutput.complete();
        return code;
      }) });
    if (code !== 0) throw new Error('Fixture producer failed');
  `;
  await cold('producer', prebuild + `
    const artifact = await import(${url('scripts/lib/release-artifacts.mjs')});
    artifact.writeReleaseArtifactManifest(process.cwd(), artifact.collectReleaseArtifactRecipe(process.cwd(), '0.0.0'));
  `);
  const runner = ['--import', path.join(source, 'scripts/register-server-only-stub.mjs'),
    '--import', require.resolve('tsx'), path.join(source, 'scripts/generated-output-run.ts'), 'postship'];
  const unknown = path.join(root, 'unknown');
  mkdirSync(path.join(unknown, '.next'), { recursive: true });
  writeFileSync(path.join(unknown, 'package.json'), '{"name":"o8","version":"0.0.0"}');
  writeFileSync(path.join(unknown, '.next/unregistered'), 'unregistered bytes remain');
  await expect(run('unregistered-refusal', runner, unknown)).rejects.toThrow('unknown lifecycle ownership');
  expect(readFileSync(path.join(unknown, '.next/unregistered'), 'utf8')).toBe('unregistered bytes remain');
  const held = path.join(repo, '.fixture');
  mkdirSync(held);
  renameSync(path.join(repo, '.next'), path.join(held, 'owned-output'));
  mkdirSync(path.join(repo, '.next'));
  writeFileSync(path.join(repo, '.next/foreign'), 'replacement bytes remain');
  await expect(run('replacement-refusal', runner)).rejects.toThrow('ownership changed: inode mismatch');
  expect(readFileSync(path.join(repo, '.next/foreign'), 'utf8')).toBe('replacement bytes remain');
  renameSync(path.join(repo, '.next'), path.join(held, 'foreign-output'));
  renameSync(path.join(held, 'owned-output'), path.join(repo, '.next'));
  const disposed = await run('postship', runner);
  expect(disposed.stdout).toContain('[postship-generated-output] removed');
  expect(existsSync(path.join(repo, '.next'))).toBe(false);
  expect(readFileSync(path.join(held, 'foreign-output/foreign'), 'utf8')).toBe('replacement bytes remain');
  expect(readFileSync(path.join(unknown, '.next/unregistered'), 'utf8')).toBe('unregistered bytes remain');
  expect(readFileSync(path.join(repo, 'out/server.js'), 'utf8')).toBe('preserved fixture artifact');
  const database = new Database(path.join(data, 'fixture.db'), { readonly: true });
  try {
    const rows = database.prepare('SELECT payload_json FROM workspace_generated_outputs').all() as Array<{ payload_json: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload_json)).toMatchObject({ state: 'retired', disposal: { kind: 'postship' } });
    expect(database.prepare('SELECT * FROM workspace_exact_claims').all()).toEqual([]);
    expect(database.prepare('SELECT state FROM workspace_exact_finalizations').all()).toEqual([{ state: 'complete' }]);
  } finally { database.close(); }
  expect((await run('replay', runner)).stdout).toContain('[postship-generated-output] skipped');
  await cold('next-prebuild', `
    const ns = await import(${url('src/lib/workspace/generated-output-producer.ts')});
    await (ns.default ?? ns).runGeneratedOutputPrebuild({ workspacePath: process.cwd(), preflight() {},
      operation: async context => {
        if (!context.canReuse) throw new Error('Disposed generation was not reusable');
        return context.runBuild(run => run(process.execPath, ['-e', "require('node:fs').writeFileSync('.next/next-generation', 'new')"]));
      } });
  `);
  expect(readFileSync(path.join(repo, '.next/next-generation'), 'utf8')).toBe('new');
}, 600_000);
