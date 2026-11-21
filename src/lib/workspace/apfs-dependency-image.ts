import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rename, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getDataDir } from '@/lib/data-dir-migration';
import type { DependencyInstallReceipt, DependencyInstallRecipe } from './dependency-install';
import {
  adoptDependencySeedImagePublisher, beginDependencySeedImage, beginDependencySeedLease,
  bindMountedDependencySeedLease, findDependencySeedLeaseForWorkspace,
  listDependencySeedLeases, publishDependencySeedImage, readDependencySeedImage,
  readDependencySeedLease, recordAttachedDependencySeedLease, recordBuiltDependencySeedImage,
  removePreparedDependencySeedLease, removeUnpublishedDependencySeedImage,
  type DependencySeedImageRecord, type DependencySeedLeaseRecord,
} from './dependency-seed-registry';
import { isMetadataLockProcessIdentity, probeMetadataLockProcessIdentity,
  sameMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import { purgeExactDirectory } from './exact-directory-purge';
import {
  assertExactDependencyFileIdentity, exactDependencyFileAt,
  readExactDependencyFile, sealExactDependencyFile, writeAndSealExactDependencyFile,
  withHeldExactDependencyFile,
} from './dependency-image-file-authority';
import {
  blockDependencySeedLeaseCleanup,
  reconcileDependencyMountLeaseCleanup, requestDependencyMountLeaseCleanup,
} from './dependency-image-lease-cleanup';
import {
  assertDependencyImageAttachUsable, captureDependencyImageAttachCleanupAuthority,
  classifyDependencyLeaseDevices, mountedDependencyImages,
  parseDependencyAttachInfo, parseDependencyValidationAttachInfo,
  runHdiCommand,
} from './dependency-image-device-authority';
import {
  assertCurrentDependencyImageSource,
  assertDependencyImageSourceReceipt,
  dependencyPathInside,
  digestDependencyTree,
  rederiveDependencyImageRecipeAuthority,
  DependencyImageRefusalError,
  type DependencyImageManifest,
  type DependencyImageSourceReceipt,
} from './dependency-image-source-authority';
import {
  asMount,
  assertExpectedDependencyImageLease,
  cancelAbandonedPreparedDependencyImageLease,
  dependencyImagePreparedLease,
  type DependencyImageDetachOptions,
  type DependencyImageLeaseReconciliation,
  type DependencyImageMount,
} from './dependency-image-lease-receipt';
import {
  assertDependencyImagePublicationSource,
  currentDependencyImageOwner,
  sameDependencyImagePublisher,
  type DependencyImagePublisherAuthority,
} from './dependency-image-publisher-authority';
import type { DependencyImageOptions } from './dependency-image-options';
export { captureDependencyImageSourceReceipt, DependencyImageRefusalError } from './dependency-image-source-authority';
export type { DependencyImageSourceReceipt } from './dependency-image-source-authority';
export type { DependencyImageOptions } from './dependency-image-options';
export type { DependencyImageExactGenerationRemountAuthority } from './dependency-image-options';
export { retireDependencyImage } from './dependency-image-retirement';
export type { DependencyImageRetirementOptions } from './dependency-image-retirement';
export type {
  DependencyImageExpectedLease,
  DependencyImageDetachOptions,
  DependencyImageLeaseReconciliation,
  DependencyImageMount,
  DependencyImagePreparedLease,
} from './dependency-image-lease-receipt';
async function ensurePrivateRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const entry = await lstat(root);
  const [canonical, canonicalParent] = await Promise.all([
    realpath(root),
    realpath(path.dirname(root)),
  ]);
  if (!entry.isDirectory() || entry.isSymbolicLink()
    || canonical !== path.join(canonicalParent, path.basename(root))
    || (process.platform !== 'win32' && (entry.mode & 0o077) !== 0)) {
    throw new DependencyImageRefusalError('Dependency image registry is not an exact private directory.');
  }
}
function registryRoot(options: DependencyImageOptions): string {
  return path.resolve(options.registryRoot ?? path.join(getDataDir(), 'dependency-images'));
}
async function writeManifest(filePath: string, manifest: DependencyImageManifest) {
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
  return writeAndSealExactDependencyFile(filePath, bytes);
}
async function detachDevice(deviceEntry: string): Promise<void> {
  await runHdiCommand(['detach', deviceEntry, '-quiet']);
}
async function validateImageTree(
  imagePath: string,
  expectedTreeDigest: string,
  root: string,
  expectedIdentity?: { device: number; inode: number },
): Promise<void> {
  if (expectedIdentity) await assertExactDependencyFileIdentity(imagePath, expectedIdentity);
  const validationMount = path.join(root, `.validate-${randomUUID()}`);
  await mkdir(validationMount, { mode: 0o700 });
  let deviceEntry: string | null = null;
  try {
    const attached = await runHdiCommand([
      'attach', '-readonly', '-nobrowse', '-owners', 'on',
      '-mountpoint', validationMount, '-plist', imagePath,
    ]);
    const validation = await parseDependencyValidationAttachInfo(attached.stdout);
    deviceEntry = validation.deviceEntry;
    if (await realpath(validation.mountPath) !== await realpath(validationMount)) {
      throw new DependencyImageRefusalError('Dependency image validation mount was not exact.');
    }
    if (await digestDependencyTree(validationMount) !== expectedTreeDigest) {
      throw new DependencyImageRefusalError('Dependency image content differs from its validated source tree.');
    }
    const live = (await mountedDependencyImages()).find((entry) => entry.deviceEntry === deviceEntry);
    if (!live || live.imagePath !== path.resolve(imagePath) || live.writable) {
      throw new DependencyImageRefusalError('Dependency image did not validate as an exact read-only mount.');
    }
    if (expectedIdentity) await assertExactDependencyFileIdentity(imagePath, expectedIdentity);
  } finally {
    if (deviceEntry) await detachDevice(deviceEntry);
    await rmdir(validationMount).catch(() => undefined);
  }
}
async function readManifest(record: DependencySeedImageRecord): Promise<DependencyImageManifest> {
  if (record.manifestDevice === null || record.manifestInode === null || !record.manifestDigest) {
    throw new DependencyImageRefusalError('Dependency image manifest identity drifted.');
  }
  let bytes: Buffer;
  try {
    bytes = await readExactDependencyFile(record.manifestPath, {
      device: record.manifestDevice, inode: record.manifestInode, digest: record.manifestDigest,
    });
  } catch {
    throw new DependencyImageRefusalError('Dependency image manifest digest does not match durable authority.');
  }
  const parsed = JSON.parse(bytes.toString('utf8')) as Partial<DependencyImageManifest>;
  const keys = Object.keys(parsed).sort().join(',');
  if (keys !== 'generation,imageDigest,recipeKey,treeDigest,version'
    || parsed.version !== 1
    || parsed.recipeKey !== record.recipeKey
    || parsed.generation !== record.generation
    || parsed.imageDigest !== record.imageDigest
    || typeof parsed.treeDigest !== 'string') {
    throw new DependencyImageRefusalError('Dependency image manifest is not canonical.');
  }
  return parsed as DependencyImageManifest;
}
async function verifyReadyImage(record: DependencySeedImageRecord, expectedState: 'built' | 'ready' = 'ready', structurally = false): Promise<DependencyImageManifest> {
  if (record.state !== expectedState
    || record.imageDevice === null
    || record.imageInode === null
    || !record.imageDigest
    || !record.manifestDigest) {
    throw new DependencyImageRefusalError('Dependency image has no complete durable publication receipt.');
  }
  try {
    await readExactDependencyFile(record.imagePath, {
      device: record.imageDevice, inode: record.imageInode, digest: record.imageDigest,
    });
  } catch {
    throw new DependencyImageRefusalError('Dependency image identity or content drifted after publication.');
  }
  const manifest = await readManifest(record);
  if (structurally) {
    await runHdiCommand(['verify', record.imagePath]);
    await validateImageTree(
      record.imagePath,
      manifest.treeDigest,
      path.dirname(path.dirname(record.imagePath)),
      { device: record.imageDevice, inode: record.imageInode },
    );
  }
  return manifest;
}
async function retireStagingDirectory(record: DependencySeedImageRecord): Promise<void> {
  let entry;
  try {
    entry = await lstat(record.stagingDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()
    || entry.dev !== record.stagingDevice || entry.ino !== record.stagingInode) {
    throw new DependencyImageRefusalError('Dependency image staging authority drifted; it was preserved.');
  }
  await purgeExactDirectory(
    record.stagingDirectory,
    { device: record.stagingDevice, inode: record.stagingInode },
  );
}
async function reconcileBuiltImage(record: DependencySeedImageRecord,
  publisher: DependencyImagePublisherAuthority,
  afterImageRenamed?: DependencyImageOptions['afterImageRenamed']): Promise<DependencySeedImageRecord> {
  if (record.state !== 'built'
    || record.imageDevice === null
    || record.imageInode === null
    || !record.imageDigest
    || !record.manifestDigest) {
    throw new DependencyImageRefusalError('Dependency image publication is incomplete and cannot be adopted.');
  }
  const stagingManifest = `${record.stagingPath}.manifest.json`;
  const imageAuthority = {
    device: record.imageDevice, inode: record.imageInode, digest: record.imageDigest,
  };
  const imagePath = await exactDependencyFileAt(
    [record.imagePath, record.stagingPath], imageAuthority,
  );
  if (!imagePath) {
    throw new DependencyImageRefusalError('Dependency image generation lost its exact built inode.');
  }
  if (imagePath === record.stagingPath) await rename(record.stagingPath, record.imagePath);
  if (record.manifestDevice === null || record.manifestInode === null) {
    throw new DependencyImageRefusalError('Dependency image generation lost manifest inode authority.');
  }
  const manifestPath = await exactDependencyFileAt(
    [record.manifestPath, stagingManifest],
    { device: record.manifestDevice, inode: record.manifestInode, digest: record.manifestDigest },
  );
  if (!manifestPath) {
    throw new DependencyImageRefusalError('Dependency image generation lost its exact manifest.');
  }
  if (manifestPath === stagingManifest) await rename(stagingManifest, record.manifestPath);
  await afterImageRenamed?.(record.imagePath);
  await verifyReadyImage(record, 'built', true);
  await retireStagingDirectory(record);
  const ready = publishDependencySeedImage({
    recipeKey: record.recipeKey,
    generation: record.generation,
    publisherPid: publisher.pid,
    publisherIdentity: publisher.identity,
  });
  return ready;
}
async function reconcileBuildingImage(
  record: DependencySeedImageRecord,
  treeDigest: string,
  root: string,
  publisher: DependencyImagePublisherAuthority,
): Promise<DependencySeedImageRecord | null> {
  try {
    const image = await lstat(record.stagingPath);
    if (!image.isFile() || image.isSymbolicLink() || image.nlink !== 1) return null;
    const expectedImage = { device: image.dev, inode: image.ino };
    await validateImageTree(record.stagingPath, treeDigest, root, expectedImage);
    const imageAuthority = await sealExactDependencyFile(record.stagingPath, expectedImage);
    const manifest: DependencyImageManifest = {
      version: 1, recipeKey: record.recipeKey, generation: record.generation,
      treeDigest, imageDigest: imageAuthority.digest,
    };
    const stagedManifest = `${record.stagingPath}.manifest.json`;
    const expectedBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
    const manifestDigest = createHash('sha256').update(expectedBytes).digest('hex');
    let manifestAuthority;
    try {
      await lstat(stagedManifest);
      manifestAuthority = await sealExactDependencyFile(stagedManifest);
      if (manifestAuthority.digest !== manifestDigest) {
        throw new DependencyImageRefusalError('Dependency image staged manifest drifted.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      manifestAuthority = await writeManifest(stagedManifest, manifest);
    }
    recordBuiltDependencySeedImage({
      recipeKey: record.recipeKey,
      generation: record.generation,
      publisherPid: publisher.pid,
      publisherIdentity: publisher.identity,
      imageDevice: imageAuthority.device,
      imageInode: imageAuthority.inode,
      imageDigest: imageAuthority.digest,
      manifestDevice: manifestAuthority.device,
      manifestInode: manifestAuthority.inode,
      manifestDigest: manifestAuthority.digest,
    });
    return reconcileBuiltImage(readDependencySeedImage(record.recipeKey)!, publisher);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}
const activePublications = new Map<string, Promise<DependencySeedImageRecord>>();
const MAX_PUBLICATION_REPAIR_ATTEMPTS = 3;

async function publishDependencyImageExclusive(
  receipt: DependencyImageSourceReceipt,
  options: DependencyImageOptions,
): Promise<DependencySeedImageRecord> {
  if (process.platform !== 'darwin') {
    throw new DependencyImageRefusalError('APFS dependency images are only available on macOS.');
  }
  assertDependencyImageSourceReceipt(receipt);
  await assertCurrentDependencyImageSource(receipt);
  const root = registryRoot(options);
  const imagesRoot = path.join(root, 'images');
  const stagingRoot = path.join(root, 'staging');
  await ensurePrivateRoot(root);
  await ensurePrivateRoot(imagesRoot);
  await ensurePrivateRoot(stagingRoot);
  const publisher = await currentDependencyImageOwner();
  const deadline = Date.now() + Math.max(0, options.publisherWaitMs ?? 30_000);
  const pollMs = Math.max(10, options.publisherPollMs ?? 50);
  let repairAttempts = 0;
  while (repairAttempts <= MAX_PUBLICATION_REPAIR_ATTEMPTS) {
    let existing = readDependencySeedImage(receipt.recipeKey);
    if (existing?.state === 'ready') {
      const manifest = await verifyReadyImage(existing);
      if (manifest.treeDigest !== receipt.treeDigest) {
        throw new DependencyImageRefusalError(
          'Ready dependency image differs from the install-time source receipt.',
        );
      }
      return existing;
    }
    if (existing?.state === 'retiring') {
      throw new DependencyImageRefusalError('A dependency image generation is retiring.');
    }
    if (existing) {
      assertDependencyImagePublicationSource(existing, receipt);
      if (!isMetadataLockProcessIdentity(existing.publisherIdentity)
        || existing.publisherPid === null) {
        throw new DependencyImageRefusalError(
          'Unfinished dependency image has no durable publisher authority.',
        );
      }
      if (!sameDependencyImagePublisher(existing, publisher)) {
        const owner = await probeMetadataLockProcessIdentity(existing.publisherPid);
        if (owner.state === 'unknown') {
          throw new DependencyImageRefusalError(
            'Concurrent dependency image publisher authority is unknown.',
          );
        }
        if (owner.state === 'live'
          && sameMetadataLockProcessIdentity(owner.identity, existing.publisherIdentity)) {
          if (Date.now() >= deadline) {
            throw new DependencyImageRefusalError(
              'A live process still owns this dependency image publication.',
            );
          }
          await delay(pollMs);
          continue;
        }
        const adopted = adoptDependencySeedImagePublisher({
          recipeKey: existing.recipeKey,
          generation: existing.generation,
          priorPublisherPid: existing.publisherPid,
          priorPublisherIdentity: existing.publisherIdentity,
          publisherPid: publisher.pid,
          publisherIdentity: publisher.identity,
        });
        if (!adopted) continue;
        existing = adopted;
      }
      if (existing.state === 'built') {
        return reconcileBuiltImage(existing, publisher, options.afterImageRenamed);
      }
      try {
        const recovered = await reconcileBuildingImage(
          existing, receipt.treeDigest, root, publisher,
        );
        if (recovered) return recovered;
      } catch {
        // This publisher owns the exact staging receipt and repairs it below.
      }
      repairAttempts += 1;
      if (repairAttempts > MAX_PUBLICATION_REPAIR_ATTEMPTS) break;
      await retireStagingDirectory(existing);
      removeUnpublishedDependencySeedImage({
        recipeKey: existing.recipeKey,
        generation: existing.generation,
        publisherPid: publisher.pid,
        publisherIdentity: publisher.identity,
      });
      continue;
    }

    const generation = randomUUID();
    const imagePath = path.join(imagesRoot, `${receipt.recipeKey}-${generation}.dmg`);
    const manifestPath = path.join(imagesRoot, `${receipt.recipeKey}-${generation}.manifest.json`);
    const stagingDirectory = path.join(stagingRoot, `${receipt.recipeKey}-${generation}`);
    await mkdir(stagingDirectory, { mode: 0o700 });
    const stagingIdentity = await lstat(stagingDirectory);
    const stagingPath = path.join(stagingDirectory, 'image.dmg');
    const stagedManifest = `${stagingPath}.manifest.json`;
    const claimed = beginDependencySeedImage({
      recipeKey: receipt.recipeKey,
      generation,
      sourceReceiptId: receipt.receiptId,
      sourceTreeDigest: receipt.treeDigest,
      publisherPid: publisher.pid,
      publisherIdentity: publisher.identity,
      imagePath,
      manifestPath,
      stagingDirectory,
      stagingPath,
      stagingDevice: stagingIdentity.dev,
      stagingInode: stagingIdentity.ino,
    });
    if (claimed.generation !== generation) {
      await purgeExactDirectory(
        stagingDirectory,
        { device: stagingIdentity.dev, inode: stagingIdentity.ino },
      );
      continue;
    }
    try {
      await assertCurrentDependencyImageSource(receipt);
      await runHdiCommand([
        // NEVER pass `-quiet` here: it suppresses hdiutil's failure cause on
        // stderr too, so a full volume surfaced as a blank `hdiutil failed (1):`
        // with nothing an operator or the escalation chain could act on. The
        // sealing itself was already fail-closed; only the diagnosis was lost.
        'create', '-srcfolder', receipt.sourcePath, '-format', 'UDRO', '-fs', 'APFS',
        '-volname', `o8deps-${receipt.recipeKey.slice(0, 12)}`,
        '-atomic', stagingPath,
      ]);
      await options.afterImageCreated?.(stagingPath);
      const created = await lstat(stagingPath);
      if (!created.isFile() || created.isSymbolicLink() || created.nlink !== 1) {
        throw new DependencyImageRefusalError('Built dependency image is not an exact private file.');
      }
      const expectedImage = { device: created.dev, inode: created.ino };
      await validateImageTree(stagingPath, receipt.treeDigest, root, expectedImage);
      await options.afterImageValidated?.(stagingPath);
      const imageAuthority = await sealExactDependencyFile(stagingPath, expectedImage);
      const manifestAuthority = await writeManifest(stagedManifest, {
        version: 1, recipeKey: receipt.recipeKey, generation,
        treeDigest: receipt.treeDigest, imageDigest: imageAuthority.digest,
      });
      await options.beforeImageRecorded?.(stagingPath);
      recordBuiltDependencySeedImage({
        recipeKey: receipt.recipeKey,
        generation,
        publisherPid: publisher.pid,
        publisherIdentity: publisher.identity,
        imageDevice: imageAuthority.device,
        imageInode: imageAuthority.inode,
        imageDigest: imageAuthority.digest,
        manifestDevice: manifestAuthority.device,
        manifestInode: manifestAuthority.inode,
        manifestDigest: manifestAuthority.digest,
      });
    } catch (error) {
      const current = readDependencySeedImage(receipt.recipeKey);
      if (current?.generation === generation && current.state === 'building'
        && sameDependencyImagePublisher(current, publisher)) {
        await retireStagingDirectory(current);
        removeUnpublishedDependencySeedImage({
          recipeKey: current.recipeKey,
          generation: current.generation,
          publisherPid: publisher.pid,
          publisherIdentity: publisher.identity,
        });
      }
      throw error;
    }
    const ready = await reconcileBuiltImage(
      readDependencySeedImage(receipt.recipeKey)!,
      publisher,
      options.afterImageRenamed,
    );
    const manifest = await verifyReadyImage(ready);
    if (manifest.treeDigest !== receipt.treeDigest) {
      throw new DependencyImageRefusalError(
        'Published dependency image lost its source content receipt.',
      );
    }
    return ready;
  }
  throw new DependencyImageRefusalError(
    'Dependency image publication exceeded three exact staging repairs.',
  );
}

export async function publishDependencyImage(
  receipt: DependencyImageSourceReceipt,
  options: DependencyImageOptions = {},
): Promise<DependencySeedImageRecord> {
  const key = `${registryRoot(options)}\0${receipt.recipeKey}`;
  const running = activePublications.get(key);
  if (running) {
    const image = await running;
    const manifest = await verifyReadyImage(image);
    if (manifest.treeDigest !== receipt.treeDigest) {
      throw new DependencyImageRefusalError(
        'Concurrent dependency image publication has a different install-time source receipt.',
      );
    }
    return image;
  }
  const task = publishDependencyImageExclusive(receipt, options);
  activePublications.set(key, task);
  try {
    return await task;
  } finally {
    if (activePublications.get(key) === task) activePublications.delete(key);
  }
}
async function adoptExactLease(
  lease: DependencySeedLeaseRecord,
  image: DependencySeedImageRecord,
  owner: DependencyImagePublisherAuthority,
): Promise<DependencyImageMount> {
  if (lease.state !== 'mounted') {
    throw new DependencyImageRefusalError(
      'A cleanup-only dependency attach receipt cannot be promoted after interruption.',
    );
  }
  const classified = await classifyDependencyLeaseDevices({ lease, imagePath: image.imagePath });
  if (classified.state !== 'exact') {
    throw new DependencyImageRefusalError(
      classified.state === 'absent'
        ? 'Persisted dependency mount tuple is absent.' : classified.reason,
    );
  }
  const authority = classified.authority;
  const mountedVolumes = authority.systemEntities.filter((entity) => entity.mountPath !== null);
  if (mountedVolumes.length !== 1 || mountedVolumes[0]!.mountPath !== lease.mountPath
    || authority.baseDevice !== image.imageDevice || authority.baseInode !== image.imageInode) {
    throw new DependencyImageRefusalError('Persisted dependency mount authority is not exact.');
  }
  if (!isMetadataLockProcessIdentity(lease.ownerIdentity)) {
    throw new DependencyImageRefusalError('Persisted dependency mount owner is invalid.');
  }
  const prior = await probeMetadataLockProcessIdentity(lease.ownerPid);
  if (prior.state === 'unknown'
    || (prior.state === 'live'
      && !sameMetadataLockProcessIdentity(prior.identity, owner.identity)
      && sameMetadataLockProcessIdentity(prior.identity, lease.ownerIdentity))) {
    throw new DependencyImageRefusalError('A live process still owns this dependency mount.');
  }
  const shadow = await lstat(lease.shadowPath);
  const mount = await lstat(lease.mountPath);
  const adopted = bindMountedDependencySeedLease({
    leaseId: lease.leaseId,
    imagePath: image.imagePath,
    deviceEntry: authority.rootDeviceEntry,
    systemEntities: authority.systemEntities,
    helperPid: authority.helperPid,
    helperIdentity: authority.helperIdentity,
    baseDevice: authority.baseDevice,
    baseInode: authority.baseInode,
    shadowDevice: shadow.dev,
    shadowInode: shadow.ino,
    mountDevice: mount.dev,
    mountInode: mount.ino,
    ownerPid: owner.pid,
    ownerIdentity: owner.identity,
  });
  return asMount(adopted, image);
}
export async function lookupReadyDependencyImage(
  recipeKey: string,
): Promise<DependencySeedImageRecord | null> {
  const image = readDependencySeedImage(recipeKey);
  if (!image) return null;
  if (image.state !== 'ready') {
    throw new DependencyImageRefusalError('Dependency image generation is incomplete.');
  }
  await verifyReadyImage(image);
  return image;
}
export async function mountDependencyImage(
  workspacePath: string,
  installCommand: string,
  authority: DependencyInstallReceipt | DependencyInstallRecipe,
  options: DependencyImageOptions = {},
): Promise<DependencyImageMount> {
  if (process.platform !== 'darwin') {
    throw new DependencyImageRefusalError('APFS dependency images are only available on macOS.');
  }
  const workspace = path.resolve(workspacePath);
  const recipe = 'recipe' in authority ? authority.recipe : authority;
  await rederiveDependencyImageRecipeAuthority(workspace, installCommand, recipe, options);
  const image = await lookupReadyDependencyImage(recipe.key);
  if (!image) throw new DependencyImageRefusalError('No ready dependency image matches this recipe.');
  if (options.expectedLease && options.exactGenerationRemount) {
    throw new DependencyImageRefusalError(
      'Dependency image mount cannot adopt a lease and remount a generation together.',
    );
  }
  if (options.exactGenerationRemount && (
    options.exactGenerationRemount.recipeKey !== recipe.key
    || options.exactGenerationRemount.generation !== image.generation
    || path.resolve(options.exactGenerationRemount.workspacePath) !== workspace
  )) {
    throw new DependencyImageRefusalError(
      'Ready dependency image differs from the exact remount generation authority.',
    );
  }
  const manifest = await verifyReadyImage(image);
  const owner = await currentDependencyImageOwner();
  const existing = findDependencySeedLeaseForWorkspace(workspace);
  assertExpectedDependencyImageLease(existing, options.expectedLease);
  if (existing) {
    if (options.exactGenerationRemount) {
      throw new DependencyImageRefusalError(
        'Exact dependency generation remount found an existing durable lease.',
      );
    }
    if (existing.recipeKey !== image.recipeKey || existing.generation !== image.generation) {
      throw new DependencyImageRefusalError(
        'Persisted dependency mount names another image generation.',
      );
    }
    return adoptExactLease(existing, image, owner);
  }
  if (options.expectedLease) {
    throw new DependencyImageRefusalError('Expected dependency mount lease is no longer durable.');
  }
  const mountPath = path.join(workspace, 'node_modules');
  try {
    const entry = await lstat(mountPath);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (await readdir(mountPath)).length !== 0) {
      throw new DependencyImageRefusalError('Dependency image mountpoint is not an empty exact directory.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(mountPath, { mode: 0o700 });
  }
  const canonicalWorkspace = await realpath(workspace);
  if (!dependencyPathInside(await realpath(mountPath), canonicalWorkspace)) {
    throw new DependencyImageRefusalError('Dependency image mountpoint escapes its workspace.');
  }
  const root = registryRoot(options);
  const shadowsRoot = path.join(root, 'shadows');
  await ensurePrivateRoot(root);
  await ensurePrivateRoot(shadowsRoot);
  const leaseId = randomUUID();
  const shadowPath = path.join(shadowsRoot, `${recipe.key}-${leaseId}.shadow`);
  const lease = beginDependencySeedLease({
    leaseId,
    recipeKey: image.recipeKey,
    generation: image.generation,
    workspacePath: workspace,
    shadowPath,
    mountPath,
    ownerPid: owner.pid,
    ownerIdentity: owner.identity,
  });
  const imageAuthority = {
    device: image.imageDevice!, inode: image.imageInode!, digest: image.imageDigest!,
  };
  let attachStarted = false;
  try {
    await options.afterLeasePrepared?.(dependencyImagePreparedLease(lease));
    return await withHeldExactDependencyFile(image.imagePath, imageAuthority, async (heldImage) => {
      await options.afterImageVerifiedBeforeAttach?.(image.imagePath);
      attachStarted = true;
      const attach = await runHdiCommand([
        'attach', '-noverify', '-nobrowse', '-owners', 'on', '-mountpoint', mountPath,
        '-shadow', shadowPath, '-plist', image.imagePath,
      ]);
      await options.afterAttachCommand?.(leaseId);
      const attachInfo = await parseDependencyAttachInfo(attach.stdout);
      const cleanupAuthority = await captureDependencyImageAttachCleanupAuthority({
        attach: attachInfo,
        imagePath: image.imagePath,
        shadowPath,
        mountPath,
      });
      const leaseAuthority = {
        leaseId,
        imagePath: image.imagePath,
        deviceEntry: cleanupAuthority.rootDeviceEntry,
        systemEntities: cleanupAuthority.systemEntities,
        helperPid: cleanupAuthority.helperPid,
        helperIdentity: cleanupAuthority.helperIdentity,
        baseDevice: cleanupAuthority.baseDevice,
        baseInode: cleanupAuthority.baseInode,
        shadowDevice: cleanupAuthority.shadowDevice,
        shadowInode: cleanupAuthority.shadowInode,
        mountDevice: cleanupAuthority.mountDevice,
        mountInode: cleanupAuthority.mountInode,
      };
      recordAttachedDependencySeedLease(leaseAuthority);
      await options.afterAttach?.(leaseId);
      const usableAttach = {
        attach: attachInfo,
        authority: cleanupAuthority,
        imagePath: image.imagePath,
        shadowPath,
        mountPath,
        heldImage,
      };
      await assertDependencyImageAttachUsable(usableAttach);
      if (await digestDependencyTree(mountPath) !== manifest.treeDigest) {
        throw new DependencyImageRefusalError('Mounted dependency image tree differs from publication authority.');
      }
      const cleanupLease = readDependencySeedLease(leaseId);
      if (!cleanupLease) {
        throw new DependencyImageRefusalError(
          'Dependency image attach lost its cleanup receipt before acceptance.',
        );
      }
      const finalDevice = await classifyDependencyLeaseDevices({
        lease: cleanupLease,
        imagePath: image.imagePath,
        expectedAuthority: cleanupAuthority,
      });
      if (finalDevice.state !== 'exact') {
        const reason = finalDevice.state === 'absent'
          ? 'Dependency image attach disappeared before acceptance.' : finalDevice.reason;
        throw new DependencyImageRefusalError(reason);
      }
      await assertDependencyImageAttachUsable(usableAttach);
      return asMount(bindMountedDependencySeedLease(leaseAuthority), image);
    });
  } catch (error) {
    if (!attachStarted) {
      removePreparedDependencySeedLease(leaseId);
    } else {
      try {
        const cleanupLease = readDependencySeedLease(leaseId);
        if (cleanupLease) {
          await requestDependencyMountLeaseCleanup(cleanupLease, image, detachDevice);
        }
      } catch (cleanupError) {
        console.warn(
          `[dependency-image] Failed attach cleanup is durably blocked for lease ${leaseId}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }
    throw error;
  }
}
export async function detachDependencyImageLease(leaseId: string,
  options: DependencyImageDetachOptions = {}): Promise<void> {
  const lease = readDependencySeedLease(leaseId);
  if (!lease) return;
  const image = readDependencySeedImage(lease.recipeKey);
  const exactImage = image?.generation === lease.generation ? image : null;
  if (!exactImage && !lease.attachedImagePath) {
    blockDependencySeedLeaseCleanup(leaseId, 'Dependency mount lost its image generation authority.');
    throw new DependencyImageRefusalError('Dependency mount lost its image generation authority.');
  }
  await requestDependencyMountLeaseCleanup(lease, exactImage, detachDevice, options);
}
export async function reconcileDependencyImageLeases(): Promise<DependencyImageLeaseReconciliation[]> {
  const outcomes: DependencyImageLeaseReconciliation[] = [];
  for (const lease of listDependencySeedLeases()) {
    const prepared = dependencyImagePreparedLease(lease);
    try {
      const preparedState = await cancelAbandonedPreparedDependencyImageLease(lease);
      if (preparedState === 'cancelled') {
        outcomes.push({ ...prepared, state: 'detached' });
        continue;
      }
      if (preparedState === 'owner-live') {
        outcomes.push({
          ...prepared,
          state: 'blocked',
          note: 'A live process still owns this prepared dependency mount.',
        });
        continue;
      }
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      blockDependencySeedLeaseCleanup(lease.leaseId, note);
      outcomes.push({ ...prepared, state: 'blocked', note });
      continue;
    }
    const image = readDependencySeedImage(lease.recipeKey);
    const exactImage = image?.generation === lease.generation ? image : null;
    if (!exactImage && !lease.attachedImagePath) {
      const note = 'Dependency mount lost its image generation authority.';
      blockDependencySeedLeaseCleanup(lease.leaseId, note);
      outcomes.push({ ...prepared, state: 'blocked', note });
      continue;
    }
    if (lease.state === 'mounted' && exactImage) {
      try {
        await verifyReadyImage(exactImage);
        await adoptExactLease(lease, exactImage, await currentDependencyImageOwner());
        outcomes.push({ ...prepared, state: 'mounted' });
        continue;
      } catch (error) {
        if (lease.state === 'mounted') {
          const note = error instanceof Error ? error.message : String(error);
          blockDependencySeedLeaseCleanup(lease.leaseId, note);
          outcomes.push({ ...prepared, state: 'blocked', note });
          continue;
        }
        // The durable cleanup reconciler classifies and preserves ambiguous authority below.
      }
    }
    try {
      await reconcileDependencyMountLeaseCleanup(lease.leaseId, exactImage, detachDevice);
      outcomes.push({ ...prepared, state: 'detached' });
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      console.warn(
        `[dependency-image] Lease reconciliation remains blocked for ${lease.leaseId}: ${note}`,
      );
      outcomes.push({ ...prepared, state: 'blocked', note });
    }
  }
  return outcomes;
}
