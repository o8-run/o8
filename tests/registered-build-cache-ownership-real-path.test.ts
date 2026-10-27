import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { createRetainedGeneratedOutputFixture } from './generated-output-fixture';

const source = process.cwd();
const require = createRequire(import.meta.url);
const url = (file: string) => JSON.stringify(pathToFileURL(path.join(source, file)).href);

it.each(['foreign-before-newer-patch', 'foreign-after-restore', 'foreign-after-restore-newer-patch',
  'foreign-during-import', 'changed-restored-file', 'verified-restore', 'verified-restore-newer-patch'])(
  'preserves cache ownership through registered build and postship: %s', async scenario => {
    const root = await createRetainedGeneratedOutputFixture('o8-cache-ownership-');
    const repo = path.join(root, 'repo');
    const data = path.join(root, 'data');
    mkdirSync(repo); mkdirSync(data, { mode: 0o700 });
    mkdirSync(path.join(repo, 'scripts'));
    mkdirSync(path.join(repo, 'node_modules/next/dist/bin'), { recursive: true });
    writeFileSync(path.join(repo, 'package.json'), '{"name":"o8","version":"0.0.0"}');
    writeFileSync(path.join(repo, '.gitignore'), '.next\nout\nnode_modules\npatches\n.o8-generated-output-store\n');
    writeFileSync(path.join(repo, 'scripts/bust-stale-patch-cache.mjs'),
      readFileSync(path.join(source, 'scripts/bust-stale-patch-cache.mjs')));
    writeFileSync(path.join(repo, 'node_modules/next/dist/bin/next'), `
      const fs = require('node:fs');
      const output = process.env.O8_RELEASE_NEXT_DIST_DIR;
      fs.mkdirSync(output + '/cache', { recursive: true });
      fs.writeFileSync(output + '/cache/compiler.pack', 'compiler-owned bytes');
      fs.writeFileSync(output + '/BUILD_ID', 'fixture build');
      fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/server.js', 'verified artifact');
    `);
    for (const args of [['init', '-q', '--initial-branch=main'], ['add', '.'],
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
        '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']]) {
      expect(spawnSync('git', args, { cwd: repo }).status).toBe(0);
    }
    const env = { ...process.env, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
      CORTEX_IDE_DB_PATH: path.join(data, 'fixture.db'),
      TSX_TSCONFIG_PATH: path.join(source, 'tsconfig.json') };
    const script = `
      import * as fs from 'node:fs';
      const ns = await import(${url('src/lib/workspace/generated-output-producer.ts')});
      const build = await import(${url('scripts/lib/registered-build.mjs')});
      const cache = await import(${url('scripts/lib/release-build-cache.mjs')});
      const scenario = ${JSON.stringify(scenario)};
      const identity = { phase: 'web', compatibility: {}, compatibilitySha256: 'fixture-compatible',
        source: { head: 'fixture', tree: 'fixture', worktreeClean: true }, sourceSha256: 'fixture', entrySha256: 'fixture-entry' };
      await (ns.default ?? ns).runGeneratedOutputPrebuild({ workspacePath: process.cwd(), preflight() {},
        operation: context => context.runBuild(async run => {
          fs.mkdirSync('.next/cache/webpack', { recursive: true });
          fs.writeFileSync('.next/cache/webpack/proof.pack', 'verified cache bytes');
          if (scenario === 'foreign-during-import') {
            for (let index = 0; index < 32; index++) fs.writeFileSync('.next/cache/webpack/' + index + '.pack', Buffer.alloc(1024 * 1024, 42));
          }
          let restore;
          if (scenario !== 'foreign-before-newer-patch') {
            const options = { cacheRoot: ${JSON.stringify(path.join(root, 'cache'))}, identity };
            const captured = await cache.captureReleaseBuildCache(process.cwd(), 'web', options);
            if (captured.status !== 'captured') throw new Error('Fixture capture failed: ' + JSON.stringify(captured));
            // Only fixture-created bytes exist here, before the foreign-file injection.
            fs.rmSync('.next/cache', { recursive: true });
            restore = await cache.restoreReleaseBuildCache(process.cwd(), 'web', options);
            if (restore.status !== 'hit_exact') throw new Error('Fixture restore failed: ' + JSON.stringify(restore));
          }
          if (scenario.startsWith('foreign-') && scenario !== 'foreign-during-import') fs.writeFileSync('.next/cache/webpack/operator-note.txt', 'foreign cache bytes');
          if (scenario === 'changed-restored-file') fs.writeFileSync('.next/cache/webpack/proof.pack', 'operator replacement');
          if (scenario.includes('newer-patch')) {
            fs.mkdirSync('patches'); fs.writeFileSync('patches/new.patch', 'new patch');
            fs.utimesSync('.next/cache', new Date(1000), new Date(1000));
          }
          let writer; let closed;
          if (scenario === 'foreign-during-import') {
            const { spawn } = await import('node:child_process');
            writer = spawn(process.execPath, ['-e', "const fs = require('node:fs'); process.stdout.write('ready'); const timer = setInterval(() => { if (!fs.existsSync('.next/.o8-release-build/cache')) return; fs.writeFileSync('.next/cache/webpack/operator-note.txt', 'foreign cache bytes'); clearInterval(timer); }, 1); setTimeout(() => process.exit(79), 30000).unref();"], { stdio: ['ignore', 'pipe', 'inherit'] });
            closed = new Promise(resolve => writer.once('close', resolve));
            await new Promise(resolve => writer.stdout.once('data', resolve));
          }
          try { return await build.runRegisteredBuild(run, { restoredCache: restore?.webOwnership ?? Boolean(restore) }); }
          finally { writer?.kill(); await closed; }
        }) });
      const artifact = await import(${url('scripts/lib/release-artifacts.mjs')});
      artifact.writeReleaseArtifactManifest(process.cwd(), artifact.collectReleaseArtifactRecipe(process.cwd(), '0.0.0'));
    `;
    const imports = ['--import', path.join(source, 'scripts/register-server-only-stub.mjs'),
      '--import', require.resolve('tsx')];
    const built = spawnSync(process.execPath, [...imports, '--input-type=module', '-e', script], {
      cwd: repo, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 ** 2,
    });
    writeFileSync(path.join(root, 'build.log'), built.stdout + built.stderr);
    if (built.status === 0) {
      const cleaned = spawnSync(process.execPath, [...imports, path.join(source, 'scripts/generated-output-run.ts'), 'postship'], {
        cwd: repo, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 ** 2,
      });
      writeFileSync(path.join(root, 'cleanup.log'), cleaned.stdout + cleaned.stderr);
      expect(cleaned.status, cleaned.stdout + cleaned.stderr).toBe(0);
    }
    if (scenario.startsWith('foreign-')) {
      expect(readFileSync(path.join(repo, '.next/cache/webpack/operator-note.txt'), 'utf8')).toBe('foreign cache bytes');
    } else if (scenario === 'changed-restored-file') {
      expect(readFileSync(path.join(repo, '.next/cache/webpack/proof.pack'), 'utf8')).toBe('operator replacement');
    } else {
      expect(built.status, built.stdout + built.stderr).toBe(0);
      expect(existsSync(path.join(repo, '.next/BUILD_ID'))).toBe(false);
      expect(readFileSync(path.join(repo, 'out/server.js'), 'utf8')).toBe('verified artifact');
      return;
    }
    expect(built.status).not.toBe(0);
    expect(built.stderr + built.stdout).toMatch(/preserv|unowned|ownership|changed/i);
  }, 180_000,
);

it('refuses an unmanaged foreign cache before allowing a compiler to invalidate it', async () => {
  const root = await createRetainedGeneratedOutputFixture('o8-unmanaged-cache-');
  writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"0.0.0"}');
  mkdirSync(path.join(root, '.next/cache'), { recursive: true });
  const note = path.join(root, '.next/cache/operator-note.txt');
  writeFileSync(note, 'unmanaged foreign bytes');
  const script = `
    const { runRegisteredBuild } = await import(${url('scripts/lib/registered-build.mjs')});
    await runRegisteredBuild(async () => { throw new Error('Compiler must not start'); });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, env: process.env, encoding: 'utf8', timeout: 30_000,
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('cache invalidation requires a verified build reservation');
  expect(readFileSync(note, 'utf8')).toBe('unmanaged foreign bytes');
});
