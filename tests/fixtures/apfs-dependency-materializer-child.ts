import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type { DependencySeedLeaseRecord } from '@/lib/workspace/dependency-seed-registry';

interface FixtureInput {
  action: 'create' | 'park' | 'park-refusal' | 'restore'
    | 'cleanup' | 'cleanup-refusal' | 'prune' | 'poison' | 'restart-root-swap'
    | 'startup-create' | 'attach-crash-before-receipt' | 'startup-attach-reconcile';
  repoPath: string;
  dataDir: string;
  taskName?: string;
  branchName?: string;
  packetId?: string;
  surfaceId?: string;
  repoId?: string;
  laneId?: string;
  worktreeId?: string;
  workspacePath?: string;
  leaseId?: string;
  imagePath?: string;
  recipeKey?: string;
  markerPath?: string;
  cycleTag?: string | number;
}

const parsedInput = JSON.parse(
  process.env.O8_APFS_MATERIALIZER_INPUT ?? 'null',
) as FixtureInput | null;
if (!parsedInput) throw new Error('O8_APFS_MATERIALIZER_INPUT is required.');
const input: FixtureInput = parsedInput;

async function configuredRepo() {
  const registry = await import('@/lib/repos/registry');
  const existing = await registry.findRepoByLocalPath(input.repoPath);
  const repo = existing ?? await registry.addRepo(input.repoPath);
  return registry.updateRepo(repo.id, {
    setup: {
      ...repo.setup,
      envMode: 'skip',
      envFiles: [],
      installCommand: 'npm ci --prefer-offline --ignore-scripts --no-audit --no-fund',
      installOnCreateWorkspace: true,
      workspaceIsolationPreference: 'git-worktree',
    },
  });
}

async function materializationEvidence(worktreeId: string) {
  const [{ WorktreeManager }, registry, deviceAuthority] = await Promise.all([
    import('@/lib/worktree/manager'),
    import('@/lib/workspace/dependency-seed-registry'),
    import('@/lib/workspace/dependency-image-device-authority'),
  ]);
  const worktree = await new WorktreeManager(input.repoPath).get(worktreeId);
  const receipt = worktree?.dependencyMaterialization ?? null;
  const lease = receipt?.leaseId ? registry.readDependencySeedLease(receipt.leaseId) : null;
  const devices = receipt?.mode === 'image'
    ? await deviceAuthority.mountedDependencyImages()
    : [];
  const liveDevice = lease?.deviceEntry
    ? devices.find((entry) => entry.deviceEntry === lease.deviceEntry) ?? null
    : null;
  return { worktree, receipt, lease, liveDevice };
}

async function dependencyRollbackEvidence(
  worktreeId: string,
  oldLease: DependencySeedLeaseRecord | null,
) {
  const [evidence, registry, deviceAuthority] = await Promise.all([
    materializationEvidence(worktreeId),
    import('@/lib/workspace/dependency-seed-registry'),
    import('@/lib/workspace/dependency-image-device-authority'),
  ]);
  const workspacePath = evidence.worktree?.path;
  if (!workspacePath) throw new Error('Dependency rollback lost its workspace metadata.');
  const mountPath = path.join(workspacePath, 'node_modules');
  const canonicalWorkspace = realpathSync(workspacePath);
  const liveDevices = await deviceAuthority.mountedDependencyImages();
  return {
    ...evidence,
    pathExists: existsSync(workspacePath),
    // Evidence collection must never throw away the rollback receipt it is describing.
    nodeModulesUsable: (() => {
      try {
        return readFileSync(
          path.join(mountPath, 'fixture-package', 'index.js'),
          'utf8',
        ).includes('sealed fixture');
      } catch {
        return false;
      }
    })(),
    oldLease: oldLease ? registry.readDependencySeedLease(oldLease.leaseId) : null,
    oldShadowExists: oldLease ? existsSync(oldLease.shadowPath) : null,
    workspaceLeases: registry.listDependencySeedLeases().filter((lease) => (
      realpathSync(lease.workspacePath) === canonicalWorkspace
    )),
    workspaceDevices: liveDevices.filter((device) => (
      device.mountPath !== null && realpathSync(path.dirname(device.mountPath)) === canonicalWorkspace
    )),
    oldShadowLiveDevices: liveDevices.filter((device) => (
      device.shadowPath === oldLease?.shadowPath
    )),
  };
}

async function waitForReadyImage(recipeKey: string) {
  const { readDependencySeedImage } = await import('@/lib/workspace/dependency-seed-registry');
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const image = readDependencySeedImage(recipeKey);
    if (image?.state === 'ready') return image;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Background dependency-image publication did not become ready.');
}

async function create() {
  if (!input.taskName) throw new Error('Create requires a task name.');
  const repo = await configuredRepo();
  const { NextRequest } = await import('next/server');
  const { POST } = await import('@/app/api/worktrees/route');
  const response = await POST(new NextRequest('http://127.0.0.1/api/worktrees', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1' },
    body: JSON.stringify({
      repo: repo.localPath,
      agentType: 'codex',
      taskName: input.taskName,
      branchName: input.branchName,
      baseBranch: 'main',
      isolationPreference: 'git-worktree',
    }),
  }));
  const body = await response.json() as {
    worktree?: { id: string; path: string; branch: string };
    error?: unknown;
  };
  if (!body.worktree) return { status: response.status, body };
  const evidence = await materializationEvidence(body.worktree.id);
  const image = evidence.receipt?.mode === 'native'
    ? await waitForReadyImage(evidence.receipt.recipeKey)
    : null;
  if (input.packetId && input.surfaceId) {
    const [{ createLane, setLaneStatus }, { withWorktreeMetaTransaction }] = await Promise.all([
      import('@/lib/lane/registry'),
      import('@/lib/worktree/metadata-store'),
    ]);
    await withWorktreeMetaTransaction(input.repoPath, async (transaction) => {
      const entry = (await transaction.readAll())[body.worktree!.id];
      if (!entry) throw new Error('Created worktree metadata was not persisted.');
      await transaction.save(body.worktree!.id, { ...entry, sessionKey: input.surfaceId });
    });
    const lane = createLane({
      repoPath: repo.localPath,
      branch: body.worktree.branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: input.packetId,
      sessionKey: input.surfaceId,
      worktreePath: body.worktree.path,
      ownership: 'managed',
    });
    setLaneStatus(lane.id, 'reviewing');
    return { status: response.status, repoId: repo.id, laneId: lane.id, image, ...evidence };
  }
  return { status: response.status, repoId: repo.id, image, ...evidence };
}

async function registerLifecycle() {
  if (!input.packetId || !input.surfaceId || !input.repoId || !input.workspacePath) {
    throw new Error('Lifecycle input is incomplete.');
  }
  const { registerOwnedSessionLifecycleHandler } = await import(
    '@/lib/runtimes/shared/owned-session-lifecycle'
  );
  let version = 1;
  registerOwnedSessionLifecycleHandler({
    runtimeId: 'codex',
    surfaceIdPrefix: 'apfs-materializer-owned:',
    commandLabel: 'apfs-dependency-materializer',
    resolveRoot: () => input.dataDir,
    sessionState: async () => 'active',
    archiveSession: async () => ({ archived: false, note: 'unused' }),
    getWorkspaceBinding: async () => ({
      surfaceId: input.surfaceId!,
      runtimeId: 'codex',
      sessionState: 'active',
      binding: {
        logicalWorkspaceId: `packet:${input.packetId}`,
        repositoryUuid: input.repoId!,
        packetId: input.packetId!,
        cwd: input.workspacePath!,
        version,
        verifiedAt: new Date().toISOString(),
      },
      activeRun: null,
      retainedRuns: [],
      retainedRunsComplete: true,
      retainedRunTotal: 0,
    }),
    rebindWorkspace: async (_surfaceId, next) => {
      if (next.expectedVersion !== version || next.expectedCwd !== input.workspacePath) {
        return { status: 'conflict', receipt: null, note: 'binding mismatch' };
      }
      version += 1;
      return {
        status: 'rebound',
        receipt: {
          surfaceId: input.surfaceId!,
          runtimeId: 'codex',
          sessionState: 'active',
          binding: {
            logicalWorkspaceId: `packet:${input.packetId}`,
            repositoryUuid: input.repoId!,
            packetId: input.packetId!,
            cwd: next.nextCwd,
            version,
            verifiedAt: new Date().toISOString(),
          },
          activeRun: null,
          retainedRuns: [],
          retainedRunsComplete: true,
          retainedRunTotal: 0,
        },
      };
    },
  });
}

async function lifecycle(action: 'park' | 'restore') {
  await registerLifecycle();
  const [{ NextRequest }, { getOrCreateWsToken }, route, registry, deviceAuthority] = await Promise.all([
    import('next/server'),
    import('@/lib/ws-auth'),
    import('@/app/api/orchestrator/workspace/route'),
    import('@/lib/workspace/dependency-seed-registry'),
    import('@/lib/workspace/dependency-image-device-authority'),
  ]);
  const priorLease = input.leaseId ? registry.readDependencySeedLease(input.leaseId) : null;
  const response = await route.POST(new NextRequest(
    'http://127.0.0.1/api/orchestrator/workspace',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${getOrCreateWsToken().trim()}`,
        'content-type': 'application/json',
        host: '127.0.0.1',
        'x-o8-client-addr': '127.0.0.1',
      },
      body: JSON.stringify({
        action,
        packetId: input.packetId,
        clientMutationId: input.cycleTag !== undefined
          ? `apfs-materializer-${action}-${input.cycleTag}`
          : `apfs-materializer-${action}`,
      }),
    },
  ));
  const body = await response.json() as Record<string, unknown>;
  const evidence = action === 'restore' && input.worktreeId
    ? await materializationEvidence(input.worktreeId)
    : null;
  const priorDeviceEntries = new Set([
    priorLease?.deviceEntry,
    ...(priorLease?.systemEntities ?? []).map((entity) => entity.deviceEntry),
  ].filter((entry): entry is string => typeof entry === 'string'));
  const relatedLiveDevices = priorLease
    ? (await deviceAuthority.mountedDependencyImages()).filter((device) => (
        device.shadowPath === priorLease.shadowPath
        || device.mountPath === priorLease.mountPath
        || priorDeviceEntries.has(device.deviceEntry)
        || device.systemEntities.some((entity) => priorDeviceEntries.has(entity.deviceEntry))
      ))
    : [];
  return {
    status: response.status,
    body,
    pathExists: existsSync(input.workspacePath!),
    priorLease: input.leaseId ? registry.readDependencySeedLease(input.leaseId) : null,
    relatedLiveDevices,
    evidence,
  };
}

async function parkRefusal() {
  if (!input.repoId || !input.packetId || !input.worktreeId || !input.workspacePath) {
    throw new Error('Park-refusal input is incomplete.');
  }
  await registerLifecycle();
  const [hibernator, exact, registry] = await Promise.all([
    import('@/lib/workspace/hibernator'),
    import('@/lib/workspace/worktree-exact'),
    import('@/lib/workspace/dependency-seed-registry'),
  ]);
  const oldLease = input.leaseId ? registry.readDependencySeedLease(input.leaseId) : null;
  if (!oldLease) throw new Error('Park-refusal requires a durable mounted lease.');
  const result = await hibernator.parkWorkspace({
    repositoryUuid: input.repoId,
    packetId: input.packetId,
    operationId: 'apfs-materializer-park-refusal',
  }, {
    parkExact: (parkInput) => exact.parkExactWorktree({
      ...parkInput,
      beforeQuarantineReceiptWrite: async () => {
        throw new Error('deterministic production park refusal after dependency detach');
      },
    }),
  });
  const evidence = await dependencyRollbackEvidence(input.worktreeId, oldLease);
  const snapshot = result.snapshot;
  const quarantine = snapshot ? await exact.inspectExactWorktreeQuarantine({
    repoPath: input.repoPath,
    worktreeId: input.worktreeId,
    expectedPath: input.workspacePath,
    quarantine: {
      snapshotFingerprint: snapshot.snapshotFingerprint,
      intent: 'park',
    },
  }) : null;
  return { result, quarantine, ...evidence };
}

async function cleanupRefusal() {
  if (!input.worktreeId || !input.workspacePath) {
    throw new Error('Cleanup-refusal input is incomplete.');
  }
  const [managerModule, identityModule, claimRegistry, dependencyRegistry] = await Promise.all([
    import('@/lib/worktree/manager'),
    import('@/lib/worktree/materialization-identity'),
    import('@/lib/workspace/exact-workspace-claim-state'),
    import('@/lib/workspace/dependency-seed-registry'),
  ]);
  const manager = new managerModule.WorktreeManager(input.repoPath);
  const workspaceIdentity = await identityModule.captureWorktreeMaterializationIdentity(
    input.workspacePath,
  );
  const oldLease = input.leaseId
    ? dependencyRegistry.readDependencySeedLease(input.leaseId)
    : null;
  if (!oldLease) throw new Error('Cleanup-refusal requires a durable mounted lease.');
  const parentIdentity = await identityModule.captureWorktreeMaterializationIdentity(
    path.dirname(input.workspacePath),
  );
  const operationId = `cleanup-refusal-${input.worktreeId}`;
  claimRegistry.prepareExactWorkspaceClaim({
    kind: 'managed-retirement',
    repositoryPath: input.repoPath,
    worktreeId: input.worktreeId,
    operationId,
    expectedPath: input.workspacePath,
    sourcePath: input.workspacePath,
    claimPath: path.join(parentIdentity.canonicalPath, `.o8-test-conflict-${input.worktreeId}`),
    parentIdentity,
    sourceIdentity: {
      device: workspaceIdentity.device,
      inode: workspaceIdentity.inode,
    },
    contentDigest: 'deterministic-cleanup-refusal',
    authority: { sourceCanonicalPath: `${workspaceIdentity.canonicalPath}-conflict` },
  });
  let removed = false;
  try {
    removed = await manager.cleanup(input.worktreeId, { force: true });
  } finally {
    claimRegistry.removeExactWorkspaceClaim(
      'managed-retirement', input.repoPath, input.worktreeId, operationId,
    );
  }
  const evidence = await dependencyRollbackEvidence(input.worktreeId, oldLease);
  const claim = claimRegistry.readExactWorkspaceClaim('managed-retirement', input.repoPath, input.worktreeId);
  return {
    removed,
    exactClaims: claim ? [claim] : [],
    ...evidence,
  };
}

async function cleanup() {
  if (!input.worktreeId) throw new Error('Cleanup requires a worktree id.');
  const [{ NextRequest }, route, registry] = await Promise.all([
    import('next/server'),
    import('@/app/api/worktrees/route'),
    import('@/lib/workspace/dependency-seed-registry'),
  ]);
  const response = await route.DELETE(new NextRequest('http://127.0.0.1/api/worktrees', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', host: '127.0.0.1' },
    body: JSON.stringify({
      repo: input.repoPath,
      action: 'cleanup',
      worktreeId: input.worktreeId,
      force: true,
      deleteBranch: true,
    }),
  }));
  return {
    status: response.status,
    body: await response.json(),
    pathExists: input.workspacePath ? existsSync(input.workspacePath) : null,
    lease: input.leaseId ? registry.readDependencySeedLease(input.leaseId) : null,
  };
}

async function prune() {
  if (!input.worktreeId || !input.workspacePath) throw new Error('Prune requires a worktree.');
  const [{ NextRequest }, route, registry, metadata] = await Promise.all([
    import('next/server'),
    import('@/app/api/worktrees/route'),
    import('@/lib/workspace/dependency-seed-registry'),
    import('@/lib/worktree/metadata-store'),
  ]);
  await metadata.withWorktreeMetaTransaction(input.repoPath, async (transaction) => {
    const entry = (await transaction.readAll())[input.worktreeId!];
    if (!entry) throw new Error('Prune target metadata disappeared.');
    await transaction.save(input.worktreeId!, {
      ...entry,
      createdAt: Date.now() - 10 * 60_000,
    });
  });
  const response = await route.DELETE(new NextRequest('http://127.0.0.1/api/worktrees', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', host: '127.0.0.1' },
    body: JSON.stringify({ repo: input.repoPath, action: 'prune', maxAgeMs: -1 }),
  }));
  return {
    status: response.status,
    body: await response.json(),
    pathExists: existsSync(input.workspacePath),
    lease: input.leaseId ? registry.readDependencySeedLease(input.leaseId) : null,
  };
}

async function poison() {
  if (!input.imagePath || !input.taskName) throw new Error('Poison requires an image and task.');
  chmodSync(input.imagePath, 0o600);
  writeFileSync(input.imagePath, 'poisoned', { flag: 'a' });
  return create();
}

async function restartRootSwap() {
  if (!input.worktreeId || !input.workspacePath || !input.leaseId) {
    throw new Error('Restart root swap requires a mounted worktree lease.');
  }
  const [managerModule, materializer, registry, deviceAuthority, reconciler] = await Promise.all([
    import('@/lib/worktree/manager'),
    import('@/lib/workspace/dependency-materializer'),
    import('@/lib/workspace/dependency-seed-registry'),
    import('@/lib/workspace/dependency-image-device-authority'),
    import('@/lib/workspace/reconciler'),
  ]);
  const manager = new managerModule.WorktreeManager(input.repoPath);
  const before = await materializationEvidence(input.worktreeId);
  const oldLease = registry.readDependencySeedLease(input.leaseId);
  if (!before.receipt || before.receipt.mode !== 'image' || !oldLease) {
    throw new Error('Restart root swap lost its mounted dependency authority.');
  }
  const originalPath = `${input.workspacePath}.restart-root-swap-original`;
  renameSync(input.workspacePath, originalPath);
  mkdirSync(input.workspacePath);
  mkdirSync(path.join(input.workspacePath, 'node_modules'));
  writeFileSync(path.join(input.workspacePath, 'wrong-occupant'), 'preserve replacement root\n');
  writeFileSync(
    path.join(input.workspacePath, 'node_modules', 'wrong-occupant'),
    'preserve replacement dependencies\n',
  );
  const replacementBefore = lstatSync(input.workspacePath);
  const events: string[] = [];
  const authorities = (await manager.listDependencyMaterializationAuthorities()).map((authority) => ({
    workspacePath: authority.workspacePath,
    receipt: authority.receipt,
    promoteMounted: async (receipt: typeof authority.receipt) => {
      events.push('promoted');
      await manager.recordDependencyMaterialization(authority.worktreeId, receipt);
    },
    markUnavailable: async (receipt: typeof authority.receipt | null) => {
      events.push('metadata-cleared');
      await manager.markDependencyMaterializationUnavailable(authority.worktreeId, receipt);
    },
  }));
  const reconciliation = await materializer.reconcileDependencyMaterializations(authorities);
  const workspaceReconciliation = reconciliation.complete
    ? await reconciler.reconcileInterruptedWorkspaces()
    : null;
  const replacementAfter = lstatSync(input.workspacePath);
  const oldDeviceEntries = new Set([
    oldLease.deviceEntry,
    ...(oldLease.systemEntities ?? []).map((entity) => entity.deviceEntry),
  ].filter((entry): entry is string => typeof entry === 'string'));
  const relatedLiveDevices = (await deviceAuthority.mountedDependencyImages()).filter((device) => (
    device.shadowPath === oldLease.shadowPath
    || oldDeviceEntries.has(device.deviceEntry)
    || device.systemEntities.some((entity) => oldDeviceEntries.has(entity.deviceEntry))
  ));
  const after = await materializationEvidence(input.worktreeId);
  return {
    reconciliation,
    workspaceReconciliationRan: workspaceReconciliation !== null,
    workspaceReconciliation,
    events,
    receipt: after.receipt,
    replacementBefore: {
      device: replacementBefore.dev,
      inode: replacementBefore.ino,
    },
    replacementAfter: {
      device: replacementAfter.dev,
      inode: replacementAfter.ino,
    },
    replacementContents: readFileSync(path.join(input.workspacePath, 'wrong-occupant'), 'utf8'),
    replacementDependencyContents: readFileSync(
      path.join(input.workspacePath, 'node_modules', 'wrong-occupant'),
      'utf8',
    ),
    originalPath,
    originalExists: existsSync(originalPath),
    oldLease: registry.readDependencySeedLease(input.leaseId),
    oldShadowExists: existsSync(oldLease.shadowPath),
    relatedLiveDevices,
  };
}

async function startupCreate() {
  await configuredRepo();
  const { reconcileDependencyImagesAtStartup } = await import(
    '@/lib/workspace/dependency-image-startup'
  );
  const startup = await reconcileDependencyImagesAtStartup();
  return { startup, create: await create() };
}

async function attachCrashBeforeReceipt() {
  if (!input.workspacePath || !input.recipeKey || !input.markerPath) {
    throw new Error('Attach crash input is incomplete.');
  }
  await configuredRepo();
  execFileSync('git', [
    'worktree', 'add', '-q', '-b', `attach-crash-${Date.now()}`,
    input.workspacePath, 'main',
  ], { cwd: input.repoPath });
  const [dependencyInstall, dependencyImage, registry] = await Promise.all([
    import('@/lib/workspace/dependency-install'),
    import('@/lib/workspace/apfs-dependency-image'),
    import('@/lib/workspace/dependency-seed-registry'),
  ]);
  const installCommand = 'npm ci --prefer-offline --ignore-scripts --no-audit --no-fund';
  const recipe = await dependencyInstall.deriveDependencyInstallRecipe(
    input.workspacePath,
    installCommand,
  );
  if (recipe.key !== input.recipeKey) {
    throw new Error('Attach crash workspace recipe differs from the ready image.');
  }
  await dependencyImage.mountDependencyImage(
    input.workspacePath,
    installCommand,
    recipe,
    {
      afterAttachCommand: async (leaseId) => {
        const lease = registry.readDependencySeedLease(leaseId);
        if (!lease) throw new Error('Attach crash lost its prepared lease.');
        writeFileSync(input.markerPath!, JSON.stringify({
          leaseId,
          shadowPath: lease.shadowPath,
          mountPath: lease.mountPath,
        }));
        process.kill(process.pid, 'SIGSTOP');
      },
    },
  );
  throw new Error('Attach crash boundary unexpectedly resumed.');
}

async function startupAttachReconcile() {
  if (!input.leaseId || !input.workspacePath || !input.markerPath) {
    throw new Error('Startup attach reconciliation input is incomplete.');
  }
  await configuredRepo();
  const marker = JSON.parse(readFileSync(input.markerPath, 'utf8')) as {
    shadowPath: string;
    mountPath: string;
  };
  const [startupModule, registry, cleanupJournal, deviceAuthority] = await Promise.all([
    import('@/lib/workspace/dependency-image-startup'),
    import('@/lib/workspace/dependency-seed-registry'),
    import('@/lib/workspace/dependency-image-lease-cleanup'),
    import('@/lib/workspace/dependency-image-device-authority'),
  ]);
  const startup = await startupModule.reconcileDependencyImagesAtStartup();
  const [devices, mounts] = await Promise.all([
    deviceAuthority.mountedDependencyImages(),
    deviceAuthority.listMountedFilesystems(),
  ]);
  return {
    startup,
    lease: registry.readDependencySeedLease(input.leaseId),
    action: cleanupJournal.readDependencySeedLeaseCleanupAction(input.leaseId),
    targets: cleanupJournal.listDependencySeedLeaseCleanupTargets(input.leaseId),
    relatedDevices: devices.filter((device) => (
      device.shadowPath === marker.shadowPath
      || device.systemEntities.some((entity) => entity.mountPath === marker.mountPath)
    )),
    relatedMounts: mounts.filter((mount) => mount.mountPath === marker.mountPath),
    shadowExists: existsSync(marker.shadowPath),
  };
}

async function main() {
  const result = input.action === 'create'
    ? await create()
    : input.action === 'park' || input.action === 'restore'
      ? await lifecycle(input.action)
      : input.action === 'park-refusal'
        ? await parkRefusal()
        : input.action === 'cleanup-refusal'
          ? await cleanupRefusal()
      : input.action === 'cleanup'
        ? await cleanup()
        : input.action === 'prune'
          ? await prune()
          : input.action === 'restart-root-swap'
            ? await restartRootSwap()
            : input.action === 'startup-create'
              ? await startupCreate()
              : input.action === 'attach-crash-before-receipt'
                ? await attachCrashBeforeReceipt()
                : input.action === 'startup-attach-reconcile'
                  ? await startupAttachReconcile()
            : await poison();
  process.stdout.write(`O8_APFS_MATERIALIZER_RESULT ${JSON.stringify(result)}\n`);
}

void main().finally(async () => {
  const { closeDb } = await import('@/lib/db');
  closeDb();
}).catch((error) => {
  console.error('[apfs-dependency-materializer] Child failed.', error);
  process.exitCode = 1;
});
