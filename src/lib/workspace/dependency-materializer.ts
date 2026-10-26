import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { defaultApfsDependencyImages } from '@/lib/operator/apfs-dependency-images-default';
import { getApfsCowCapability } from '@/lib/worktree/apfs';
import {
  captureWorktreeMaterializationIdentity,
  type WorktreeMaterializationIdentity,
} from '@/lib/worktree/materialization-identity';
import {
  captureDependencyImageSourceReceipt,
  detachDependencyImageLease,
  lookupReadyDependencyImage,
  mountDependencyImage,
  publishDependencyImage,
  reconcileDependencyImageLeases,
  type DependencyImageLeaseReconciliation,
  type DependencyImageExactGenerationRemountAuthority,
  type DependencyImagePreparedLease,
  type DependencyImageSourceReceipt,
} from './apfs-dependency-image';
import { normalizedNamespacePath } from './dependency-image-device-authority';
import {
  auditPrivateDependencyView,
  deriveDependencyInstallRecipe,
  runDependencyInstall,
  type DependencyInstallOptions,
  type DependencyInstallRecipe,
  type DependencyInstallReceipt,
} from './dependency-install';
import { resolveApfsDependencyImagesOverride } from './dependency-image-policy';
import { tryCloneDependencyDirectory, type DependencySelection } from './dependency-directory-clone';
import { profileDependencyClone } from './dependency-clone-profile';
import { recordInstalledDependencyPayload } from './dependency-installed-pool';

export { APFS_DEPENDENCY_IMAGES_ENV } from './dependency-image-policy';

// Durable lease paths are stored in the namespace the disk-image tooling reports,
// so a caller-supplied canonical path only compares equal after the same collapse.
function sameWorkspaceNamespace(first: string, second: string): boolean {
  return normalizedNamespacePath(first) === normalizedNamespacePath(second);
}

export interface DependencyMaterializationReceipt {
  mode: 'native' | 'image';
  status: 'prepared' | 'mounted';
  installCommand: string;
  recipeKey: string;
  leaseId: string | null;
  generation: string | null;
  workspaceDevice: number;
  workspaceInode: number;
  source?: 'directory-clone' | 'dependency-pool';
}

export interface DependencyMaterializationResult {
  receipt: DependencyMaterializationReceipt;
  installReceipt: DependencyInstallReceipt | null;
}

export interface DependencyMaterializationWorkspaceAuthority {
  workspacePath: string;
  receipt: DependencyMaterializationReceipt;
  promoteMounted: (receipt: DependencyMaterializationReceipt) => Promise<void>;
  markUnavailable: (receipt: DependencyMaterializationReceipt | null) => Promise<void>;
}

export interface DependencyMaterializationReconciliationReceipt {
  inspected: number;
  adopted: number;
  detachedUnowned: number;
  unavailable: number;
  blocked: number;
  complete: boolean;
}

export interface DependencyImageReadyAuthority {
  recipeKey: string;
  generation: string;
}

export interface DependencyImageProvider {
  lookupReadyImage(input: {
    recipe: DependencyInstallRecipe;
    registryRoot?: string;
  }): Promise<
    | { status: 'missing' }
    | { status: 'ready'; authority: DependencyImageReadyAuthority }
  >;
  mount(input: {
    workspacePath: string;
    installCommand: string;
    recipe: DependencyInstallRecipe;
    authority: DependencyImageReadyAuthority;
    registryRoot?: string;
    afterLeasePrepared?: (lease: DependencyImagePreparedLease) => Promise<void>;
    expectedLease?: DependencyImagePreparedLease;
    exactGenerationRemount?: DependencyImageExactGenerationRemountAuthority;
  }): Promise<{ leaseId: string; recipeKey: string; generation: string }>;
  captureSource(input: {
    workspacePath: string;
    installCommand: string;
    installReceipt: DependencyInstallReceipt;
    registryRoot?: string;
  }): Promise<DependencyImageSourceReceipt>;
  publish(input: {
    sourceReceipt: DependencyImageSourceReceipt;
    registryRoot?: string;
  }): Promise<{ recipeKey: string; generation: string }>;
  detach(leaseId: string, input: { registryRoot?: string }): Promise<void>;
  reconcile(): Promise<DependencyImageLeaseReconciliation[]>;
}

export interface DependencyMaterializerOptions extends Pick<DependencyInstallOptions,
  'run' | 'resolveVersion' | 'cacheRoot' | 'now' | 'materializationIdentity'> {
  preparedRecipe?: DependencyInstallRecipe;
  cloneSourceWorkspace?: string;
  useDependencyPool?: boolean;
  onSelection?: (selection: DependencySelection) => Promise<void>;
  /** Deterministic race seam after native publication, before source revalidation. */
  afterDependencyDirectoryClone?: () => Promise<void>;
  imageRegistryRoot?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  provider?: DependencyImageProvider;
  probeApfs?: (workspacePath: string) => Promise<boolean>;
  afterMount?: (receipt: DependencyMaterializationReceipt) => Promise<void>;
  persistReceipt?: (receipt: DependencyMaterializationReceipt | null) => Promise<void>;
  expectedLease?: DependencyImagePreparedLease;
  exactGenerationRemount?: DependencyImageExactGenerationRemountAuthority;
}

interface RootManifest {
  workspaces?: unknown;
}

function nonEmptyWorkspaceDeclaration(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (!value || typeof value !== 'object') return false;
  const packages = (value as { packages?: unknown }).packages;
  return Array.isArray(packages) && packages.length > 0;
}

async function hasWorkspaceTopology(workspacePath: string): Promise<boolean> {
  const manifest = JSON.parse(
    await readFile(path.join(workspacePath, 'package.json'), 'utf8'),
  ) as RootManifest;
  return nonEmptyWorkspaceDeclaration(manifest.workspaces);
}

export async function isDependencyImageRecipeEligible(
  workspacePath: string,
  recipe: DependencyInstallRecipe,
): Promise<boolean> {
  const packageManifestInputs = recipe.inputDigests.filter((input) => (
    input.path === 'package.json' || input.path.endsWith('/package.json')
  ));
  return recipe.packageManager === 'npm'
    && recipe.installArgs[0] === 'ci'
    && recipe.lockfile.path === 'package-lock.json'
    && recipe.lifecycleScripts === 'disabled'
    && recipe.localDependencyDigests.length === 0
    && !recipe.installArgs.includes('--workspaces')
    && packageManifestInputs.length === 1
    && !(await hasWorkspaceTopology(workspacePath));
}

export async function dependencyMaterializationWorkspaceIdentity(
  workspacePath: string,
  expected?: WorktreeMaterializationIdentity,
): Promise<WorktreeMaterializationIdentity> {
  let workspace: WorktreeMaterializationIdentity;
  try {
    workspace = await captureWorktreeMaterializationIdentity(workspacePath);
  } catch (error) {
    throw new Error('Dependency materialization workspace identity changed.', { cause: error });
  }
  if (expected && (workspace.device !== expected.device
    || workspace.inode !== expected.inode)) {
    throw new Error('Dependency materialization workspace identity changed.');
  }
  return workspace;
}

export class DependencyMaterializationRefusalError extends Error {
  readonly code = 'dependency_materialization_refused';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DependencyMaterializationRefusalError';
  }
}

const APFS_DEPENDENCY_IMAGE_PROVIDER: DependencyImageProvider = {
  async lookupReadyImage({ recipe }) {
    const image = await lookupReadyDependencyImage(recipe.key);
    if (!image) return { status: 'missing' };
    return {
      status: 'ready',
      authority: { recipeKey: image.recipeKey, generation: image.generation },
    };
  },
  async mount({
    workspacePath, installCommand, recipe, registryRoot, afterLeasePrepared, expectedLease,
    exactGenerationRemount,
  }) {
    return mountDependencyImage(workspacePath, installCommand, recipe, {
      registryRoot,
      afterLeasePrepared,
      expectedLease,
      exactGenerationRemount,
    });
  },
  async captureSource({ workspacePath, installCommand, installReceipt, registryRoot }) {
    return captureDependencyImageSourceReceipt(
      workspacePath,
      installCommand,
      installReceipt,
      { registryRoot },
    );
  },
  async publish({ sourceReceipt, registryRoot }) {
    const crashMarker = process.env.NODE_ENV === 'test' && process.env.O8_TEST_DATA_DIR_PINNED
      ? process.env.O8_TEST_DEPENDENCY_IMAGE_BEFORE_RECORD_MARKER
      : undefined;
    return publishDependencyImage(sourceReceipt, {
      registryRoot,
      beforeImageRecorded: crashMarker ? async () => {
        await writeFile(crashMarker, 'staged-before-record\n', { flag: 'wx' });
        process.kill(process.pid, 'SIGSTOP');
      } : undefined,
    });
  },
  async detach(leaseId) {
    await detachDependencyImageLease(leaseId);
  },
  async reconcile() {
    return reconcileDependencyImageLeases();
  },
};

interface PendingPublication {
  workspacePath: string;
  sourceReceipt: DependencyImageSourceReceipt;
  materialization: DependencyMaterializationReceipt;
  provider: DependencyImageProvider;
  registryRoot?: string;
}

const pendingPublications = new Map<string, PendingPublication>();
const runningPublications = new Map<string, Promise<void>>();
const activeImageMaterializations = new Map<string, {
  receipt: DependencyMaterializationReceipt;
  provider: DependencyImageProvider;
  registryRoot?: string;
}>();

function publicationKey(workspacePath: string, recipeKey: string): string {
  return `${path.resolve(workspacePath)}\0${recipeKey}`;
}

async function defaultProbeApfs(workspacePath: string): Promise<boolean> {
  const capability = await getApfsCowCapability(workspacePath);
  return capability.macos && capability.apfs;
}

async function runNativeMaterialization(
  workspacePath: string,
  installCommand: string,
  recipe: DependencyInstallRecipe,
  identity: WorktreeMaterializationIdentity,
  options: DependencyMaterializerOptions,
  queuePublication: boolean,
): Promise<DependencyMaterializationResult> {
  await options.onSelection?.({ path: 'native-install', reason: 'directory-clone-not-requested' });
  const installReceipt = await runDependencyInstall(workspacePath, installCommand, {
    run: options.run,
    resolveVersion: options.resolveVersion,
    cacheRoot: options.cacheRoot,
    now: options.now,
    materializationIdentity: options.materializationIdentity,
    preparedRecipe: recipe,
  });
  await dependencyMaterializationWorkspaceIdentity(workspacePath, {
    canonicalPath: path.resolve(workspacePath),
    device: identity.device,
    inode: identity.inode,
  });
  const receipt: DependencyMaterializationReceipt = {
    mode: 'native',
    status: 'mounted',
    installCommand,
    recipeKey: installReceipt.recipe.key,
    leaseId: null,
    generation: null,
    workspaceDevice: identity.device,
    workspaceInode: identity.inode,
  };
  if (queuePublication) {
    const provider = options.provider ?? APFS_DEPENDENCY_IMAGE_PROVIDER;
    const sourceReceipt = await provider.captureSource({
      workspacePath: path.resolve(workspacePath),
      installCommand,
      installReceipt,
      registryRoot: options.imageRegistryRoot,
    });
    if (sourceReceipt.recipeKey !== receipt.recipeKey
      || sourceReceipt.workspacePath !== path.resolve(workspacePath)
      || sourceReceipt.workspaceDevice !== receipt.workspaceDevice
      || sourceReceipt.workspaceInode !== receipt.workspaceInode) {
      throw new DependencyMaterializationRefusalError(
        'Dependency image source receipt differs from its completed native install.',
      );
    }
    pendingPublications.set(publicationKey(workspacePath, receipt.recipeKey), {
      workspacePath: path.resolve(workspacePath),
      sourceReceipt,
      materialization: receipt,
      provider,
      registryRoot: options.imageRegistryRoot,
    });
  }
  await options.persistReceipt?.(receipt);
  await recordInstalledDependencyPayload(workspacePath, identity, recipe, options);
  return { receipt, installReceipt };
}

export async function materializeDependencyInstall(
  workspacePath: string,
  installCommand: string,
  options: DependencyMaterializerOptions = {},
): Promise<DependencyMaterializationResult> {
  const workspace = path.resolve(workspacePath);
  const recipe = options.preparedRecipe ?? await profileDependencyClone('recipe', () => deriveDependencyInstallRecipe(
    workspace,
    installCommand,
    { resolveVersion: options.resolveVersion },
  ));
  const identity = await dependencyMaterializationWorkspaceIdentity(
    workspace,
    options.materializationIdentity,
  );
  const platform = options.platform ?? process.platform;
  const effectiveOverride = resolveApfsDependencyImagesOverride(options.env ?? process.env);
  const operatorDefaults = getOperatorDefaultsSync();
  const enabled = effectiveOverride
    ?? (operatorDefaults.sources.apfsDependencyImages === 'default'
      ? defaultApfsDependencyImages(platform)
      : operatorDefaults.values.apfsDependencyImages);
  if (options.expectedLease && options.exactGenerationRemount) {
    throw new DependencyMaterializationRefusalError(
      'Dependency image materialization cannot adopt a lease and remount a generation together.',
    );
  }
  const imageRequired = Boolean(options.expectedLease || options.exactGenerationRemount);
  let cloneSource: 'directory-clone' | 'dependency-pool' = 'directory-clone';
  let fallbackReason = imageRequired ? 'image-required' : 'directory-clone-not-requested';
  if (!imageRequired && options.cloneSourceWorkspace && await tryCloneDependencyDirectory({
    sourceWorkspace: options.cloneSourceWorkspace,
    platform,
    usePool: options.useDependencyPool,
    onDecision: async (decision) => {
      if (decision.path === 'fallback') fallbackReason = decision.reason;
      else {
        cloneSource = decision.path;
        await options.onSelection?.({ path: decision.path, reason: decision.reason,
          ...(decision.pool ? { pool: decision.pool } : {}) });
      }
    },
    afterClone: options.afterDependencyDirectoryClone,
    workspace,
    identity,
    recipe,
    options,
  })) {
    const receipt: DependencyMaterializationReceipt = {
      mode: 'native', status: 'mounted', installCommand, recipeKey: recipe.key,
      leaseId: null, generation: null, workspaceDevice: identity.device, workspaceInode: identity.inode,
      source: cloneSource,
    };
    await options.persistReceipt?.(receipt);
    return { receipt, installReceipt: null };
  }
  const onSelection = options.onSelection;
  options = { ...options, onSelection: (selection) => onSelection?.({ ...selection, reason: fallbackReason }) ?? Promise.resolve() };
  const invalidClone = fallbackReason === 'installed-graph-ineligible' || /^(?:pool-)?payload-/.test(fallbackReason);
  if (invalidClone || (!enabled && !imageRequired) || platform !== 'darwin'
    || !await isDependencyImageRecipeEligible(workspace, recipe)) {
    if (imageRequired) {
      throw new DependencyMaterializationRefusalError(
        'Exact dependency image remount is unavailable for this workspace recipe.',
      );
    }
    return runNativeMaterialization(
      workspace, installCommand, recipe, identity, options, false,
    );
  }
  const apfs = await (options.probeApfs ?? defaultProbeApfs)(workspace);
  if (!apfs) {
    if (imageRequired) {
      throw new DependencyMaterializationRefusalError(
        'Exact dependency image remount requires the original APFS capability.',
      );
    }
    return runNativeMaterialization(
      workspace, installCommand, recipe, identity, options, false,
    );
  }

  const provider = options.provider ?? APFS_DEPENDENCY_IMAGE_PROVIDER;
  let availability: Awaited<ReturnType<DependencyImageProvider['lookupReadyImage']>>;
  try {
    availability = await provider.lookupReadyImage({
      recipe,
      registryRoot: options.imageRegistryRoot,
    });
  } catch (error) {
    if (imageRequired) {
      throw new DependencyMaterializationRefusalError(
        `Exact dependency image remount lost ready-image authority: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return runNativeMaterialization(
      workspace, installCommand, recipe, identity, options, false,
    );
  }
  if (availability.status === 'missing') {
    if (imageRequired) {
      throw new DependencyMaterializationRefusalError(
        'Exact dependency image remount lost its ready generation authority.',
      );
    }
    return runNativeMaterialization(
      workspace, installCommand, recipe, identity, options, true,
    );
  }
  if (availability.authority.recipeKey !== recipe.key) {
    if (!imageRequired) {
      return runNativeMaterialization(
        workspace, installCommand, recipe, identity, options, false,
      );
    }
    throw new DependencyMaterializationRefusalError(
      'Ready dependency-image authority does not match the exact install recipe.',
    );
  }
  if (options.expectedLease && (
    options.expectedLease.recipeKey !== recipe.key
    || options.expectedLease.generation !== availability.authority.generation
    || !sameWorkspaceNamespace(options.expectedLease.workspacePath, workspace)
  )) {
    throw new DependencyMaterializationRefusalError(
      'Exact dependency image remount receipt differs from current workspace authority.',
    );
  }
  if (options.exactGenerationRemount && (
    options.exactGenerationRemount.recipeKey !== recipe.key
    || options.exactGenerationRemount.generation !== availability.authority.generation
    || path.resolve(options.exactGenerationRemount.workspacePath) !== workspace
  )) {
    throw new DependencyMaterializationRefusalError(
      'Exact dependency image remount generation differs from current workspace authority.',
    );
  }
  let mount: Awaited<ReturnType<DependencyImageProvider['mount']>> | null = null;
  const prepared = { receipt: null as DependencyMaterializationReceipt | null };
  try {
    await options.onSelection?.({ path: 'image', reason: fallbackReason });
    mount = await provider.mount({
      workspacePath: workspace,
      installCommand,
      recipe,
      authority: availability.authority,
      registryRoot: options.imageRegistryRoot,
      expectedLease: options.expectedLease,
      exactGenerationRemount: options.exactGenerationRemount,
      afterLeasePrepared: async (lease) => {
        if (lease.recipeKey !== recipe.key
          || lease.generation !== availability.authority.generation
          || !sameWorkspaceNamespace(lease.workspacePath, workspace)
          || (options.expectedLease && lease.leaseId !== options.expectedLease.leaseId)) {
          throw new DependencyMaterializationRefusalError(
            'Prepared dependency image lease differs from the requested workspace authority.',
          );
        }
        prepared.receipt = {
          mode: 'image',
          status: 'prepared',
          installCommand,
          recipeKey: recipe.key,
          leaseId: lease.leaseId,
          generation: lease.generation,
          workspaceDevice: identity.device,
          workspaceInode: identity.inode,
        };
        await options.persistReceipt?.(prepared.receipt);
      },
    });
    if (mount.recipeKey !== recipe.key
      || mount.generation !== availability.authority.generation) {
      throw new DependencyMaterializationRefusalError(
        'Mounted dependency image differs from its ready generation authority.',
      );
    }
    if (options.exactGenerationRemount && (
      !prepared.receipt
      || prepared.receipt.leaseId !== mount.leaseId
    )) {
      throw new DependencyMaterializationRefusalError(
        'Exact dependency generation remount did not persist its new prepared lease.',
      );
    }
    await auditPrivateDependencyView(workspace);
    await dependencyMaterializationWorkspaceIdentity(workspace, {
      canonicalPath: workspace,
      device: identity.device,
      inode: identity.inode,
    });
  } catch (error) {
    const leaseId = mount?.leaseId ?? prepared.receipt?.leaseId;
    if (leaseId) {
      try {
        await provider.detach(leaseId, { registryRoot: options.imageRegistryRoot });
        await options.persistReceipt?.(null);
      } catch (detachError) {
        throw new DependencyMaterializationRefusalError(
          `Dependency image mount failed and exact detach was incomplete: ${detachError instanceof Error ? detachError.message : String(detachError)}`,
          { cause: error },
        );
      }
    }
    if (!imageRequired) {
      return runNativeMaterialization(
        workspace, installCommand, recipe, identity, options, false,
      );
    }
    throw new DependencyMaterializationRefusalError(
      `Dependency image mount was refused: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!mount) {
    throw new DependencyMaterializationRefusalError(
      'Dependency image mount returned no exact lease.',
    );
  }
  const receipt: DependencyMaterializationReceipt = {
    mode: 'image',
    status: 'mounted',
    installCommand,
    recipeKey: recipe.key,
    leaseId: mount.leaseId,
    generation: mount.generation,
    workspaceDevice: identity.device,
    workspaceInode: identity.inode,
  };
  try {
    await options.afterMount?.(receipt);
    await options.persistReceipt?.(receipt);
  } catch (error) {
    try {
      await provider.detach(receipt.leaseId!, { registryRoot: options.imageRegistryRoot });
      await options.persistReceipt?.(null);
    } catch (detachError) {
      throw new DependencyMaterializationRefusalError(
        `Dependency image post-mount failure could not exact-detach its lease: ${detachError instanceof Error ? detachError.message : String(detachError)}`,
        { cause: error },
      );
    }
    throw new DependencyMaterializationRefusalError(
      `Dependency image post-mount verification failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  activeImageMaterializations.set(workspace, {
    receipt,
    provider,
    registryRoot: options.imageRegistryRoot,
  });
  return { receipt, installReceipt: null };
}

/** Start a previously admitted publication without extending workspace readiness latency. */
export function queueDependencyImagePublication(
  workspacePath: string,
  materialization: DependencyMaterializationReceipt,
): Promise<void> | null {
  if (materialization.mode !== 'native') return null;
  const key = publicationKey(workspacePath, materialization.recipeKey);
  const running = runningPublications.get(key);
  if (running) return running;
  const pending = pendingPublications.get(key);
  if (!pending) return null;
  pendingPublications.delete(key);
  const task = Promise.resolve().then(async () => {
    await dependencyMaterializationWorkspaceIdentity(
      pending.workspacePath,
      {
        canonicalPath: pending.workspacePath,
        device: pending.materialization.workspaceDevice,
        inode: pending.materialization.workspaceInode,
      },
    );
    const published = await pending.provider.publish({
      sourceReceipt: pending.sourceReceipt,
      registryRoot: pending.registryRoot,
    });
    if (published.recipeKey !== pending.materialization.recipeKey) {
      throw new DependencyMaterializationRefusalError(
        'Published dependency image changed its exact recipe key.',
      );
    }
  }).catch((error) => {
    console.warn(
      `[dependency-image] Background publication failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }).finally(() => {
    runningPublications.delete(key);
  });
  runningPublications.set(key, task);
  return task;
}

export async function detachDependencyMaterialization(
  workspacePath: string,
  expected?: DependencyMaterializationReceipt,
  options: Pick<DependencyMaterializerOptions, 'provider' | 'imageRegistryRoot'> = {},
): Promise<void> {
  const workspace = path.resolve(workspacePath);
  const active = activeImageMaterializations.get(workspace);
  if (expected && active && (
    expected.mode !== active.receipt.mode
    || expected.recipeKey !== active.receipt.recipeKey
    || expected.leaseId !== active.receipt.leaseId
    || expected.generation !== active.receipt.generation
    || expected.workspaceDevice !== active.receipt.workspaceDevice
    || expected.workspaceInode !== active.receipt.workspaceInode
  )) {
    throw new DependencyMaterializationRefusalError(
      'Dependency image detach receipt differs from the active workspace authority.',
    );
  }
  const materialization = expected ?? active?.receipt;
  if (!materialization || materialization.mode !== 'image') return;
  const identity = await dependencyMaterializationWorkspaceIdentity(workspace);
  if (identity.device !== materialization.workspaceDevice
    || identity.inode !== materialization.workspaceInode) {
    throw new DependencyMaterializationRefusalError(
      'Dependency image detach refused a replaced workspace root.',
    );
  }
  await (options.provider ?? active?.provider ?? APFS_DEPENDENCY_IMAGE_PROVIDER).detach(materialization.leaseId!, {
    registryRoot: options.imageRegistryRoot ?? active?.registryRoot,
  });
  activeImageMaterializations.delete(workspace);
}

export async function reconcileDependencyMaterializations(
  authorities: DependencyMaterializationWorkspaceAuthority[] = [],
  provider: DependencyImageProvider = APFS_DEPENDENCY_IMAGE_PROVIDER,
): Promise<DependencyMaterializationReconciliationReceipt> {
  const byLease = new Map<string, DependencyMaterializationWorkspaceAuthority>();
  for (const authority of authorities) {
    const receipt = authority.receipt;
    if (receipt.mode !== 'image' || !receipt.leaseId) continue;
    if (byLease.has(receipt.leaseId)) {
      throw new DependencyMaterializationRefusalError(
        `Dependency lease ${receipt.leaseId} has multiple workspace owners.`,
      );
    }
    byLease.set(receipt.leaseId, authority);
  }

  const outcomes = await provider.reconcile();
  const observed = new Set<string>();
  let adopted = 0;
  let detachedUnowned = 0;
  let unavailable = 0;
  let blocked = 0;
  for (const outcome of outcomes) {
    observed.add(outcome.leaseId);
    const owner = byLease.get(outcome.leaseId);
    const receiptMatches = owner
      && owner.receipt.recipeKey === outcome.recipeKey
      && owner.receipt.generation === outcome.generation
      && sameWorkspaceNamespace(owner.workspacePath, outcome.workspacePath);
    let workspaceMatches = false;
    if (receiptMatches && owner) {
      try {
        const workspaceIdentity = await dependencyMaterializationWorkspaceIdentity(
          owner.workspacePath,
          {
            canonicalPath: path.resolve(owner.workspacePath),
            device: owner.receipt.workspaceDevice,
            inode: owner.receipt.workspaceInode,
          },
        );
        workspaceMatches = workspaceIdentity.canonicalPath === path.resolve(owner.workspacePath);
      } catch {
        // The lease remains the detach authority even when its public workspace name drifted.
      }
    }
    if (outcome.state === 'mounted' && receiptMatches && workspaceMatches && owner) {
      const mountedReceipt = { ...owner.receipt, status: 'mounted' as const };
      await owner.promoteMounted(mountedReceipt);
      activeImageMaterializations.set(path.resolve(owner.workspacePath), {
        receipt: mountedReceipt,
        provider,
      });
      adopted += 1;
      continue;
    }
    if (owner) {
      unavailable += 1;
      const retainPrepared = outcome.state === 'blocked'
        && Boolean(receiptMatches) && workspaceMatches;
      await owner.markUnavailable(retainPrepared
        ? { ...owner.receipt, status: 'prepared' }
        : null);
      activeImageMaterializations.delete(path.resolve(owner.workspacePath));
      if (retainPrepared) {
        blocked += 1;
        continue;
      }
    }
    if (outcome.state === 'detached') {
      continue;
    }
    try {
      await provider.detach(outcome.leaseId, { registryRoot: undefined });
      detachedUnowned += 1;
    } catch {
      blocked += 1;
    }
  }

  for (const [leaseId, owner] of byLease) {
    if (observed.has(leaseId)) continue;
    unavailable += 1;
    await owner.markUnavailable(null);
    activeImageMaterializations.delete(path.resolve(owner.workspacePath));
  }
  return {
    inspected: outcomes.length,
    adopted,
    detachedUnowned,
    unavailable,
    blocked,
    complete: blocked === 0,
  };
}
