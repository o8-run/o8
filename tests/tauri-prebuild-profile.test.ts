import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { createRetainedGeneratedOutputFixture } from './generated-output-fixture';

const source = process.cwd();
const require = createRequire(import.meta.url);

type PrebuildResult = SpawnSyncReturns<string> & { elapsedMs?: number; timeoutMs?: number; label?: string };

function expectSuccessfulPrebuild(result: PrebuildResult): void {
  const error = result.error as NodeJS.ErrnoException | undefined;
  const diagnostic = [
    `prebuild stderr:\n${result.stderr || '<empty>'}`,
    ...(result.timeoutMs === undefined ? [] : [
      `prebuild ${result.label ?? 'command'}: elapsed=${result.elapsedMs}ms; limit=${result.timeoutMs}ms`,
    ]),
    `prebuild exit=${result.status}; signal=${result.signal ?? 'none'}; spawn error=${error?.code ?? 'none'}`,
    error?.message ?? '',
    `prebuild stdout:\n${result.stdout || '<empty>'}`,
  ].join('\n');
  expect(result.error, diagnostic).toBeUndefined();
  expect(result.signal, diagnostic).toBeNull();
  expect(result.status, diagnostic).toBe(0);
}

it.each([0, 1])('reports child stderr and timeouts from failed prebuild commands (termination exit: %s)', exit => {
  const refusal = 'Generated-output producer refused: fixture refusal';
  const refused = spawnSync(process.execPath, ['-e',
    `console.log('[db] Connected to fixture database'); console.error(${JSON.stringify(refusal)}); process.exitCode = 1;`],
  { encoding: 'utf8', timeout: 5_000 });
  expect(() => expectSuccessfulPrebuild(refused)).toThrow(refusal);

  const waiting = 'fixture prebuild stderr: waiting for its final phase';
  const started = Date.now();
  const timedOut = Object.assign(spawnSync(process.execPath, ['-e',
    `console.error(${JSON.stringify(waiting)}); console.log('[db] Connected to fixture database'); process.on('SIGTERM', () => process.exit(${exit})); setInterval(() => {}, 1000);`],
  { encoding: 'utf8', timeout: 1000 }), { elapsedMs: Date.now() - started, timeoutMs: 1000 });
  expect((timedOut.error as NodeJS.ErrnoException)?.code).toBe('ETIMEDOUT');
  expect(() => expectSuccessfulPrebuild(timedOut)).toThrow('ETIMEDOUT');
  expect(() => expectSuccessfulPrebuild(timedOut)).toThrow('limit=1000ms');
  expect(() => expectSuccessfulPrebuild(timedOut)).toThrow(waiting);
  try { expectSuccessfulPrebuild(timedOut); }
  catch (error) {
    const message = String(error);
    expect(message.indexOf(waiting)).toBeLessThan(message.indexOf('prebuild stdout:'));
    expect(message).toMatch(/elapsed=\d+ms/);
  }
});

it('loads both preloads through the real launcher from a path containing spaces and a URL fragment', async () => {
  const root = await createRetainedGeneratedOutputFixture('o8-preload-url-');
  const repo = path.join(root, 'prebuild # fixture');
  mkdirSync(path.join(repo, 'scripts/lib'), { recursive: true });
  writeFileSync(path.join(repo, 'tsconfig.json'), '{}\n');
  writeFileSync(path.join(repo, 'package.json'), '{"type":"module"}\n');
  symlinkSync(path.join(source, 'node_modules'), path.join(repo, 'node_modules'), 'junction');
  for (const name of ['lib/generated-output-launch.mjs', 'register-server-only-stub.mjs']) {
    writeFileSync(path.join(repo, 'scripts', name), readFileSync(path.join(source, 'scripts', name)));
  }
  // The payload stands in for the compiler. Its typed source needs the tsx
  // preload and its server-only require needs the other preload to run first.
  writeFileSync(path.join(repo, 'scripts/generated-output-run.ts'), `
    import { createRequire } from 'node:module';
    import { writeFileSync } from 'node:fs';
    const answer: number = 42;
    createRequire(import.meta.url)('server-only');
    writeFileSync('preload-proof.json', JSON.stringify({ answer, mode: process.argv[2] }));
  `);
  const launcher = pathToFileURL(path.join(repo, 'scripts/lib/generated-output-launch.mjs')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { runGeneratedOutputLaunch } = await import(${JSON.stringify(launcher)});
    process.exitCode = await runGeneratedOutputLaunch('prebuild');
  `], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: { ...process.env,
    TSX_TSCONFIG_PATH: path.join(source, 'tsconfig.json') } });

  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(JSON.parse(readFileSync(path.join(repo, 'preload-proof.json'), 'utf8')))
    .toEqual({ answer: 42, mode: 'prebuild' });
});

it('preserves managed linked prebuild ownership through native producers', async () => {
  const root = await createRetainedGeneratedOutputFixture('o8-managed-prebuild-');
  const repo = path.join(root, 'repo');
  const data = path.join(root, 'data');
  mkdirSync(repo); mkdirSync(data, { mode: 0o700 });
  writeFileSync(path.join(repo, '.gitignore'), '.next\n.o8-generated-output-store\n');
  for (const args of [['init', '--initial-branch=main'], ['add', '.'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  }
  const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(path.join(source, name)).href);
  const script = `
    const manager = await import(${moduleUrl('src/lib/worktree/manager.ts')});
    const producer = await import(${moduleUrl('src/lib/workspace/generated-output-producer.ts')});
    const state = await import(${moduleUrl('src/lib/workspace/generated-output-state.ts')});
    const { WorktreeManager } = manager.default ?? manager;
    const { runGeneratedOutputPrebuild, runGeneratedOutputProducer } = producer.default ?? producer;
    const { currentGeneratedOutputResource } = state.default ?? state;
    const entry = await new WorktreeManager(${JSON.stringify(repo)}).create({ agentType: 'codex',
      taskName: 'Managed prebuild fixture', branchName: 'codex/managed-prebuild-fixture',
      baseBranch: 'main', managed: true, skipSetup: true });
    const codes = [];
    const child = run => run(process.execPath, ['-e', "require('node:fs').writeFileSync('.next/proof', 'managed producer')"]);
    for (let attempt = 0; attempt < 2; attempt++) codes.push(await runGeneratedOutputPrebuild({
      workspacePath: entry.path, preflight() {}, operation: context => context.runBuild(child) }));
    codes.push(await runGeneratedOutputProducer({ workspacePath: entry.path, mode: 'build', operation: child }));
    console.log('MANAGED_PREBUILD_RESULT ' + JSON.stringify({ codes, entry,
      resource: currentGeneratedOutputResource(entry.path) }));
  `;
  const result = spawnSync(process.execPath, ['--import', path.join(source, 'scripts/register-server-only-stub.mjs'),
    '--import', require.resolve('tsx'), '--input-type=module', '-e', script], { cwd: source,
    env: { ...process.env, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data, CORTEX_IDE_DB_PATH: path.join(data, 'fixture.db'),
      TSX_TSCONFIG_PATH: path.join(source, 'tsconfig.json') }, encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 ** 2 });
  writeFileSync(path.join(root, 'command.json'), JSON.stringify({ script, pid: result.pid, exit: result.status,
    signal: result.signal, stdout: result.stdout, stderr: result.stderr }, null, 2));
  expect(result.status, result.stderr + result.stdout).toBe(0);
  const receipt = JSON.parse(/^MANAGED_PREBUILD_RESULT (.+)$/m.exec(result.stdout)![1]);
  expect(receipt.codes).toEqual([0, 0, 0]);
  expect(receipt.resource.owner).toEqual({ repositoryPath: realpathSync(repo), worktreeId: receipt.entry.id });
  expect(receipt.resource.creationAuthority).toMatchObject({ kind: 'prebuild' });
  expect(receipt.resource.creationAuthority.linkedGit).toBeUndefined();
  expect(receipt.resource.state).toBe('succeeded');
  expect(receipt.resource.attempt.children[0]).toMatchObject({ observedClosed: true, exitCode: 0 });
  writeFileSync(path.join(root, 'product-state.json'), JSON.stringify(receipt, null, 2));
}, 150_000);

it.each(['ordinary', 'linked'] as const)('retains %s prebuild creation authority across default prebuild and release lifetimes', async kind => {
  const root = await createRetainedGeneratedOutputFixture('o8-prebuild-lifetime-');
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const scripts = path.join(repo, 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(home);
  mkdirSync(path.join(repo, '.fixture'));
  // Compilation is synthetic, so its version inputs must be synthetic too.
  // Cold host compiler/SDK probes can time out or change the artifact recipe.
  const toolchains = path.join(root, 'toolchain-bin');
  mkdirSync(toolchains);
  for (const [name, argument] of [['cargo', '--version'], ['rustc', '--version'],
    ['swift', '--version'], ['xcrun', '--show-sdk-version']]) {
    writeFileSync(path.join(toolchains, name), `#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = '${argument}' ]; then
  printf '%s\\n' 'fixture ${name} 1'
else
  printf '%s\\n' 'unexpected fixture compiler invocation' >&2
  exit 97
fi
`, { mode: 0o700 });
  }
  writeFileSync(path.join(repo, '.gitignore'), '.next\nout\nnode_modules\n.fixture\n.o8-generated-output-store\n');
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'prebuild-fixture', version: '0.0.0',
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
    if (fs.readFileSync('.next/BUILD_ID', 'utf8') !== 'native fixture') process.exit(78);
    if (process.env.O8_FIXTURE_SMOKE_WAIT) {
      fs.writeFileSync('.fixture/smoke-ready', 'ready');
      const deadline = Date.now() + 120000;
      while (!fs.existsSync('.fixture/smoke-release')) {
        if (Date.now() > deadline) process.exit(79);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    fs.writeFileSync('.fixture/profile.json', JSON.stringify({ modern: process.env.O8_DATA_DIR,
      legacy: process.env.CORTEX_IDE_DATA_DIR }));
  `);
  const next = path.join(repo, 'node_modules/next/dist/bin');
  mkdirSync(next, { recursive: true });
  symlinkSync(path.dirname(require.resolve('better-sqlite3/package.json')), path.join(repo, 'node_modules/better-sqlite3'), 'dir');
  writeFileSync(path.join(next, 'next'), `
    const fs = require('node:fs');
    const output = process.env.O8_RELEASE_NEXT_DIST_DIR || '.next';
    fs.mkdirSync(output + '/cache', { recursive: true });
    fs.writeFileSync(output + '/cache/proof.bin', 'fixture cache');
    fs.writeFileSync(output + '/BUILD_ID', 'native fixture');
    fs.appendFileSync('.fixture/compiler-calls', 'build\\n');
  `);
  for (const args of [['init', '--initial-branch=main'], ['add', '.'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  }
  if (kind === 'linked') {
    const primary = path.join(root, 'primary');
    renameSync(repo, primary);
    const linked = spawnSync('git', ['worktree', 'add', '-b', 'fixture-linked', repo], { cwd: primary, encoding: 'utf8' });
    expect(linked.status, linked.stderr).toBe(0);
    renameSync(path.join(primary, 'node_modules'), path.join(repo, 'node_modules'));
    mkdirSync(path.join(repo, '.fixture'));
  }
  const env = { ...process.env, HOME: home, O8_RELEASE_BUILD_CACHE_DIR: path.join(root, 'cache'),
    O8_RELEASE_BUILD_CACHE_MAX_BYTES: '10485760', O8_RELEASE_LOCK_PATH: path.join(root, 'release.lock'),
    O8_RELEASE_BROADCAST_CLI: 'true', TSX_TSCONFIG_PATH: path.join(source, 'tsconfig.json'),
    PATH: `${toolchains}${path.delimiter}${process.env.PATH ?? ''}` };
  for (const key of ['O8_DATA_DIR', 'CORTEX_IDE_DATA_DIR', 'CORTEX_IDE_DB_PATH', 'O8_OPERATOR_DATA_DIR',
    'O8_RELEASE_BUILD_DATA_DIR', 'O8_RELEASE_CACHE_RUN_ID', 'O8_RELEASE_CACHE_PREBUILD_MARKER']) {
    delete (env as NodeJS.ProcessEnv)[key];
  }
  let invocation = 0;
  function run(args: string[], extra: Partial<NodeJS.ProcessEnv> = {},
    { timeoutMs = 60_000, label = 'lifecycle command' } = {}) {
    const started = Date.now();
    const result = spawnSync(process.execPath, args, { cwd: repo, env: { ...env, ...extra },
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 2 * 1024 ** 2 });
    const elapsedMs = Date.now() - started;
    writeFileSync(path.join(root, `command-${++invocation}.json`), JSON.stringify({ args, kind, label,
      pid: result.pid, exit: result.status, signal: result.signal, elapsedMs, timeoutMs,
      error: result.error ? { code: (result.error as NodeJS.ErrnoException).code, message: result.error.message } : null,
      stdout: result.stdout, stderr: result.stderr }, null, 2));
    return Object.assign(result, { elapsedMs, timeoutMs, label });
  }
  const prebuild = [process.env.O8_PREBUILD_TEST_SCRIPT || path.join(source, 'scripts/tauri-prebuild.mjs')];
  if (kind === 'linked') {
    const pointer = path.join(repo, '.git');
    const originalPointer = readFileSync(pointer);
    writeFileSync(pointer, `gitdir: ${path.join(root, 'primary/.git')}\n`);
    expect(run(prebuild).status).not.toBe(0);
    expect(existsSync(path.join(repo, '.next'))).toBe(false);
    writeFileSync(pointer, originalPointer);
    // Legacy output stays untouched. Moving this fixture aside is not a product
    // adoption command and grants no operational preservation authority.
    mkdirSync(path.join(repo, '.next/dev'), { recursive: true });
    writeFileSync(path.join(repo, '.next/dev/lock'), 'retained unknown producer evidence');
    const legacy = lstatSync(path.join(repo, '.next'));
    const refused = run(prebuild);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('unknown existing generated output');
    expect(lstatSync(path.join(repo, '.next')).ino).toBe(legacy.ino);
    expect(readFileSync(path.join(repo, '.next/dev/lock'), 'utf8')).toBe('retained unknown producer evidence');
    renameSync(path.join(repo, '.next'), path.join(repo, '.fixture/retained-legacy-next'));
  }
  // A reviewed macOS combined run exhausted 60s on this first call; the native
  // fixture file has measured 130s overall. Allow 180s for the cold lifecycle
  // admission/build, within the 420s case bound. Later calls keep their 60s limit.
  const first = run(prebuild, {}, { timeoutMs: 180_000, label: `${kind} first prebuild` });
  expectSuccessfulPrebuild(first);
  const profile = JSON.parse(readFileSync(path.join(repo, '.fixture/profile.json'), 'utf8')).modern as string;
  expect(existsSync(profile), 'lifecycle profile must survive the first caller').toBe(true);
  const databasePath = path.join(profile, 'cortex-ide.db');
  function resource() {
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try { return JSON.parse((db.prepare('SELECT payload_json FROM workspace_generated_outputs WHERE workspace_path = ?')
      .get(realpathSync(repo)) as { payload_json: string }).payload_json); }
    finally { db.close(); }
  }
  let original = resource();
  expect(original).toMatchObject({ state: 'succeeded', origin: 'managed-creation',
    creationAuthority: { kind: 'prebuild' } });
  expect(original.owner).toBeUndefined();
  if (kind === 'linked') {
    expect(original.creationAuthority.linkedGit.schema).toBe('o8/linked-git-build-custody/v1');
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try { expect(db.prepare('SELECT count(*) AS count FROM worktree_maintenance_roots').get()).toEqual({ count: 0 }); }
    finally { db.close(); }
    const back = path.join(original.creationAuthority.linkedGit.admin.canonicalPath, 'gitdir');
    const bytes = readFileSync(back);
    writeFileSync(back, path.join(root, 'other/.git') + '\n');
    const mismatch = run(prebuild);
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain('does not point back');
    expect(resource()).toEqual(original);
    writeFileSync(back, bytes);
    const gitFile = path.join(repo, '.git');
    const saved = path.join(repo, '.fixture/original-git-pointer');
    renameSync(gitFile, saved);
    writeFileSync(gitFile, readFileSync(saved));
    const replaced = run(prebuild);
    expect(replaced.status).not.toBe(0);
    expect(replaced.stderr).toContain('persisted receipt');
    expect(resource()).toEqual(original);
    renameSync(gitFile, path.join(repo, '.fixture/replaced-git-pointer'));
    renameSync(saved, gitFile);
    expect(existsSync(path.join(root, 'primary/.git'))).toBe(true);
    expect(readFileSync(path.join(repo, '.fixture/retained-legacy-next/dev/lock'), 'utf8'))
      .toBe('retained unknown producer evidence');
  }
  expect(original.attempt.children.length).toBeGreaterThan(0);
  expect(original.attempt.children.every((child: { identity: unknown; observedClosed: boolean; exitCode: number }) =>
    child.identity && child.observedClosed && child.exitCode === 0)).toBe(true);
  const marker = readFileSync(path.join(repo, '.o8-generated-output-store'), 'utf8');
  expect(marker).toBe(createHash('sha256').update(realpathSync(databasePath)).digest('hex'));
  const outputIdentity = lstatSync(path.join(repo, '.next'));
  const profileCount = readdirSync(path.dirname(profile)).length;
  const second = run(prebuild);
  expectSuccessfulPrebuild(second);
  expect(second.stdout).toContain('reused verified artifact');
  expect(resource()).toEqual(original); // Reuse must not invent a successful child or replace its receipt.
  const noop = { command: process.execPath, args: ['-e', 'process.exit(0)'] };
  const planPath = path.join(root, 'release-plan.json');
  writeFileSync(planPath, JSON.stringify({ preflight: noop, build: { command: process.execPath, args: prebuild },
    notarize: noop, publish: noop }));
  const release = ['--input-type=module', '-e', `
    const { runShipWorkflow } = await import(${JSON.stringify(pathToFileURL(path.join(source, 'scripts/lib/ship-broadcast.mjs')).href)});
    await runShipWorkflow({ root: process.cwd(), version: '0.0.0' });
  `];
  const released = run(release, { O8_RELEASE_TEST_MODE: '1', O8_RELEASE_TEST_PLAN: planPath });
  expect(released.status, released.stderr + released.stdout).toBe(0);
  expect(released.stdout).toContain('reused verified artifact');
  expect(resource()).toEqual(original);
  expect(readdirSync(path.dirname(profile))).toHaveLength(profileCount);
  expect(lstatSync(path.join(repo, '.next')).ino).toBe(outputIdentity.ino);
  expect(readFileSync(path.join(repo, '.fixture/compiler-calls'), 'utf8')).toBe('build\n');
  const failingPlan = JSON.parse(readFileSync(planPath, 'utf8'));
  failingPlan.publish = { command: process.execPath, args: ['-e', 'process.exit(42)'] };
  writeFileSync(planPath, JSON.stringify(failingPlan));
  const failedRelease = run(release, { O8_RELEASE_TEST_MODE: '1', O8_RELEASE_TEST_PLAN: planPath });
  expect(failedRelease.status).not.toBe(0);
  expect(resource()).toEqual(original);
  // A live reuse owner retains the same exclusion even though no compiler runs.
  const live = spawn(process.execPath, prebuild, { cwd: repo,
    env: { ...env, O8_FIXTURE_SMOKE_WAIT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(live, 'close');
  let liveOutput = '';
  live.stdout.on('data', chunk => { liveOutput += chunk; });
  live.stderr.on('data', chunk => { liveOutput += chunk; });
  let competingExit: number | null = null;
  try {
    await vi.waitFor(() => expect(existsSync(path.join(repo, '.fixture/smoke-ready'))).toBe(true), { timeout: 60_000 });
    const competing = run(prebuild);
    competingExit = competing.status;
    expect(competing.status).not.toBe(0);
    expect(competing.stderr).toMatch(/owned|lease|lifecycle/i);
    expect(live.exitCode).toBeNull();
  } finally {
    writeFileSync(path.join(repo, '.fixture/smoke-release'), 'release owned fixture smoke');
    expect((await closed)[0], liveOutput).toBe(0);
  }
  expect(resource()).toEqual(original);
  // The next ordinary build finds the retained profile without an environment override.
  const normalBuild = [path.join(source, 'scripts/build.mjs')];
  const builtNormally = run(normalBuild);
  expect(builtNormally.status, builtNormally.stderr + builtNormally.stdout).toBe(0);
  const nextReceipt = resource();
  expect(nextReceipt.resourceId).toBe(original.resourceId);
  expect(nextReceipt.creationAuthority).toEqual(original.creationAuthority);
  expect(nextReceipt.attempt.id).not.toBe(original.attempt.id);
  expect(nextReceipt.state).toBe('succeeded');
  original = nextReceipt;
  const conflict = path.join(root, 'conflicting-profile');
  mkdirSync(conflict);
  const conflictingDb = path.join(conflict, 'cortex-ide.db');
  const emptyDatabase = new Database(conflictingDb);
  emptyDatabase.exec('CREATE TABLE unrelated(value TEXT)');
  emptyDatabase.close();
  const conflictingBytes = readFileSync(conflictingDb);
  const mismatched = run(normalBuild, { O8_DATA_DIR: conflict, CORTEX_IDE_DATA_DIR: conflict });
  expect(mismatched.status).not.toBe(0);
  expect(mismatched.stderr).toContain('mismatched');
  expect(readFileSync(conflictingDb)).toEqual(conflictingBytes);
  expect(resource()).toEqual(original);
  // Persist a real retention hold through the production API. It is intentionally retained.
  const held = run(['--import', path.join(source, 'scripts/register-server-only-stub.mjs'),
    '--import', require.resolve('tsx'), '--input-type=module', '-e', `
      const ns = await import(${JSON.stringify(pathToFileURL(path.join(source, 'src/lib/workspace/retention-holds.ts')).href)});
      const { acquireWorkspaceRetentionHold } = ns.default ?? ns;
      acquireWorkspaceRetentionHold({ repositoryPath: process.cwd(), repositoryUuid: 'fixture',
        worktreeId: 'ordinary-output', packetId: 'fixture', laneId: 'fixture', holdId: 'fixture-hold',
        reason: 'Retain prebuild regression evidence', identity: ${JSON.stringify(original.output)} });
    `], { O8_DATA_DIR: profile, CORTEX_IDE_DATA_DIR: profile });
  expect(held.status, held.stderr).toBe(0);
  const heldAttempt = run(prebuild);
  expect(heldAttempt.status).not.toBe(0);
  expect(heldAttempt.stderr).toContain('retention hold');
  expect(resource()).toEqual(original);
  writeFileSync(path.join(root, 'product-state.json'), JSON.stringify({ profile, databasePath,
    marker, resource: resource(), profileCount, output: { device: outputIdentity.dev, inode: outputIdentity.ino },
    nativeExclusion: { competingExit, ownerExit: live.exitCode }, hold: 'retained' }, null, 2));
  // Existing lock and unknown output remain refusals, never disposal authority.
  writeFileSync(path.join(repo, '.next/lock'), 'retained lock');
  const refused = run(prebuild);
  expect(refused.status).not.toBe(0);
  expect(readFileSync(path.join(repo, '.next/lock'), 'utf8')).toBe('retained lock');
  expect(resource()).toEqual(original);
  renameSync(path.join(repo, '.o8-generated-output-store'), path.join(repo, '.fixture/lost-store-binding'));
  const missing = run(normalBuild);
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain('binding is missing');
  expect(existsSync(path.join(repo, '.o8-generated-output-store'))).toBe(false);
  const missingAndConflicting = run(normalBuild, { O8_DATA_DIR: conflict, CORTEX_IDE_DATA_DIR: conflict,
    CORTEX_IDE_DB_PATH: conflictingDb });
  expect(missingAndConflicting.status).not.toBe(0);
  expect(missingAndConflicting.stderr).toContain('binding is missing');
  expect(readFileSync(conflictingDb)).toEqual(conflictingBytes);
  expect(resource()).toEqual(original);
}, 420_000);
