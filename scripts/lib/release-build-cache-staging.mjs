import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, openSync, closeSync, fsyncSync, constants, chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { require as tsxRequire } from 'tsx/cjs/api';

// Resolve source aliases against this checkout's tsconfig, not whatever directory the caller runs from.
function tsRequire(path) {
  const previous = process.env.TSX_TSCONFIG_PATH;
  process.env.TSX_TSCONFIG_PATH = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
  try {
    return tsxRequire(path, import.meta.url);
  } finally {
    if (previous === undefined) delete process.env.TSX_TSCONFIG_PATH;
    else process.env.TSX_TSCONFIG_PATH = previous;
  }
}

const exact = tsRequire('../../src/lib/workspace/exact-parent-operation.ts');
const { captureExactDirectoryManifest, purgeExactDirectory } = tsRequire('../../src/lib/workspace/exact-directory-purge.ts');
const { guardedWorkspaceInvocation } = tsRequire('../../src/lib/worktree/materialization-execution.ts');
const { probeMetadataLockProcessIdentity, sameMetadataLockProcessIdentity } =
  tsRequire('../../src/lib/worktree/metadata-lock-process-identity.ts');

function identity(path, kind = 'directory') {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())
    || (kind === 'file' && stat.nlink !== 1)) throw new Error('Cache staging identity is not a private regular resource.');
  return { canonicalPath: realpathSync(path), device: stat.dev, inode: stat.ino };
}

function assertIdentity(expected, kind = 'directory') {
  const actual = identity(expected.canonicalPath, kind);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Cache staging resource identity changed.');
}

async function directory(parent, name) {
  const path = join(parent.canonicalPath, name);
  assertIdentity(parent);
  if (!existsSync(path)) await exact.createExactChildDirectory(parent.canonicalPath, parent, path);
  const captured = identity(path);
  if (captured.canonicalPath !== path) throw new Error('Cache staging directory is redirected.');
  return captured;
}

/** Each state is an exclusive, durable event. A crash never confers cleanup authority. */
export async function beginCacheStaging(cacheRoot, projectRoot, phase, source, options = {}) {
  const runId = options.runId || `cache-${randomUUID()}`;
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(runId)) throw new Error('Cache staging run identity is invalid.');
  const parent = identity(cacheRoot);
  const workspace = identity(projectRoot);
  const runs = await directory(parent, 'runs');
  const run = await directory(runs, runId);
  const journal = await directory(run, 'staging');
  const owner = await probeMetadataLockProcessIdentity(process.pid);
  if (owner.state !== 'live') throw new Error('Cache staging owner identity is unknown.');
  const operationId = randomUUID();
  const path = join(parent.canonicalPath, `.${options.action}-${operationId}`);
  const record = { schema: 'o8/release-cache-staging/v1', runId, operationId, phase,
    action: options.action, source, parent, workspace, runs, run, journal, stagingPath: path,
    owner: { pid: process.pid, identity: owner.identity }, state: 'intent', staging: null, promotions: [] };
  let sequence = 0;
  let held = false;
  const destinations = new Map();
  async function save(state, detail = {}) {
    Object.assign(record, detail, { state });
    for (const captured of [parent, runs, run, journal]) assertIdentity(captured);
    await exact.writeExactChildFile(journal.canonicalPath, journal,
      join(journal.canonicalPath, `${operationId}-${String(++sequence).padStart(3, '0')}-${state}.json`),
      JSON.stringify({ ...record, recordedAt: Date.now() }) + '\n', 0o600);
  }
  async function verify() {
    const current = await probeMetadataLockProcessIdentity(process.pid);
    if (held || process.pid !== record.owner.pid || current.state !== 'live'
      || !sameMetadataLockProcessIdentity(current.identity, record.owner.identity)) {
      throw new Error('Cache staging is held or belongs to another owner.');
    }
    for (const captured of [parent, workspace, runs, run, journal, record.staging]) assertIdentity(captured);
  }
  try {
    await save('intent');
    const created = await exact.createExactChildDirectory(parent.canonicalPath, parent, path);
    record.staging = identity(path);
    if (created.device !== record.staging.device || created.inode !== record.staging.inode) {
      throw new Error('Cache staging creation identity changed before binding.');
    }
    await save('bound');
  } catch (error) {
    throw new Error(`${error.message}; staging=${runId}/${operationId}`, { cause: error });
  }
  return {
    path,
    runId,
    operationId,
    async destinations(paths) {
      await verify();
      for (const destination of paths) {
        const base = options.action === 'restore' ? workspace : parent;
        const local = relative(resolve(options.action === 'restore' ? projectRoot : cacheRoot), resolve(destination));
        if (!local || isAbsolute(local) || local.split('/').includes('..')) throw new Error('Cache destination escapes its authority.');
        const parts = local.split('/');
        let captured = base;
        for (const part of parts.slice(0, -1)) captured = await directory(captured, part);
        const target = join(captured.canonicalPath, parts.at(-1));
        try { lstatSync(target); throw new Error('Cache promotion refused an occupied destination.'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        destinations.set(resolve(destination), { parent: captured, path: target });
      }
      await save('destinations-bound', { destinations: [...destinations.values()] });
    },
    async populate(args, outputName) {
      await verify();
      let output;
      if (outputName) {
        if (basename(outputName) !== outputName) throw new Error('Cache tar output escapes staging.');
        output = openSync(join(path, outputName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      }
      try {
        await save('populating', outputName ? { output: identity(join(path, outputName), 'file') } : {});
        const invocation = guardedWorkspaceInvocation('tar', args, record.staging);
        // Sanitize before launching the Node guard: its policy checks its own
        // environment as well as the tar child's. Archive work needs no secrets,
        // policy stamp, Node preload, or updater compression options.
        const env = Object.fromEntries(
          ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot', 'WINDIR']
            .filter(key => process.env[key] !== undefined)
            .map(key => [key, process.env[key]]),
        );
        const child = spawnSync(invocation.command, invocation.args, { cwd: path,
          env, encoding: 'utf8', stdio: ['ignore', output ?? 'pipe', 'pipe'], timeout: 20 * 60_000, maxBuffer: 1024 * 1024 });
        if (child.error || child.status !== 0 || child.signal) {
          throw new Error(`Cache staging tar failed: ${child.error?.message || child.stderr || child.signal || child.status}`);
        }
        if (output !== undefined) { fsyncSync(output); assertIdentity(record.output, 'file'); }
        await verify();
        await save('populated', { child: { pid: child.pid, observedClosed: true, exitCode: child.status } });
      } finally { if (output !== undefined) closeSync(output); }
    },
    async write(name, contents) {
      await verify();
      if (basename(name) !== name) throw new Error('Cache staging file must be a direct child.');
      await exact.writeExactChildFile(path, record.staging, join(path, name), contents, 0o600);
    },
    async promote(sourcePath, destination, kind = 'directory') {
      await verify();
      const absoluteSource = resolve(sourcePath);
      if (!absoluteSource.startsWith(path + '/')) throw new Error('Cache promotion source escapes staging.');
      const sourceParent = identity(dirname(absoluteSource));
      const bound = destinations.get(resolve(destination));
      if (!bound) throw new Error('Cache destination has no prior authority.');
      const destinationParent = bound.parent;
      destination = bound.path;
      assertIdentity(destinationParent);
      const child = identity(absoluteSource, kind);
      // Refuse before any target is replaced; the exact boundary repeats these checks.
      if (existsSync(destination)) throw new Error('Cache promotion refused an occupied destination.');
      await save('promoting', { promotion: { sourceParent, destinationParent, child, destination } });
      await exact.promoteExactChild(sourceParent, destinationParent, absoluteSource, destination, child, kind);
      await verify();
      await save('promoted', { promotions: [...record.promotions, record.promotion] });
    },
    async clean() {
      await verify();
      if (!record.child?.observedClosed) throw new Error('Cache staging producer exit is unproved.');
      await save('cleaning');
      await purgeExactDirectory(path, record.staging);
      await save('cleaned');
      if (!options.runId) {
        await finalizeCacheReceipt(cacheRoot, runId, {
          outcome: 'PASS', source: source.source, buildDurationMs: options.buildDurationMs ?? 0,
        }, options, { ensurePrivateDirectory,
          isReleaseBuildCachePhaseReceiptName: name => /^(web|speech|native)\.json$/.test(name) });
      }
    },
    async hold(error) {
      held = true;
      // Even if a replaced journal prevents this event, prior intent/binding remains retained.
      await save('held', { error: String(error?.message || error) }).catch(() => {});
    },
  };
}

/** An expected occupied-target miss must not create another disposable resource. */
export function cacheDestinationOccupied(paths) {
  return paths.some(path => {
    try { lstatSync(path); return true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
  });
}

/** Keep unresolved originals; completed identity evidence is consolidated before retirement. */
async function stagingSnapshot(cacheRoot, runId) {
  const path = join(cacheRoot, 'runs', runId, 'staging');
  if (!existsSync(path)) return null;
  const run = identity(dirname(path));
  const manifest = await captureExactDirectoryManifest(run.canonicalPath, run);
  const journal = identity(path);
  const records = new Map();
  const resourceId = value => value && ({ device: value.device, inode: value.inode });
  const names = readdirSync(path).sort();
  for (const name of names) {
    const file = join(path, name);
    identity(file, 'file');
    if (lstatSync(file).size > 128 * 1024) throw new Error('Cache staging receipt exceeds its bound.');
    const contents = readFileSync(file, 'utf8');
    const row = JSON.parse(contents);
    if (row.schema !== 'o8/release-cache-staging/v1' || row.runId !== runId
      || row.run?.device !== run.device || row.run?.inode !== run.inode
      || row.journal?.device !== journal.device || row.journal?.inode !== journal.inode) {
      throw new Error('Cache staging receipt authority is unrecognized.');
    }
    for (const captured of [row.parent, row.runs, row.run, row.journal]) assertIdentity(captured);
    records.set(row.operationId, { operationId: row.operationId, state: row.state,
      phase: row.phase, action: row.action, owner: row.owner,
      staging: resourceId(row.staging), parent: resourceId(row.parent), run: resourceId(row.run),
      journal: resourceId(row.journal), workspace: resourceId(row.workspace),
      output: resourceId(row.output),
      promotions: (row.promotions ?? []).map(promotion => ({ child: resourceId(promotion.child),
        sourceParent: resourceId(promotion.sourceParent), destinationParent: resourceId(promotion.destinationParent) })),
      sourceSha256: row.source.sourceSha256,
      recordSha256: createHash('sha256').update(contents).digest('hex'),
      ...(row.state === 'cleaned' ? {} : { receipt: `staging/${name}` }) });
  }
  return { run, manifest, names, records: [...records.values()] };
}

export async function finalizeCacheReceipt(cacheRoot, runId, summary, options, helpers) {
  const { isReleaseBuildCachePhaseReceiptName, ensurePrivateDirectory } = helpers;
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(runId)) throw new Error('Cache run identity is invalid.');
  const directory = join(cacheRoot, 'runs', runId);
  const capturedRun = existsSync(directory) ? identity(directory) : null;
  const snapshot = await stagingSnapshot(cacheRoot, runId);
  const legacyManifest = !snapshot && capturedRun
    ? await captureExactDirectoryManifest(capturedRun.canonicalPath, capturedRun) : null;
  const phases = {};
  if (capturedRun) {
    for (const name of readdirSync(directory).filter((entry) => isReleaseBuildCachePhaseReceiptName(entry)).sort()) {
      const phase = await exact.readExactChildFile(capturedRun.canonicalPath, capturedRun, join(capturedRun.canonicalPath, name));
      const receipt = JSON.parse(phase.contents);
      phases[receipt.phase] = receipt;
    }
  }
  const staging = snapshot?.records;
  const restores = Object.values(phases).map((phase) => phase.restore).filter(Boolean);
  const knownRunEntry = entry => entry.relative === '.'
    || (entry.kind === 'file' && basename(entry.relative) === entry.relative && isReleaseBuildCachePhaseReceiptName(entry.relative));
  const ownedRunEntry = entry => knownRunEntry(entry)
    || (entry.kind === 'directory' && entry.relative === 'staging')
    || (entry.kind === 'file' && snapshot?.names.some(name => entry.relative === `staging/${name}`));
  const unknownEntries = (snapshot?.manifest.entries ?? legacyManifest?.entries ?? []).filter(entry => !ownedRunEntry(entry));
  const knownCompletedTree = snapshot && unknownEntries.length === 0;
  const receipt = {
    schema: 'o8/release-build-cache-receipt/v1',
    runId,
    createdAt: new Date().toISOString(),
    outcome: summary.outcome,
    source: summary.source,
    platform: process.platform,
    arch: process.arch,
    buildDurationMs: summary.buildDurationMs,
    phases,
    ...(staging ? { staging } : {}),
    ...(unknownEntries.length ? { retention: { reason: 'unknown_run_content', entryCount: unknownEntries.length } } : {}),
    totals: {
      archiveBytesRestored: restores.reduce((sum, restore) => sum + (restore.archiveBytes ?? 0), 0),
      estimatedSavedMs: restores.reduce((sum, restore) => sum + (restore.estimatedSavedMs ?? 0), 0),
      hits: restores.filter((restore) => restore.status === 'hit_exact' || restore.status === 'hit_compatible').length,
      misses: restores.filter((restore) => restore.status === 'miss').length,
    },
  };
  const receiptsDirectory = join(cacheRoot, 'receipts');
  ensurePrivateDirectory(receiptsDirectory);
  const receiptPath = join(receiptsDirectory, `${runId}.json`);
  const receiptParent = identity(receiptsDirectory);
  await exact.writeExactChildFile(receiptParent.canonicalPath, receiptParent,
    join(receiptParent.canonicalPath, `${runId}.json`), `${JSON.stringify(receipt, null, 2)}\n`, 0o600);
  if (knownCompletedTree && staging.length > 0 && staging.every(record => record.state === 'cleaned')) {
    await purgeExactDirectory(snapshot.run.canonicalPath, snapshot.run, undefined, undefined, undefined,
      snapshot.manifest.fingerprint, snapshot.manifest.entries);
  } else if (legacyManifest?.entries.every(knownRunEntry)) {
    await purgeExactDirectory(capturedRun.canonicalPath, capturedRun, undefined, undefined, undefined,
      legacyManifest.fingerprint, legacyManifest.entries);
  }
  return { receipt, receiptPath };
}

export function createReleaseBuildCacheRunId() {
  return `${Date.now()}-${process.pid}`;
}

function runDirectory(cacheRoot, runId) {
  return join(cacheRoot, 'runs', runId);
}

export function writeReleaseBuildCachePhaseReceipt(cacheRoot, runId, receipt) {
  const directory = runDirectory(cacheRoot, runId);
  ensurePrivateDirectory(directory);
  writeFileSync(join(directory, `${receipt.phase}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

export function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {}
}

export function tarArguments(root, config, archivePath) {
  const args = ['-cf', archivePath, '-C', root];
  for (const excluded of config.excludes) args.push('--exclude', excluded);
  args.push(...config.targets);
  return args;
}
