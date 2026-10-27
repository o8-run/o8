import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createRetainedGeneratedOutputFixture } from './generated-output-fixture';

const source = process.cwd();
const require = createRequire(import.meta.url);

it('journals postship disposal and reuses the verified artifact across later prebuilds', async () => {
  const root = await createRetainedGeneratedOutputFixture('o8-postship-lifecycle-');
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const scripts = path.join(repo, 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(home);
  mkdirSync(path.join(repo, '.fixture'));
  writeFileSync(path.join(repo, '.gitignore'), '.next\nout\nnode_modules\n.fixture\n.o8-generated-output-store\no8.release.json\n.env*\n.claude\n');
  const outside = path.join(root, 'sibling-checkout');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'keep'), 'outside sentinel');
  mkdirSync(path.join(repo, '.claude/worktrees'), { recursive: true });
  symlinkSync(outside, path.join(repo, '.claude/worktrees/plugin'), 'dir');
  for (const name of ['.env', '.env.production']) writeFileSync(path.join(repo, name), 'SYNTHETIC_FIXTURE=preserve-source');
  const publicClientKey = 'pk_test_release_config_only';
  const releaseConfigPath = path.join(repo, 'o8.release.json');
  const releaseConfig = JSON.stringify({ clerkPublishableKey: publicClientKey });
  writeFileSync(releaseConfigPath, releaseConfig);
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'o8', version: '0.0.0',
    scripts: { build: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(source, 'scripts/build.mjs'))}` } }));
  // Real callers, guard, recipe, manifest, cache and native producer; only expensive
  // compiler/export/smoke payloads are stand-ins. No containing manager is seeded.
  mkdirSync(path.join(scripts, 'lib'));
  for (const name of ['preship-cleanup.mjs', 'lib/generated-output-producer-check.mjs', 'bust-stale-patch-cache.mjs']) {
    writeFileSync(path.join(scripts, name), readFileSync(path.join(source, 'scripts', name)));
  }
  mkdirSync(path.join(scripts, 'next'), { recursive: true });
  for (const name of ['build-speech-local.mjs', 'build-pi-write.mjs', 'next/build-sidecar.mjs']) {
    writeFileSync(path.join(scripts, name), 'process.exit(0);');
  }
  writeFileSync(path.join(scripts, 'tauri-export.mjs'), `
    const fs = await import('node:fs');
    fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/server.js', 'fixture artifact');
  `);
  writeFileSync(path.join(scripts, 'packaged-server-smoke.mjs'), `
    const fs = await import('node:fs');
    if (fs.readFileSync('out/server.js', 'utf8') !== 'fixture artifact') process.exit(78);
    if (process.env.O8_FIXTURE_SMOKE_WAIT) {
      fs.writeFileSync('.fixture/smoke-ready', 'ready');
      const deadline = Date.now() + 120000;
      while (!fs.existsSync('.fixture/smoke-release')) {
        if (Date.now() > deadline) process.exit(79);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    fs.writeFileSync('.fixture/profile.json', JSON.stringify({ modern: process.env.O8_DATA_DIR,
      legacy: process.env.CORTEX_IDE_DATA_DIR, publicClientKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY }));
  `);
  const next = path.join(repo, 'node_modules/next/dist/bin');
  mkdirSync(next, { recursive: true });
  symlinkSync(path.dirname(require.resolve('better-sqlite3/package.json')), path.join(repo, 'node_modules/better-sqlite3'), 'dir');
  writeFileSync(path.join(next, 'next'), `
    const fs = require('node:fs');
    if (process.env.O8_FIXTURE_BUILD_FAILURE) process.exit(42);
    fs.mkdirSync('.next/cache', { recursive: true });
    fs.writeFileSync('.next/cache/proof.bin', 'fixture cache');
    fs.writeFileSync('.next/BUILD_ID', 'native fixture');
    fs.mkdirSync('.next/standalone/.next/server', { recursive: true });
    for (const name of ['.env', '.env.production']) fs.copyFileSync(name, '.next/standalone/' + name);
    fs.writeFileSync('.next/standalone/.next/server/runtime.js', 'runtime');
    fs.appendFileSync('.fixture/compiler-calls', 'build\\n');
  `);
  for (const args of [['init', '--initial-branch=main'], ['add', '.'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  }
  const env = { ...process.env, HOME: home, O8_RELEASE_BUILD_CACHE_DIR: path.join(root, 'cache'),
    O8_RELEASE_BUILD_CACHE_MAX_BYTES: '10485760', O8_RELEASE_LOCK_PATH: path.join(root, 'release.lock'),
    O8_RELEASE_BROADCAST_CLI: 'true', TSX_TSCONFIG_PATH: path.join(source, 'tsconfig.json') };
  for (const key of ['O8_DATA_DIR', 'CORTEX_IDE_DATA_DIR', 'CORTEX_IDE_DB_PATH', 'O8_OPERATOR_DATA_DIR',
    'O8_RELEASE_BUILD_DATA_DIR', 'O8_RELEASE_CACHE_RUN_ID', 'O8_RELEASE_CACHE_PREBUILD_MARKER',
    'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY']) {
    delete (env as NodeJS.ProcessEnv)[key];
  }
  let invocation = 0;
  function run(args: string[], extra: Partial<NodeJS.ProcessEnv> = {}) {
    const result = spawnSync(process.execPath, args, { cwd: repo, env: { ...env, ...extra },
      encoding: 'utf8', timeout: 180_000, maxBuffer: 2 * 1024 ** 2 });
    writeFileSync(path.join(root, `command-${++invocation}.json`), JSON.stringify({ args,
      pid: result.pid, exit: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }, null, 2));
    return result;
  }
  const prebuild = [process.env.O8_PREBUILD_TEST_SCRIPT || path.join(source, 'scripts/tauri-prebuild.mjs')];
  const first = run(prebuild);
  expect(first.status, first.stderr + first.stdout).toBe(0);
  for (const name of ['.env', '.env.production']) {
    expect(existsSync(path.join(repo, '.next/standalone', name))).toBe(false);
    expect(readFileSync(path.join(repo, name), 'utf8')).toBe('SYNTHETIC_FIXTURE=preserve-source');
  }
  const smoke = JSON.parse(readFileSync(path.join(repo, '.fixture/profile.json'), 'utf8'));
  expect(smoke.publicClientKey).toBe(publicClientKey);
  const profile = smoke.modern as string;
  const databasePath = path.join(profile, 'cortex-ide.db');
  function resources() {
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try { return db.prepare('SELECT payload_json FROM workspace_generated_outputs ORDER BY created_at, rowid')
      .all().map(row => JSON.parse((row as { payload_json: string }).payload_json)); }
    finally { db.close(); }
  }
  const original = resources()[0];
  expect(original.state).toBe('succeeded');
  expect(original.attempt.children.every((child: { identity: unknown; observedClosed: boolean; exitCode: number }) =>
    child.identity && child.observedClosed && child.exitCode === 0)).toBe(true);
  const postship = [process.env.O8_POSTSHIP_TEST_SCRIPT || path.join(source, 'scripts/postship-cleanup.mjs')];
  function stateCommand(body: string) {
    return run(['--import', path.join(source, 'scripts/register-server-only-stub.mjs'),
      '--import', require.resolve('tsx'), '--input-type=module', '-e', body],
    // These direct lifecycle hook probes supply the original build environment.
    // The real postship caller above must resolve it itself from release config.
    { O8_DATA_DIR: profile, CORTEX_IDE_DATA_DIR: profile, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publicClientKey });
  }
  const outputPath = path.join(repo, '.next');
  const outputSaved = path.join(repo, '.fixture/original-next');
  const manifestPath = path.join(repo, 'out/.o8-release-artifact-manifest.json');
  const originalManifest = readFileSync(manifestPath, 'utf8');
  const artifactPath = path.join(repo, 'out/server.js');
  const originalArtifact = readFileSync(artifactPath, 'utf8');
  // Real configuration or artifact drift must still refuse deletion without
  // rewriting the original recipe or lifecycle evidence to manufacture a match.
  writeFileSync(releaseConfigPath, JSON.stringify({ clerkPublishableKey: 'pk_test_changed_file' }));
  const changedConfig = run(postship);
  expect(changedConfig.status).not.toBe(0);
  expect(changedConfig.stderr).toContain('requires a preserved verified release artifact');
  writeFileSync(releaseConfigPath, releaseConfig);
  const changedEnvironment = run(postship, { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_changed_env' });
  expect(changedEnvironment.status).not.toBe(0);
  expect(changedEnvironment.stderr).toContain('requires a preserved verified release artifact');
  writeFileSync(artifactPath, 'corrupted artifact');
  expect(run(postship).status).not.toBe(0);
  expect(readFileSync(artifactPath, 'utf8')).toBe('corrupted artifact');
  writeFileSync(artifactPath, originalArtifact);
  expect(existsSync(outputPath)).toBe(true);
  expect(readFileSync(manifestPath, 'utf8')).toBe(originalManifest);
  expect(resources()).toEqual([original]);
  // Neither unreceipted absence nor a replacement directory confers disposal authority.
  for (const replacement of [false, true]) {
    renameSync(outputPath, outputSaved);
    if (replacement) { mkdirSync(outputPath); writeFileSync(path.join(outputPath, 'foreign'), 'preserve replacement'); }
    const refused = run(postship);
    expect(refused.status).not.toBe(0);
    expect(run(prebuild).status).not.toBe(0);
    expect(resources()).toEqual([original]);
    if (replacement) {
      expect(readFileSync(path.join(outputPath, 'foreign'), 'utf8')).toBe('preserve replacement');
      renameSync(outputPath, path.join(repo, '.fixture/replaced-next'));
    }
    renameSync(outputSaved, outputPath);
  }
  writeFileSync(path.join(outputPath, 'lock'), 'preserve unknown lock');
  expect(run(postship).status).not.toBe(0);
  expect(resources()).toEqual([original]);
  renameSync(path.join(outputPath, 'lock'), path.join(repo, '.fixture/retained-lock'));
  const holdsModule = pathToFileURL(path.join(source, 'src/lib/workspace/retention-holds.ts')).href;
  const held = stateCommand(`
    const ns = await import(${JSON.stringify(holdsModule)});
    (ns.default ?? ns).acquireWorkspaceRetentionHold({ repositoryPath: process.cwd(), repositoryUuid: 'fixture',
      worktreeId: 'ordinary-output', packetId: 'fixture', laneId: 'fixture', holdId: 'postship-hold',
      reason: 'Retain successful output', identity: ${JSON.stringify(original.output)} });
  `);
  expect(held.status, held.stderr).toBe(0);
  expect(run(postship).status).not.toBe(0);
  expect(resources()).toEqual([original]);
  const releasedHold = stateCommand(`
    const ns = await import(${JSON.stringify(holdsModule)});
    (ns.default ?? ns).releaseWorkspaceRetentionHold({ repositoryUuid: 'fixture', packetId: 'fixture', holdId: 'postship-hold' });
  `);
  expect(releasedHold.status, releasedHold.stderr).toBe(0);
  // Internal links are unlinked without following the dependency donor.
  const donor = path.join(repo, 'node_modules/donor');
  mkdirSync(donor); writeFileSync(path.join(donor, 'valuable'), 'preserve dependency');
  symlinkSync(donor, path.join(outputPath, 'donor'), 'dir');
  const disposalModule = pathToFileURL(path.join(source, 'src/lib/workspace/generated-output-disposal.ts')).href;
  for (const hook of ['afterFinalAdmission', 'afterFinalRemoval']) {
    const interrupted = stateCommand(`
      const ns = await import(${JSON.stringify(disposalModule)});
      await (ns.default ?? ns).disposeSuccessfulPrebuildOutput(process.cwd(), '0.0.0', {
        ${hook}: async () => { throw new Error('fixture interruption at ${hook}'); }
      });
    `);
    expect(interrupted.status).not.toBe(0);
    expect(interrupted.stderr).toContain('fixture interruption');
    expect(resources()).toEqual([original]);
    expect(run(prebuild).status).not.toBe(0); // Pending claims cannot be inferred away.
    if (hook === 'afterFinalAdmission') {
      writeFileSync(path.join(outputPath, 'returned'), 'preserve returned content');
      expect(run(postship).status).not.toBe(0);
      expect(readFileSync(path.join(outputPath, 'returned'), 'utf8')).toBe('preserve returned content');
      renameSync(path.join(outputPath, 'returned'), path.join(repo, '.fixture/retained-returned'));
    }
  }
  const cleaned = run(postship);
  expect(cleaned.status, cleaned.stderr + cleaned.stdout).toBe(0);
  expect(cleaned.stdout).toContain('refused=0');
  expect(existsSync(path.join(repo, '.next'))).toBe(false);
  expect(readFileSync(manifestPath, 'utf8')).toBe(originalManifest);
  expect(readFileSync(artifactPath, 'utf8')).toBe(originalArtifact);
  expect(readFileSync(releaseConfigPath, 'utf8')).toBe(releaseConfig);
  expect(readFileSync(path.join(repo, 'package.json'), 'utf8')).toContain('"name":"o8"');
  expect(readFileSync(path.join(outside, 'keep'), 'utf8')).toBe('outside sentinel');
  for (const name of ['.env', '.env.production']) expect(readFileSync(path.join(repo, name), 'utf8')).toBe('SYNTHETIC_FIXTURE=preserve-source');
  const reused = run(prebuild);
  expect(reused.status, reused.stderr + reused.stdout).toBe(0);
  expect(reused.stdout).toContain('reused verified artifact');
  expect(existsSync(path.join(repo, '.next'))).toBe(false);
  const retired = resources()[0];
  expect(retired).toMatchObject({ resourceId: original.resourceId, state: 'retired',
    attempt: original.attempt, disposal: { kind: 'postship' } });
  expect(resources()).toHaveLength(1);
  const replay = run(postship);
  expect(replay.status, replay.stderr + replay.stdout).toBe(0);
  expect(resources()[0]).toEqual(retired);
  expect(readFileSync(path.join(donor, 'valuable'), 'utf8')).toBe('preserve dependency');
  expect(readFileSync(path.join(repo, '.fixture/compiler-calls'), 'utf8')).toBe('build\n');
  // Output corruption must create a new producer generation without rewriting successful history.
  writeFileSync(path.join(repo, 'out/server.js'), 'invalidated artifact');
  const rebuilt = run(prebuild);
  expect(rebuilt.status, rebuilt.stderr + rebuilt.stdout).toBe(0);
  expect(resources()).toHaveLength(2);
  expect(resources()[0]).toEqual(retired);
  const current = resources()[1];
  expect(current.resourceId).not.toBe(retired.resourceId);
  expect(current.state).toBe('succeeded');
  // A real failed child remains held, even though a previous generation succeeded.
  writeFileSync(path.join(repo, 'out/server.js'), 'force another build');
  const failed = run(prebuild, { O8_FIXTURE_BUILD_FAILURE: '1' });
  expect(failed.status).not.toBe(0);
  const failedResource = resources()[1];
  expect(failedResource.state).toBe('failed-held');
  expect(failedResource.attempt.children.some((child: { exitCode: number; observedClosed: boolean }) =>
    child.exitCode === 42 && child.observedClosed)).toBe(true);
  expect(run(postship).status).not.toBe(0);
  expect(resources()).toEqual([retired, failedResource]);
  writeFileSync(path.join(root, 'product-state.json'), JSON.stringify({ profile, databasePath,
    resources: resources() }, null, 2));
}, 900_000);
