import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { createRetainedGeneratedOutputFixture } from './generated-output-fixture';
import { RUNTIME_INPUT_FILES } from './helpers/packaged-runtime-inputs';

const source = process.cwd();
const require = createRequire(import.meta.url);
const moduleUrl = (file: string) => JSON.stringify(pathToFileURL(path.join(source, file)).href);

it.each([
  { target: 'BUILD_ID', label: 'BUILD_ID', bytes: 'unrelated writer bytes' },
  { target: 'standalone/.env', label: 'standalone/.env', bytes: 'unrelated writer bytes' },
  { target: 'BUILD_ID', label: 'identical BUILD_ID', bytes: 'compiler generation' },
  { target: 'standalone/server.js', label: 'standalone/server.js', bytes: 'unrelated server bytes' },
])(
  'preserves and reports an unrelated writer replacing reserved $label before compiler completion', async ({ target, bytes }) => {
    const root = await createRetainedGeneratedOutputFixture('o8-delete-ownership-');
    const repo = path.join(root, 'repo'); const data = path.join(root, 'data');
    mkdirSync(repo); mkdirSync(data); mkdirSync(path.join(repo, '.fixture'));
    mkdirSync(path.join(repo, 'scripts')); mkdirSync(path.join(repo, 'node_modules/next/dist/bin'), { recursive: true });
    writeFileSync(path.join(repo, 'package.json'), '{"name":"o8","version":"0.0.0"}');
    writeFileSync(path.join(repo, '.gitignore'), '.next\nout\nnode_modules\n.fixture\n.o8-generated-output-store\n');
    writeFileSync(path.join(repo, 'scripts/bust-stale-patch-cache.mjs'), 'process.exit(0);');
    writeFileSync(path.join(repo, 'node_modules/next/dist/bin/next'), `
      const fs = require('node:fs'); const output = process.env.O8_RELEASE_NEXT_DIST_DIR;
      fs.mkdirSync(output + '/standalone', { recursive: true });
      for (const [file, contents] of Object.entries(${JSON.stringify(RUNTIME_INPUT_FILES)})) {
        const target = require('node:path').join(output, 'standalone', file);
        fs.mkdirSync(require('node:path').dirname(target), { recursive: true }); fs.writeFileSync(target, contents);
      }
      fs.writeFileSync(output + '/BUILD_ID', 'compiler generation');
      fs.writeFileSync(output + '/standalone/server.js', 'const config = ' + JSON.stringify({distDir:output}));
      fs.mkdirSync('out'); fs.writeFileSync('out/server.js', 'verified fixture artifact');
      fs.writeFileSync('.fixture/ready', output);
      const interval = setInterval(() => {
        if (fs.existsSync('.fixture/continue')) clearInterval(interval);
      }, 5);
    `);
    for (const args of [['init', '-q', '--initial-branch=main'], ['add', '.'],
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
        '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']]) {
      const result = spawnSync('git', args, { cwd: repo }); expect(result.status).toBe(0);
    }
    const env = { ...process.env, O8_DATA_DIR:data, CORTEX_IDE_DATA_DIR:data,
      CORTEX_IDE_DB_PATH:path.join(data, 'fixture.db'), TSX_TSCONFIG_PATH:path.join(source, 'tsconfig.json') };
    const script = `
      const producer = await import(${moduleUrl('src/lib/workspace/generated-output-producer.ts')});
      const build = await import(${moduleUrl('scripts/lib/registered-build.mjs')});
      await (producer.default ?? producer).runGeneratedOutputPrebuild({workspacePath:process.cwd(),preflight(){},
        operation:context => context.runBuild(run => build.runRegisteredBuild(run))});
      const artifact = await import(${moduleUrl('scripts/lib/release-artifacts.mjs')});
      artifact.writeReleaseArtifactManifest(process.cwd(),artifact.collectReleaseArtifactRecipe(process.cwd(),'0.0.0'));
    `;
    const imports = ['--import',path.join(source,'scripts/register-server-only-stub.mjs'),'--import',require.resolve('tsx')];
    const child = spawn(process.execPath,[...imports,'--input-type=module','-e',script],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
    let logs = ''; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
    const closed = once(child,'close');
    let foreign: { device:number; inode:number } | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(path.join(repo,'.fixture/ready')),logs).toBe(true),{timeout:30000});
      const output = readFileSync(path.join(repo,'.fixture/ready'),'utf8');
      // A separate, unregistered writer replaces the compiler inode while the
      // admitted compiler is still alive. Renaming prevents inode reuse.
      const writer = spawnSync(process.execPath,['-e',`
        const fs = require('node:fs'); const path = require('node:path');
        const file = process.argv[1];
        if (fs.existsSync(file)) fs.renameSync(file,path.join('.fixture','original-build-id'));
        fs.writeFileSync(file,${JSON.stringify(bytes)});
        const entry=fs.lstatSync(file);process.stdout.write(JSON.stringify({device:entry.dev,inode:entry.ino}));
      `,path.join(repo,output,target)],{cwd:repo,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,NODE_ENV:'test'},encoding:'utf8'});
      expect(writer.status,writer.stderr).toBe(0); foreign = JSON.parse(writer.stdout);
    } finally {
      writeFileSync(path.join(repo,'.fixture/continue'),'continue');
    }
    const [status] = await closed;
    writeFileSync(path.join(root,'build.log'),logs);
    const cleanup = spawnSync(process.execPath,[...imports,path.join(source,'scripts/generated-output-run.ts'),'postship'],
      {cwd:repo,env,encoding:'utf8',timeout:60000});
    writeFileSync(path.join(root,'postship.log'),cleanup.stdout+cleanup.stderr);
    const candidates = [path.join(repo,'.next/.o8-release-build',target),path.join(repo,'.next',target)];
    const kept = candidates.find(file => existsSync(file) && readFileSync(file,'utf8') === bytes);
    expect(kept,'build and postship must preserve the unrelated inode').toBeDefined();
    const actual = lstatSync(kept!); expect({device:actual.dev,inode:actual.ino}).toEqual(foreign);
    expect(status,'unowned compiler output must stop publication').not.toBe(0);
    expect(logs+cleanup.stdout+cleanup.stderr).toMatch(/preserv|ownership|unowned/i);
  },120000,
);

it('admits a delayed native worker before its first write and scrubs only its owned copies', async () => {
  const root = await createRetainedGeneratedOutputFixture('o8-owned-worker-');
  const repo = path.join(root, 'repo'); const data = path.join(root, 'data');
  mkdirSync(repo); mkdirSync(data); mkdirSync(path.join(repo, '.fixture'));
  mkdirSync(path.join(repo, 'node_modules/next/dist/bin'), { recursive: true });
  writeFileSync(path.join(repo, 'package.json'), '{"name":"o8","version":"0.0.0"}');
  writeFileSync(path.join(repo, '.gitignore'), '.next\nnode_modules\n.fixture\n.o8-generated-output-store\n');
  writeFileSync(path.join(repo, '.fixture/delay.cjs'), `
    const fs = require('node:fs'); const read = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
      if (typeof file === 'string' && /^\\/proc\\/\\d+\\/stat$/.test(file) && file !== '/proc/' + process.pid + '/stat') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      }
      return read.call(this, file, ...args);
    };
    if (process.platform === 'darwin') {
      const cp = require('node:child_process'); const exec = cp.execFileSync;
      cp.execFileSync = function (command, args, ...options) {
        if (command === '/bin/ps' && args.at(-1) !== String(process.pid)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
        }
        return exec.call(this, command, args, ...options);
      };
    }
  `);
  writeFileSync(path.join(repo, '.fixture/worker.cjs'), `
    const fs = require('node:fs'); const { finished } = require('node:stream/promises');
    (async () => {
      const output = process.env.O8_RELEASE_NEXT_DIST_DIR;
      fs.mkdirSync(output + '/standalone', { recursive: true });
      for (const [file, contents] of Object.entries(${JSON.stringify(RUNTIME_INPUT_FILES)})) {
        const target = require('node:path').join(output, 'standalone', file);
        fs.mkdirSync(require('node:path').dirname(target), { recursive: true }); fs.writeFileSync(target, contents);
      }
      await fs.promises.writeFile(output + '/BUILD_ID', 'worker build');
      await fs.promises.writeFile(output + '/standalone/.env', 'owned environment');
      await fs.promises.writeFile(output + '/standalone/.env.production', 'owned production environment');
      const handle = await fs.promises.open(output + '/standalone/server.js', 'wx');
      await handle.writeFile('const config = ' + JSON.stringify({ distDir: output })); await handle.close();
      const stream = fs.createWriteStream(output + '/worker-stream');
      stream.end('stream bytes'); await finished(stream);
      fs.writeFileSync('.fixture/helper', 'executable bytes'); fs.chmodSync('.fixture/helper', 0o755);
      await fs.promises.copyFile('.fixture/helper', output + '/standalone/helper');
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
  `);
  writeFileSync(path.join(repo, 'node_modules/next/dist/bin/next'), `
    const { fork } = require('node:child_process');
    fork('.fixture/worker.cjs', [], { stdio: 'inherit' }).once('close', code => { process.exitCode = code || 0; });
  `);
  for (const args of [['init', '-q', '--initial-branch=main'], ['add', '.'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']]) {
    expect(spawnSync('git', args, { cwd: repo }).status).toBe(0);
  }
  const script = `
    const producer = await import(${moduleUrl('src/lib/workspace/generated-output-producer.ts')});
    const build = await import(${moduleUrl('scripts/lib/registered-build.mjs')});
    await (producer.default ?? producer).runGeneratedOutputPrebuild({ workspacePath:process.cwd(),preflight(){},
      operation:context => context.runBuild(run => {
        const wrapped = Object.assign((command,args,env) => run(command,args,{...env,
          NODE_OPTIONS:'--require=' + JSON.stringify(${JSON.stringify(path.join(repo, '.fixture/delay.cjs'))}) + ' ' + env.NODE_OPTIONS}),
          {buildOutput:run.buildOutput});
        return build.runRegisteredBuild(wrapped);
      }) });
  `;
  const result = spawnSync(process.execPath, ['--import', path.join(source, 'scripts/register-server-only-stub.mjs'),
    '--import', require.resolve('tsx'), '--input-type=module', '-e', script], { cwd: repo, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
      CORTEX_IDE_DB_PATH: path.join(data, 'fixture.db'), TSX_TSCONFIG_PATH: path.join(source, 'tsconfig.json') } });
  writeFileSync(path.join(root, 'build.log'), result.stdout + result.stderr);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(readFileSync(path.join(repo, '.next/BUILD_ID'), 'utf8')).toBe('worker build');
  expect(readFileSync(path.join(repo, '.next/worker-stream'), 'utf8')).toBe('stream bytes');
  expect(lstatSync(path.join(repo, '.next/standalone/helper')).mode & 0o777).toBe(0o755);
  expect(readFileSync(path.join(repo, '.next/standalone/server.js'), 'utf8')).toContain('"distDir":".next"');
  expect(existsSync(path.join(repo, '.next/standalone/.env'))).toBe(false);
  expect(existsSync(path.join(repo, '.next/standalone/.env.production'))).toBe(false);
}, 90_000);

it('preserves an unregistered environment file through the ordinary registered build entry point', async () => {
  const root = await createRetainedGeneratedOutputFixture('o8-unmanaged-env-');
  mkdirSync(path.join(root, 'node_modules/next/dist/bin'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{"name":"o8","version":"0.0.0"}');
  writeFileSync(path.join(root, 'node_modules/next/dist/bin/next'),
    "require('node:fs').mkdirSync('.next/standalone',{recursive:true});");
  const script = `
    const {spawnSync} = await import('node:child_process');
    const {runRegisteredBuild} = await import(${moduleUrl('scripts/lib/registered-build.mjs')});
    await runRegisteredBuild(async (command,args,env) => {
      const result = spawnSync(command,args,{env,stdio:'inherit'});
      if (result.status) return result.status;
      const writer = spawnSync(process.execPath,['-e',
        "require('node:fs').writeFileSync('.next/standalone/.env','foreign ordinary-build bytes')"],
        {env:{PATH:process.env.PATH,NODE_ENV:'test'},stdio:'inherit'});
      if (writer.status) throw new Error('Fixture writer failed');
      return 0;
    });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script],
    { cwd: root, env: process.env, encoding: 'utf8', timeout: 30_000 });
  writeFileSync(path.join(root, 'build.log'), result.stdout + result.stderr);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/Preserved unowned standalone\/\.env/);
  expect(readFileSync(path.join(root, '.next/standalone/.env'), 'utf8')).toBe('foreign ordinary-build bytes');
});
