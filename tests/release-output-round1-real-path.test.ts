import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { createRetainedGeneratedOutputFixture } from './generated-output-fixture';
import { RUNTIME_INPUT_FILES } from './helpers/packaged-runtime-inputs';

const source = process.cwd();
const require = createRequire(import.meta.url);
const url = (file: string) => JSON.stringify(pathToFileURL(path.join(source, file)).href);

async function fixture(scrubRace = false) {
  const root = await createRetainedGeneratedOutputFixture('o8-output-round1-');
  const repo = path.join(root, 'repo'); const data = path.join(root, 'data');
  mkdirSync(repo); mkdirSync(data); mkdirSync(path.join(repo, '.fixture'));
  mkdirSync(path.join(repo, 'node_modules/next/dist/bin'), { recursive: true });
  writeFileSync(path.join(repo, 'package.json'), '{"name":"o8","version":"0.0.0"}');
  writeFileSync(path.join(repo, '.gitignore'), '.next\nout\nnode_modules\n.fixture\n.o8-generated-output-store\n');
  writeFileSync(path.join(repo, 'node_modules/next/dist/bin/next'), `
    const fs = require('node:fs'); const output = process.env.O8_RELEASE_NEXT_DIST_DIR;
    fs.mkdirSync(output + '/standalone', {recursive:true});
    for (const [file, contents] of Object.entries(${JSON.stringify(RUNTIME_INPUT_FILES)})) {
      const target = require('node:path').join(output, 'standalone', file);
      fs.mkdirSync(require('node:path').dirname(target), { recursive: true }); fs.writeFileSync(target, contents);
    }
    fs.mkdirSync(output + '/cache', {recursive:true});
    fs.writeFileSync(output + '/BUILD_ID', 'owned build');
    fs.writeFileSync(output + '/cache/compiler.pack', 'owned cache');
    fs.writeFileSync(output + '/standalone/server.js', 'const config = ' + JSON.stringify({distDir:output}));
    ${scrubRace ? "fs.writeFileSync(output + '/standalone/.env', 'owned environment');" : ''}
    fs.mkdirSync('out'); fs.writeFileSync('out/server.js', 'verified fixture artifact');
  `);
  for (const args of [['init', '-q', '--initial-branch=main'], ['add', '.'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']]) {
    expect(spawnSync('git', args, { cwd: repo }).status).toBe(0);
  }
  const env = { ...process.env, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
    CORTEX_IDE_DB_PATH: path.join(data, 'fixture.db'), TSX_TSCONFIG_PATH: path.join(source, 'tsconfig.json') };
  const imports = ['--import', path.join(source, 'scripts/register-server-only-stub.mjs'), '--import', require.resolve('tsx')];
  const race = `
    const fs = (await import('node:module')).createRequire(import.meta.url)('node:fs');
    const cp = (await import('node:module')).createRequire(import.meta.url)('node:child_process');
    const target = process.cwd() + '/.next/.o8-release-build/standalone/.env';
    let replaced = false;
    const nativeSpawn = cp.spawnSync;
    function replace(file) {
      if (String(file) !== target || replaced) return;
      replaced = true;
      const actor = nativeSpawn(process.execPath,['-e',
        "const fs=require('node:fs');fs.renameSync(process.argv[1],'.fixture/original-env');fs.writeFileSync(process.argv[1],'foreign scrub bytes');const s=fs.lstatSync(process.argv[1]);fs.writeFileSync('.fixture/foreign.json',JSON.stringify({device:s.dev,inode:s.ino}));",target],
        {env:{PATH:process.env.PATH,NODE_ENV:'test'},encoding:'utf8'});
      if(actor.status)throw new Error(actor.stderr);
    }
    for (const method of ['unlinkSync','renameSync']) {
      const original = fs[method];
      fs[method] = (file,...args) => {
        replace(file);
        return original(file,...args);
      };
    }
    cp.spawnSync = (command,args,options) => {
      if(command.endsWith('/capture'))replace(args[0]);
      return nativeSpawn(command,args,options);
    };
  `;
  const script = `
    ${scrubRace ? race : ''}
    const producer = await import(${url('src/lib/workspace/generated-output-producer.ts')});
    const build = await import(${url('scripts/lib/registered-build.mjs')});
    const code = await (producer.default ?? producer).runGeneratedOutputPrebuild({workspacePath:process.cwd(),preflight(){},
      operation:context => context.runBuild(run => build.runRegisteredBuild(run))});
    if(code) throw new Error('Fixture compiler failed');
    const artifact = await import(${url('scripts/lib/release-artifacts.mjs')});
    artifact.writeReleaseArtifactManifest(process.cwd(),artifact.collectReleaseArtifactRecipe(process.cwd(),'0.0.0'));
  `;
  const built = spawnSync(process.execPath, [...imports, '--input-type=module', '-e', script],
    { cwd: repo, env, encoding: 'utf8', timeout: 60_000 });
  writeFileSync(path.join(root, 'build.log'), built.stdout + built.stderr);
  const postship = () => {
    const result = spawnSync(process.execPath, [path.join(source, 'scripts/postship-cleanup.mjs')],
      { cwd: repo, env, encoding: 'utf8', timeout: 60_000 });
    writeFileSync(path.join(root, 'postship.log'), result.stdout + result.stderr);
    return result;
  };
  return { root, repo, built, postship };
}

it('registered scrub preserves a replacement at the native removal boundary', async () => {
  const { repo, built } = await fixture(true);
  const file = path.join(repo, '.next/.o8-release-build/standalone/.env');
  expect(existsSync(path.join(repo, '.fixture/foreign.json')), built.stdout + built.stderr).toBe(true);
  expect(existsSync(file), 'the unlink must not delete the replacement inode').toBe(true);
  expect(readFileSync(file, 'utf8')).toBe('foreign scrub bytes');
  const actual = lstatSync(file);
  expect({ device: actual.dev, inode: actual.ino }).toEqual(JSON.parse(readFileSync(path.join(repo, '.fixture/foreign.json'), 'utf8')));
  expect(built.status, 'a scrub that preserved a changed entry must fail the build').not.toBe(0);
  expect(built.stdout + built.stderr).toMatch(/preserved.*\.env.*(changed|ownership)/i);
}, 120_000);

it.each([true, false])('postship clears owned output and names retained entries with replaced BUILD_ID=%s', async replaced => {
  const { repo, built, postship } = await fixture();
  expect(built.status, built.stdout + built.stderr).toBe(0);
  const kept = ['cache/operator-note.txt', 'standalone/.env'];
  if (replaced) {
    renameSync(path.join(repo, '.next/BUILD_ID'), path.join(repo, '.fixture/original-build-id'));
    writeFileSync(path.join(repo, '.next/BUILD_ID'), 'foreign build identity');
    kept.push('BUILD_ID');
  }
  writeFileSync(path.join(repo, '.next/cache/operator-note.txt'), 'foreign cache bytes');
  writeFileSync(path.join(repo, '.next/standalone/.env'), 'foreign environment bytes');
  const originals = kept.map(relative => ({ relative, stat: lstatSync(path.join(repo, '.next', relative)),
    bytes: readFileSync(path.join(repo, '.next', relative), 'utf8') }));
  const result = postship();
  for (const { relative, stat, bytes } of originals) {
    const file = path.join(repo, '.next', relative);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(lstatSync(file).ino).toBe(stat.ino);
    expect(lstatSync(file).dev).toBe(stat.dev);
  }
  for (const relative of ['cache/compiler.pack', 'standalone/server.js', ...(replaced ? [] : ['BUILD_ID'])]) {
    expect(existsSync(path.join(repo, '.next', relative)), `owned ${relative} must still be cleaned`).toBe(false);
  }
  expect(result.status, result.stdout + result.stderr).toBe(0);
  for (const relative of kept) {
    const line = (result.stdout + result.stderr).split('\n').find(value => value.includes('.next/' + relative));
    expect(line, `${relative} must be named with its preservation reason`).toMatch(/kept.*(not.*inventory|identity.*changed|ownership.*changed)/i);
  }
  expect(readFileSync(path.join(repo, 'out/server.js'), 'utf8')).toBe('verified fixture artifact');
}, 120_000);
