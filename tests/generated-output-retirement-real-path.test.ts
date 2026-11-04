import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import type { GeneratedOutputResource } from '../src/lib/workspace/generated-output-state';
import { createRetainedGeneratedOutputFixture } from './generated-output-fixture';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const source = process.cwd();
const url = (relative: string) => JSON.stringify(pathToFileURL(path.join(source, relative)).href);

async function fixture() {
  const root = await createRetainedGeneratedOutputFixture('o8-generated-retirement-');
  const repo = path.join(root, 'repo'); const data = path.join(root, 'data');
  await mkdir(repo); await mkdir(data, { mode: 0o700 });
  const probes = path.join(root, 'native-cwd-probes'); await mkdir(probes, { mode: 0o700 });
  const observer = pathToFileURL(path.join(source, 'tests/generated-output-native-cwd-observer.mjs')).href;
  // Legacy checkout: the lifecycle marker and claim have no new ignore rules.
  await writeFile(path.join(repo, '.gitignore'), '.next\nnode_modules\n');
  await writeFile(path.join(repo, 'package.json'), '{"private":true}\n');
  for (const args of [['init', '--initial-branch=main'], ['add', '.'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture']]) await exec('git', args, { cwd: repo });
  const env = { ...process.env, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
    CORTEX_IDE_DB_PATH: path.join(data, 'fixture.db'), TSX_TSCONFIG_PATH: path.join(source, 'tsconfig.json'),
    O8_TEST_NATIVE_CWD_PROBE_ROOT: probes,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${observer}`].filter(Boolean).join(' ') };
  let commandIndex = 0;
  const invoke = async (args: string[], commandEnv: NodeJS.ProcessEnv = env) => {
    const index = ++commandIndex;
    const startedAt = new Date().toISOString();
    const execution = exec(process.execPath, args, {
      cwd: source, env: commandEnv, timeout: 120_000, maxBuffer: 4 * 1024 ** 2,
    });
    const closed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
      execution.child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    const save = async (stdout: string, stderr: string) => writeFile(path.join(root, `command-${index}.json`),
      JSON.stringify({ startedAt, closedAt: new Date().toISOString(), pid: execution.child.pid,
        nativeClose: await closed, args, stdout, stderr }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    try {
      const result = await execution; await save(result.stdout, result.stderr); return result;
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      await save(result.stdout ?? '', result.stderr ?? '');
      // Match the native error output, never the -e script embedded in Error.message.
      throw new Error(result.stderr?.trim() || 'Native fixture command failed without stderr', { cause: error });
    }
  };
  const cold = async (script: string, commandEnv: NodeJS.ProcessEnv = env) => {
    const result = await invoke(['--import', path.join(source, 'scripts/register-server-only-stub.mjs'),
      '--import', require.resolve('tsx'), '--input-type=module', '-e', script], commandEnv);
    const match = /^O8_GENERATED_RESULT (.+)$/m.exec(result.stdout);
    if (!match) throw new Error(result.stdout + result.stderr);
    return JSON.parse(match[1]);
  };
  const created = await cold(`
    const ns = await import(${url('src/lib/worktree/manager.ts')});
    const { WorktreeManager } = ns.default ?? ns;
    const entry = await new WorktreeManager(${JSON.stringify(repo)}).create({
      agentType: 'codex', taskName: 'Generated retirement fixture', branchName: 'codex/generated-retirement-fixture',
      baseBranch: 'main', managed: true, skipSetup: true });
    console.log('O8_GENERATED_RESULT ' + JSON.stringify(entry));
  `) as { id: string; path: string };
  const workspace = await realpath(created.path);
  const cli = async (...args: string[]) => {
    const result = await invoke([path.join(source, 'scripts/generated-output.mjs'), ...args]);
    return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { resource: GeneratedOutputResource };
  };
  const inspect = async (resourceId: string) => cold(`
    const state = await import(${url('src/lib/workspace/generated-output-state.ts')});
    const database = await import(${url('src/lib/db/index.ts')});
    const { readGeneratedOutputResource } = state.default ?? state;
    const { getSqlite } = database.default ?? database;
    const resource = readGeneratedOutputResource(${JSON.stringify(resourceId)});
    const claims = getSqlite().prepare('SELECT * FROM workspace_exact_claims').all();
    const finalizations = getSqlite().prepare('SELECT * FROM workspace_exact_finalizations').all();
    const history = getSqlite().prepare('SELECT * FROM workspace_generated_output_recoveries WHERE resource_id = ?').all(resource.resourceId);
    const entries = getSqlite().prepare('SELECT * FROM workspace_generated_output_recovery_entries WHERE resource_id = ?').all(resource.resourceId);
    console.log('O8_GENERATED_RESULT ' + JSON.stringify({ resource, claims, finalizations, history, entries }));
  `) as Promise<{ resource: GeneratedOutputResource;
    claims: Array<{ operation_id: string; claim_path: string; state: string; source_inode: number }>;
    finalizations: Array<{ operation_id: string; state: string; receipt_json: string }>;
    history: Array<{ operation_id: string; purpose: string; state: string; payload_json: string }>;
    entries: Array<{ relative: string; kind: string; phase: string; receipt_json: string; observed_closed: number; canonical_path: string }> }>;
  const crash = (resourceId: string, verification: boolean, point: string) => cold(`
    const ns = await import(${url(verification ? 'src/lib/workspace/generated-output-recovery-retirement.ts'
      : 'src/lib/workspace/generated-output-retirement.ts')});
    const api = ns.default ?? ns;
    const retire = api.${verification ? 'retireGeneratedOutputVerification' : 'retireGeneratedOutput'};
    await retire(${JSON.stringify(resourceId)}, { ${point}: async () => { throw new Error('fixture interruption ${point}'); } });
    throw new Error('Expected fault boundary was not reached');
  `);
  const legacy = async () => {
    await mkdir(path.join(workspace, '.next/cache'), { recursive: true });
    await writeFile(path.join(workspace, '.next/cache/proof.bin'), Buffer.alloc(64 * 1024, 37), { mode: 0o640 });
    await writeFile(path.join(workspace, '.next/manifest.json'), '{"nativeFixture":true}\n', { mode: 0o600 });
    const registered = await cli('register', '--workspace', workspace);
    expect(registered.resource.state).toBe('legacy-held');
    expect(registered.resource.attempt).toBeUndefined();
    const evidence = [path.join(root, randomUUID() + '-source.json'), path.join(root, randomUUID() + '-stop.json')];
    await writeFile(evidence[0], JSON.stringify(registered.resource.revision), { mode: 0o600 });
    await writeFile(evidence[1], JSON.stringify({ intent: 'Observe owned legacy bytes; no historical producer is asserted' }), { mode: 0o600 });
    const adopted = await cli('adopt', '--workspace', workspace, '--repository', repo, '--worktree-id', created.id,
      '--intent', 'Preserve the new tiny owned legacy fixture', '--evidence', evidence[0], '--evidence', evidence[1]);
    return (await inspect(adopted.resource.resourceId)).resource;
  };
  return { root, repo, data, env, workspace, invoke, cli, cold, inspect, crash, legacy };
}

async function bankHashes(resource: GeneratedOutputResource) {
  const rows: Record<string, string> = {};
  for (const candidate of [path.join(resource.bank!.root.canonicalPath, 'manifest.json'),
    ...resource.bank!.entries.filter(entry => entry.kind === 'file').map(entry => path.join(resource.bank!.files.canonicalPath, entry.compressedName!))]) {
    rows[candidate] = createHash('sha256').update(await readFile(candidate)).digest('hex');
  }
  return rows;
}

async function allocatedFiles(resource: GeneratedOutputResource, root: string) {
  const rows = [];
  for (const entry of resource.bank!.entries.filter(entry => entry.kind === 'file')) {
    const candidate = path.join(root, entry.relative); const stat = await lstat(candidate);
    rows.push({ path: candidate, device: stat.dev, inode: stat.ino, allocatedBytes: stat.blocks * 512 });
  }
  return rows;
}

it('cold-replays source and disposable-copy interruptions while refusing changed, replaced, held and live copies', async () => {
  const input = await fixture(); const adopted = await input.legacy(); const id = adopted.resourceId;
  const hashes = await bankHashes(adopted);
  const sourceAllocation = await allocatedFiles(adopted, adopted.output!.canonicalPath);
  const recovery = (await input.cli('recover-verification', '--resource', id)).resource.recovery!;
  const copyAllocation = await allocatedFiles(adopted, recovery.path);
  expect(recovery.purpose).toBe('verification-disposable');
  await expect(input.cli('retire-verification', '--resource', id)).rejects.toThrow('after durable source retirement');
  await expect(input.crash(id, false, 'afterRename')).rejects.toThrow('fixture interruption afterRename');
  let observed = await input.inspect(id);
  expect(observed.claims).toHaveLength(1); expect(observed.claims[0].state).toBe('prepared');
  expect((await lstat(observed.claims[0].claim_path)).ino).toBe(adopted.output!.inode);
  await expect(lstat(path.join(input.workspace, '.next'))).rejects.toMatchObject({ code: 'ENOENT' });
  const unrelatedClaim = path.join(input.workspace, `.o8-retired-generated-${randomUUID()}`);
  await mkdir(unrelatedClaim, { mode: 0o700 });
  const unrelatedFile = path.join(unrelatedClaim, 'unrelated-source.txt');
  await writeFile(unrelatedFile, 'This other namespace remains source provenance.', { mode: 0o600 });
  await expect(input.cli('retire', '--resource', id)).rejects.toThrow('source revision changed');
  expect(await readFile(unrelatedFile, 'utf8')).toContain('remains source provenance');
  expect((await lstat(observed.claims[0].claim_path)).ino).toBe(adopted.output!.inode);
  await unlink(unrelatedFile); await rmdir(unrelatedClaim);
  await expect(input.crash(id, false, 'afterFinalRemoval')).rejects.toThrow('fixture interruption afterFinalRemoval');
  observed = await input.inspect(id);
  expect(observed.resource.state).toBe('adopted'); expect(observed.finalizations[0].state).toBe('admitted');
  await expect(lstat(observed.claims[0].claim_path)).rejects.toMatchObject({ code: 'ENOENT' });
  const retired = (await input.cli('retire', '--resource', id)).resource;
  expect(retired.state).toBe('retired'); expect((await input.inspect(id)).claims).toHaveLength(0);
  expect((await input.cli('retire', '--resource', id)).resource).toEqual(retired);
  const proof = path.join(recovery.path, 'cache/proof.bin'); const mode = (await lstat(proof)).mode & 0o777;
  const bytes = await readFile(proof); const rootInode = (await lstat(recovery.path)).ino;
  await chmod(proof, 0o600); await writeFile(proof, 'changed owned fixture'); await chmod(proof, mode);
  await expect(input.cli('retire-verification', '--resource', id)).rejects.toThrow('file length changed');
  expect(await readFile(proof, 'utf8')).toBe('changed owned fixture');
  await chmod(proof, 0o600); await writeFile(proof, bytes); await chmod(proof, mode);
  const extra = path.join(recovery.path, 'unexpected-fixture.txt'); await writeFile(extra, 'retained until explicitly removed by test');
  await expect(input.cli('retire-verification', '--resource', id)).rejects.toThrow('namespace changed');
  expect(await readFile(extra, 'utf8')).toContain('retained'); await unlink(extra);
  const held = path.join(recovery.parent.canonicalPath, 'original-copy-held');
  await rename(recovery.path, held); await mkdir(recovery.path, { mode: 0o700 });
  const replacement = (await lstat(recovery.path)).ino;
  await expect(input.cli('retire-verification', '--resource', id)).rejects.toThrow();
  expect((await lstat(held)).ino).toBe(rootInode); expect((await lstat(recovery.path)).ino).toBe(replacement);
  await rmdir(recovery.path); await rename(held, recovery.path);
  const noProcessScanner = path.join(input.root, 'no-process-scanner');
  await mkdir(noProcessScanner, { mode: 0o700 });
  if (process.platform === 'linux') {
    // Preserve the real volume probe while withholding only the native cwd scanner.
    const findmnt = await exec('which', ['findmnt'], { env: input.env });
    const executable = await realpath(findmnt.stdout.trim());
    await symlink(executable, path.join(noProcessScanner, 'findmnt'));
  }
  // A missing lsof can enter the Linux /proc fallback; fail the probe explicitly.
  await writeFile(path.join(noProcessScanner, 'lsof'), `#!${process.execPath}\nprocess.stderr.write('fixture cwd scanner unavailable');process.exit(2);\n`, { mode: 0o700 });
  const unavailableCwdEnv = { ...input.env, PATH: noProcessScanner };
  const unavailableCwd = await input.cold(`
    const identityNs = await import(${url('src/lib/worktree/materialization-identity.ts')});
    const cwdNs = await import(${url('src/lib/runtime/process-cwd-snapshot.ts')});
    const { captureWorktreeMaterializationIdentity } = identityNs.default ?? identityNs;
    const { readProcessCwdSnapshot } = cwdNs.default ?? cwdNs;
    const identity = await captureWorktreeMaterializationIdentity(${JSON.stringify(recovery.parent.canonicalPath)});
    const snapshot = await readProcessCwdSnapshot({ forceRefresh: true });
    console.log('O8_GENERATED_RESULT ' + JSON.stringify({ identity, snapshot }));
  `, unavailableCwdEnv) as { identity: typeof recovery.parent;
    snapshot: { status: string; rows: unknown[]; reason: string } };
  expect(unavailableCwd.identity).toEqual(recovery.parent);
  expect(unavailableCwd.snapshot).toMatchObject({ status: 'unavailable', rows: [] });
  expect(unavailableCwd.snapshot.reason).toContain('fixture cwd scanner unavailable');
  // The actual CLI must reach the unknown-consumer guard after volume identity remains valid.
  await expect(input.invoke([path.join(source, 'scripts/generated-output.mjs'), 'retire-verification', '--resource', id],
    unavailableCwdEnv)).rejects.toThrow('live or unknown consumer');
  expect((await lstat(recovery.path)).ino).toBe(rootInode);
  const consumer = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n');setInterval(()=>{},1000)"],
    { cwd: recovery.path, env: input.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    consumer.once('error', reject); consumer.once('close', (code, signal) => resolve({ code, signal }));
  });
  try {
    await new Promise<void>((resolve, reject) => { consumer.once('error', reject); consumer.stdout!.once('data', () => resolve()); });
    await expect(input.cli('retire-verification', '--resource', id)).rejects.toThrow('live or unknown consumer');
    expect(consumer.exitCode).toBeNull(); expect((await lstat(recovery.path)).ino).toBe(rootInode);
  } finally { consumer.kill('SIGTERM'); await closed; }
  const hold = await input.cold(`
    const ns = await import(${url('src/lib/workspace/retention-holds.ts')});
    const { acquireWorkspaceRetentionHold } = ns.default ?? ns;
    const { randomUUID } = await import('node:crypto');
    const hold = acquireWorkspaceRetentionHold({ repositoryPath: ${JSON.stringify(input.repo)}, repositoryUuid: randomUUID(),
      packetId: randomUUID(), laneId: randomUUID(), worktreeId: ${JSON.stringify(recovery.operationId)}, holdId: randomUUID(),
      identity: ${JSON.stringify(recovery.root)}, reason: 'Preserve owned verification fixture' });
    console.log('O8_GENERATED_RESULT ' + JSON.stringify(hold));
  `) as { repositoryUuid: string; packetId: string; holdId: string };
  await expect(input.cli('retire-verification', '--resource', id)).rejects.toThrow('persisted retention hold');
  expect((await lstat(recovery.path)).ino).toBe(rootInode);
  await input.cold(`
    const ns = await import(${url('src/lib/workspace/retention-holds.ts')});
    const { releaseWorkspaceRetentionHold } = ns.default ?? ns;
    console.log('O8_GENERATED_RESULT ' + JSON.stringify(releaseWorkspaceRetentionHold(${JSON.stringify({
      repositoryUuid: hold.repositoryUuid, packetId: hold.packetId, holdId: hold.holdId })})));
  `);
  await expect(input.crash(id, true, 'afterRename')).rejects.toThrow('fixture interruption afterRename');
  observed = await input.inspect(id);
  expect(observed.claims[0].state).toBe('prepared'); expect((await lstat(observed.claims[0].claim_path)).ino).toBe(rootInode);
  await expect(input.crash(id, true, 'afterFinalAdmission')).rejects.toThrow('fixture interruption afterFinalAdmission');
  observed = await input.inspect(id);
  expect(observed.resource.recovery!.state).toBe('complete');
  expect(await readdir(observed.claims[0].claim_path)).toEqual([]);
  expect(observed.finalizations.find(row => row.operation_id === observed.claims[0].operation_id)!.state).toBe('admitted');
  await expect(input.crash(id, true, 'afterFinalRemoval')).rejects.toThrow('fixture interruption afterFinalRemoval');
  observed = await input.inspect(id); await expect(lstat(observed.claims[0].claim_path)).rejects.toMatchObject({ code: 'ENOENT' });
  const discarded = (await input.cli('retire-verification', '--resource', id)).resource;
  expect(discarded.recovery!.state).toBe('retired');
  expect((await input.cli('retire-verification', '--resource', id)).resource).toEqual(discarded);
  expect(await bankHashes(adopted)).toEqual(hashes);
  const ordinary = (await input.cli('recover', '--resource', id)).resource;
  expect(ordinary.recovery!.operationId).not.toBe(recovery.operationId); expect(ordinary.recovery!.purpose).toBe('recovery');
  expect(ordinary.retirement).toEqual(retired.retirement);
  expect(await readFile(path.join(ordinary.recovery!.path, 'cache/proof.bin'))).toEqual(bytes);
  const ordinaryInode = (await lstat(ordinary.recovery!.path)).ino;
  expect((await input.cli('recover', '--resource', id)).resource.recovery).toEqual(ordinary.recovery);
  await expect(input.cli('retire-verification', '--resource', id)).rejects.toThrow('disposable verification copy');
  expect((await lstat(ordinary.recovery!.path)).ino).toBe(ordinaryInode);
  const final = await input.inspect(id);
  expect(final.claims).toHaveLength(0); expect(final.finalizations.every(row => row.state === 'complete')).toBe(true);
  expect(final.history).toHaveLength(2);
  expect(final.history.find(row => row.operation_id === recovery.operationId)!.state).toBe('retired');
  expect(final.history.find(row => row.operation_id === ordinary.recovery!.operationId)!.state).toBe('complete');
  expect(await bankHashes(adopted)).toEqual(hashes);
  for (const entry of [...sourceAllocation, ...copyAllocation]) {
    await expect(lstat(entry.path)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  await writeFile(path.join(input.root, 'native-retirement-result.json'), JSON.stringify({
    resourceId: id, sourceRetirement: retired.retirement, discarded: discarded.recovery, ordinary: ordinary.recovery,
    bankHashes: hashes, finalizations: final.finalizations, sourceAndDisposableNamesAbsent: true,
    sourceAllocation, copyAllocation, allocatedFileBytesRemoved: [...sourceAllocation, ...copyAllocation]
      .reduce((total, entry) => total + entry.allocatedBytes, 0), hostBackingSavingsClaimed: false,
    expectedRefusals: ['before-source-retirement', 'changed-bytes', 'extra-file', 'replaced-root', 'unknown-observer', 'live-consumer', 'hold', 'ordinary-copy'],
  }, null, 2) + '\n', { mode: 0o600 });
}, 600_000);

it('retains a genuinely interrupted native recovery writer and refuses source, copy retirement and retry', async () => {
  const input = await fixture(); const adopted = await input.legacy(); const id = adopted.resourceId;
  const hashes = await bankHashes(adopted);
  await input.cold(`
    const ns = await import(${url('src/lib/db/index.ts')}); const { getSqlite } = ns.default ?? ns;
    getSqlite().exec("CREATE TRIGGER owned_fixture_recovery_failure BEFORE UPDATE ON workspace_generated_output_recovery_entries WHEN NEW.kind = 'file' AND NEW.phase = 'prepared' BEGIN SELECT RAISE(ABORT, 'owned fixture prepared journal failure'); END");
    console.log('O8_GENERATED_RESULT {}');
  `);
  await expect(input.cli('recover-verification', '--resource', id)).rejects.toThrow('owned fixture prepared journal failure');
  const failed = await input.inspect(id);
  expect(failed.resource.recovery!.state).toBe('failed-held'); expect(failed.history[0].state).toBe('failed-held');
  const native = failed.entries.find(row => row.kind === 'file')!;
  expect(native.phase).toBe('ready'); expect(native.observed_closed).toBe(0);
  expect(JSON.parse(native.receipt_json).processIdentity).toBeTruthy();
  // A writer created its owned inode, but journal failure prevents fabricated completion.
  const failedFile = path.join(failed.resource.recovery!.path, native.relative);
  expect((await lstat(failedFile)).size).toBe(0);
  await expect(input.cli('retire-verification', '--resource', id)).rejects.toThrow();
  await expect(input.cli('retire', '--resource', id)).rejects.toThrow();
  await expect(input.cli('recover-verification', '--resource', id)).rejects.toThrow();
  expect((await input.inspect(id)).resource).toEqual(failed.resource);
  expect((await lstat(path.join(input.workspace, '.next'))).ino).toBe(adopted.output!.inode);
  expect(await bankHashes(adopted)).toEqual(hashes);
  await writeFile(path.join(input.root, 'native-recovery-failure-result.json'), JSON.stringify(failed, null, 2) + '\n', { mode: 0o600 });
}, 180_000);
