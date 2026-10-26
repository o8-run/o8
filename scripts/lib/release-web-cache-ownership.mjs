import { createHash } from 'node:crypto';
import { constants, copyFileSync, createReadStream, existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { require as tsxRequire } from 'tsx/cjs/api';

function tsRequire(path) {
  const previous = process.env.TSX_TSCONFIG_PATH;
  process.env.TSX_TSCONFIG_PATH = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
  try { return tsxRequire(path, import.meta.url); }
  finally {
    if (previous === undefined) delete process.env.TSX_TSCONFIG_PATH;
    else process.env.TSX_TSCONFIG_PATH = previous;
  }
}
const { captureExactDirectoryManifest, clearExactDirectoryContents } = tsRequire('../../src/lib/workspace/exact-directory-purge.ts');
const { createExactChildDirectory, removeExactEmptyChildDirectory } = tsRequire('../../src/lib/workspace/exact-parent-operation.ts');

function directoryIdentity(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error('Cache ownership directory is redirected or invalid.');
  }
  return { canonicalPath: path, device: stat.dev, inode: stat.ino };
}
function assertDirectory(path, expected) {
  const actual = directoryIdentity(path);
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new Error('Cache ownership directory changed.');
  }
}
function refuse(reason) {
  throw new Error(`Preserved unowned or changed entries in .next/cache; ${reason}`);
}

/** Capture in private extraction staging, before the verified tree is promoted. */
export async function captureRestoredWebCache(source, destination) {
  const identity = directoryIdentity(source);
  return { path: destination, identity: { device: identity.device, inode: identity.inode },
    manifest: await captureExactDirectoryManifest(source, identity, { contents: true }) };
}

function comparable(entry) {
  return entry.kind === 'directory'
    ? [entry.relative, entry.kind, entry.device, entry.inode, entry.mode]
    : [entry.relative, entry.kind, entry.device, entry.inode, entry.mode, entry.linkCount,
      entry.size, entry.mtimeMs, entry.ctimeMs, entry.contentSha256];
}
async function assertInventory(cache, ownership) {
  if (!ownership || ownership.path !== cache || !ownership.manifest?.entries?.length) {
    refuse('no verified restoration inventory owns them.');
  }
  assertDirectory(cache, ownership.identity);
  const current = await captureExactDirectoryManifest(cache, ownership.identity, { contents: true });
  if (JSON.stringify(current.entries.map(comparable)) !== JSON.stringify(ownership.manifest.entries.map(comparable))) {
    refuse('the verified restoration inventory changed.');
  }
}

/** Never move a shared tree into the compiler namespace or inventory it again as owned.
 * Copy only verified names; release only that original inventory with native per-delete checks. */
export async function prepareRegisteredWebCache(root, compiler, ownership) {
  const cache = join(root, '.next/cache');
  if (!lstatSync(cache, { throwIfNoEntry: false })) return;
  await assertInventory(cache, ownership);
  const patches = join(root, 'patches');
  const newestPatch = existsSync(patches) ? Math.max(0,
    ...readdirSync(patches).map(name => lstatSync(join(patches, name)).mtimeMs)) : 0;
  const stale = newestPatch > lstatSync(cache).mtimeMs;
  if (!stale) {
    const target = join(compiler, 'cache');
    const directories = new Map([['.', directoryIdentity(compiler)]]);
    await createExactChildDirectory(compiler, directories.get('.'), target);
    directories.set('.', directoryIdentity(target));
    for (const entry of ownership.manifest.entries) {
      if (entry.relative === '.') continue;
      const destination = join(target, entry.relative);
      const parent = directories.get(dirname(entry.relative));
      if (!parent) refuse('restoration inventory has a detached child.');
      assertDirectory(parent.canonicalPath, parent);
      if (entry.kind === 'directory') {
        await createExactChildDirectory(parent.canonicalPath, parent, destination);
        directories.set(entry.relative, directoryIdentity(destination));
      } else if (entry.kind === 'file') {
        // The destination is newly created with exclusive file creation. Its hash
        // must match the verified extraction before it can become compiler input.
        copyFileSync(join(cache, entry.relative), destination, constants.COPYFILE_EXCL);
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(destination)) hash.update(chunk);
        if (hash.digest('hex') !== entry.contentSha256) refuse('restored file bytes changed during import.');
      } else refuse('restoration inventory contains a linked or special file.');
    }
  } else console.log('[bust-stale-patch-cache] clearing verified webpack cache after newer patches');
  await clearExactDirectoryContents(cache, ownership.identity, ownership.manifest,
    async () => assertInventory(cache, ownership), async () => assertDirectory(cache, ownership.identity));
  if (readdirSync(cache).length) refuse('unlisted entries remain after verified cache release.');
  const parent = directoryIdentity(dirname(cache));
  // Empty-directory removal repeats the original inode and emptiness checks natively.
  await removeExactEmptyChildDirectory(parent.canonicalPath, parent, cache, ownership.identity);
}
