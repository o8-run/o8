import { spawn } from '@/lib/providers/child-process';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { assertWorktreeMaterializationIdentity, captureWorktreeMaterializationIdentity, type WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { probeMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import { assertWorkspaceRetentionReleased } from './retention-holds';
import { reserveBuildOutput, publishBuildOutput } from './generated-output-build-ownership';
import { createBuildOutputWriter, type BuildOutputWriter } from '../../../scripts/lib/build-output-writer.cjs';
import { retainedFailedPrebuild } from './failed-prebuild-parking';
import { assertLinkedGitBuildCustody, captureLinkedGitBuildCustody } from './linked-git-build-custody';
import { assertGeneratedOutputClaimsReleased, generatedOutputOwner, generatedOutputRevision,
  currentGeneratedOutputResource, registerGeneratedOutputLocked, saveGeneratedOutputResource, withGeneratedOutputExclusion,
  lastDisposedPrebuildOutput, type GeneratedOutputResource } from './generated-output-state';

export type GeneratedOutputSpawn = ((command: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<number>) & {
  buildOutput?: { directory: string; writer: BuildOutputWriter; complete: () => Promise<void> };
};

// Pause before the real producer executes, including commands too short to
// probe after ordinary spawn. The parent's durable acknowledgement owns it.
const PRODUCER_START = String.raw`
const fs = require('node:fs'); const path = require('node:path');
const input = JSON.parse(process.argv[1]);
function parent() {
  const stat = fs.lstatSync('.');
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== input.workspace.device
    || stat.ino !== input.workspace.inode || fs.realpathSync('.') !== input.workspace.canonicalPath) {
    throw new Error('Generated-output producer workspace changed.');
  }
  const output = fs.lstatSync('.next');
  if (!output.isDirectory() || output.isSymbolicLink() || output.dev !== input.output.device
    || output.ino !== input.output.inode || fs.realpathSync('.next') !== input.output.canonicalPath) {
    throw new Error('Generated-output producer child namespace changed.');
  }
}
parent();
const waiting = setTimeout(() => process.exit(78), 30000);
process.once('disconnect', () => process.exit(78));
process.once('message', message => {
  try {
    if (message?.continue !== true) throw new Error('Producer ownership was not acknowledged.');
    parent(); clearTimeout(waiting);
    let command = input.command;
    if (!command.includes(path.sep)) {
      command = (process.env.PATH || '').split(path.delimiter).map(root => path.join(root, command))
        .find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
    }
    if (!command) throw new Error('Generated-output producer command is unavailable.');
    process.env.PWD = input.workspace.canonicalPath;
    process.removeAllListeners('disconnect'); process.disconnect();
    process.execve(command, [command, ...input.args], process.env);
  } catch (error) { process.stderr.write(error.message + '\n'); process.exit(78); }
});
process.send({ phase: 'ready' });
`;

function spawnReservedChild(workspace: WorktreeMaterializationIdentity, output: WorktreeMaterializationIdentity,
  command: string, args: string[], env: NodeJS.ProcessEnv, writer?: BuildOutputWriter) {
  return spawn(process.execPath, ['-e', PRODUCER_START, JSON.stringify({ workspace, output, command, args })], {
    cwd: workspace.canonicalPath, env: writer ? writer.environment(env) : env,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
}

/** Ordinary checkouts retain their build behavior until they have a managed owner. */
async function runUnmanagedProducer(input: {
  workspacePath: string;
  operation: (run: GeneratedOutputSpawn) => Promise<number>;
}): Promise<number> {
  const children = new Map<ReturnType<typeof spawn>, Promise<number>>();
  const forward = (signal: NodeJS.Signals) => { for (const child of children.keys()) child.kill(signal); };
  const interrupt = () => forward('SIGINT'); const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const run: GeneratedOutputSpawn = (command, args, env = process.env) => {
    if (children.size) return Promise.reject(new Error('Generated-output child spawns must be serial.'));
    const child = spawn(command, args, { cwd: input.workspacePath, env, stdio: 'inherit' });
    let failure: Error | undefined;
    const closed = new Promise<number>((resolve, reject) => {
      child.once('error', error => { failure = error; });
      child.once('close', code => {
        children.delete(child);
        if (failure) reject(failure); else resolve(code ?? 1);
      });
    });
    children.set(child, closed);
    return closed;
  };
  try {
    const code = await input.operation(run);
    if (children.size) throw new Error('Generated-output operation has an unsettled child.');
    return code;
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    forward('SIGTERM');
    await Promise.all([...children.values()].map(closed => closed.catch(() => {})));
  }
}

/** The reservation precedes cache invalidation and every child spawn. Parent death remains held. */
export async function runGeneratedOutputProducer(input: {
  workspacePath: string;
  mode: 'build' | 'dev' | 'start';
  operation: (run: GeneratedOutputSpawn) => Promise<number>;
}): Promise<number> {
  const workspace = await captureWorktreeMaterializationIdentity(input.workspacePath);
  const containingOwner = await generatedOutputOwner(workspace);
  if (!containingOwner) {
    const marker = await lstat(path.join(workspace.canonicalPath, '.o8-generated-output-store')).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!marker) {
      if (currentGeneratedOutputResource(workspace.canonicalPath)?.creationAuthority) {
        throw new Error('Prebuild lifecycle store binding is missing; preserve output for recovery.');
      }
      return runUnmanagedProducer(input);
    }
    if (!currentGeneratedOutputResource(workspace.canonicalPath)?.creationAuthority) {
      throw new Error('Bound ordinary output requires its original prebuild lifecycle profile.');
    }
  }
  if (typeof Reflect.get(process, 'execve') !== 'function') {
    throw new Error(`Managed generated-output producers require Node.js 22.15+ with process.execve on macOS or Linux; ${process.version} on ${process.platform} cannot preserve native producer identity.`);
  }
  return withGeneratedOutputExclusion(workspace, containingOwner, async () => {
    const freshOwner = await generatedOutputOwner(workspace);
    if (JSON.stringify(freshOwner) !== JSON.stringify(containingOwner)) throw new Error('Generated-output owner changed before reservation.');
    const resource = await registerGeneratedOutputLocked(workspace, containingOwner);
    return runReservedProducer(workspace, resource, input);
  });
}

async function runReservedProducer(workspace: WorktreeMaterializationIdentity, resource: GeneratedOutputResource,
  input: { mode: 'build' | 'dev' | 'start'; operation: (run: GeneratedOutputSpawn) => Promise<number> }): Promise<number> {
  if (!resource.owner && resource.creationAuthority) await assertLinkedGitBuildCustody(workspace, resource.creationAuthority.linkedGit);
  assertGeneratedOutputClaimsReleased(workspace);
  if (!resource.output || resource.state === 'active' || resource.state === 'planned'
    || resource.state === 'failed-held' || resource.bankCapture?.state === 'failed-held'
    || resource.bank) throw new Error('Generated output has unresolved producer or retention authority.');
  assertWorkspaceRetentionReleased(resource.output.canonicalPath, resource.output);
  const owner = await probeMetadataLockProcessIdentity(process.pid);
  if (owner.state !== 'live') throw new Error('Generated-output producer identity is unknown.');
  const previousState = resource.state;
  const previousBuildOwnership = resource.buildOwnership;
  const reservedBuild = !resource.owner && resource.creationAuthority && input.mode === 'build';
  if (reservedBuild && previousBuildOwnership?.state === 'complete' && previousBuildOwnership.proof !== 'write-receipts-v1') {
    throw new Error('Preserved legacy build output without write-time writer proof.');
  }
  resource = saveGeneratedOutputResource(resource, { state: 'active', revision: await generatedOutputRevision(workspace),
    ...(reservedBuild ? { buildOwnership: undefined } : {}),
    attempt: { id: randomUUID(), mode: input.mode, ownerPid: process.pid, ownerIdentity: owner.identity, children: [] } });
  let activeChild: ReturnType<typeof spawn> | null = null;
  let activeRun: Promise<number> | null = null;
  let abortRequested = false;
  let requestedStop: NodeJS.Signals | null = null;
  let writer: BuildOutputWriter | undefined;
  const forward = (signal: NodeJS.Signals) => { abortRequested = true; requestedStop = signal; activeChild?.kill(signal); };
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const runChild: GeneratedOutputSpawn = async (command, args, env = process.env) => {
    if (abortRequested) throw new Error('Generated-output producer admission is closed.');
    if (activeChild) throw new Error('Generated-output child spawns must be serial.');
    if (resource.attempt!.children.length >= 16) throw new Error('Generated-output child count exceeded its bound.');
    if (!resource.owner && resource.creationAuthority) await assertLinkedGitBuildCustody(workspace, resource.creationAuthority.linkedGit);
    await assertWorktreeMaterializationIdentity(resource.output!.canonicalPath, resource.output!);
    if (abortRequested) throw new Error('Generated-output producer admission is closed.');
    const child = spawnReservedChild(workspace, resource.output!, command, args, env, writer);
    activeChild = child;
    let spawnError: Error | undefined;
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
      child.once('error', error => { spawnError = error; });
      child.once('close', (code, signal) => resolve({ code, signal, error: spawnError }));
    });
    const index = resource.attempt!.children.length;
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('message', message => {
          if ((message as { phase?: string })?.phase === 'ready') resolve();
          else reject(new Error('Generated-output producer returned an invalid ready receipt.'));
        });
        void closed.then(() => reject(new Error('Generated-output producer closed before ownership admission.')));
      });
      if (!child.pid) throw new Error('Generated-output child spawn has uncertain ownership.');
      const probe = await probeMetadataLockProcessIdentity(child.pid);
      if (probe.state !== 'live') throw new Error('Generated-output producer birth is unknown.');
      writer?.admit(child.pid, probe.identity);
      resource = saveGeneratedOutputResource(resource, { attempt: { ...resource.attempt!, children: [...resource.attempt!.children,
        { pid: child.pid, identity: probe.identity, exitCode: null, signal: null, observedClosed: false }] } });
      if (abortRequested) throw new Error('Generated-output producer admission is closed.');
      if (!resource.owner && resource.creationAuthority) await assertLinkedGitBuildCustody(workspace, resource.creationAuthority.linkedGit);
      child.send({ continue: true });
    } catch (error) {
      if (child.connected) child.disconnect();
      await closed;
      activeChild = null;
      throw error;
    }
    const result = await closed;
    if (result.error) throw result.error;
    const children = [...resource.attempt!.children];
    writer?.observedClose(children[index].pid, children[index].identity!);
    children[index] = { ...children[index], exitCode: result.code, signal: result.signal, observedClosed: true };
    resource = saveGeneratedOutputResource(resource, { attempt: { ...resource.attempt!, children } });
    activeChild = null;
    await assertWorktreeMaterializationIdentity(workspace.canonicalPath, workspace);
    if (!resource.owner && resource.creationAuthority) await assertLinkedGitBuildCustody(workspace, resource.creationAuthority.linkedGit);
    await assertWorktreeMaterializationIdentity(resource.output!.canonicalPath, resource.output!);
    return result.code ?? 1;
  };
  const run: GeneratedOutputSpawn = (command, args, env) => {
    if (activeRun) return Promise.reject(new Error('Generated-output child spawns must be serial.'));
    const pending = runChild(command, args, env);
    activeRun = pending;
    void pending.then(() => { if (activeRun === pending) activeRun = null; },
      () => { if (activeRun === pending) activeRun = null; });
    return pending;
  };
  const settleFailedRun = async () => {
    abortRequested = true;
    const unsettled = activeRun;
    activeChild?.kill('SIGTERM');
    if (unsettled) await unsettled.catch(() => {});
  };
  try {
    if (reservedBuild) {
      const ownership = await reserveBuildOutput(resource, previousBuildOwnership);
      resource = saveGeneratedOutputResource(resource, { buildOwnership: ownership });
      writer = createBuildOutputWriter(ownership.scope.canonicalPath, ownership.scope);
      run.buildOutput = { directory: ownership.scope.canonicalPath, writer, complete: async () => {
        if (activeRun || activeChild || resource.buildOwnership?.state !== 'reserved') {
          throw new Error('Build output publication requires closed compiler children and its original reservation.');
        }
        resource = saveGeneratedOutputResource(resource, { buildOwnership: await publishBuildOutput(resource, writer!) });
      } };
    }
    const code = await input.operation(run);
    if (activeRun || activeChild || !resource.attempt!.children.length || resource.attempt!.children.some(child => !child.observedClosed)) {
      throw new Error('Generated-output attempt lacks complete observed child exits.');
    }
    const controlledStop = input.mode !== 'build' && requestedStop !== null
      && resource.attempt!.children.every(child => child.identity && child.observedClosed
        && (child.exitCode === 0 || child.signal === requestedStop));
    const success = code === 0 && resource.attempt!.children.every(child => child.identity && child.exitCode === 0 && !child.signal);
    resource = saveGeneratedOutputResource(resource, { state: success
      ? (input.mode === 'start' ? previousState : resource.origin === 'legacy-observation' ? 'legacy-held' : 'succeeded')
      : controlledStop ? previousState : 'failed-held' });
    return success || controlledStop ? 0 : code || 1;
  } catch (error) {
    await settleFailedRun();
    saveGeneratedOutputResource(resource, { state: 'failed-held' });
    throw error;
  } finally {
    writer?.close();
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  }

}

/** Prebuild alone may own fresh output in an ordinary checkout, never the checkout itself. */
export async function runGeneratedOutputPrebuild(input: {
  workspacePath: string;
  preflight: () => void;
  operation: (context: { canReuse: boolean;
    runBuild: (operation: (run: GeneratedOutputSpawn) => Promise<number>) => Promise<number> }) => Promise<number>;
}): Promise<number> {
  const workspace = await captureWorktreeMaterializationIdentity(input.workspacePath);
  const containingOwner = await generatedOutputOwner(workspace);
  if (typeof Reflect.get(process, 'execve') !== 'function') {
    throw new Error('Generated-output prebuild requires Node.js 22.15+ with process.execve.');
  }
  const linkedGit = !containingOwner ? await captureLinkedGitBuildCustody(workspace) : undefined;
  // Refuse unknown output or lost authority before exclusion could create a marker.
  const current = currentGeneratedOutputResource(workspace.canonicalPath);
  if ((current || lastDisposedPrebuildOutput(workspace.canonicalPath) || retainedFailedPrebuild(workspace.canonicalPath)) && !await lstat(path.join(workspace.canonicalPath, '.o8-generated-output-store')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  })) throw new Error('Prebuild lifecycle store binding is missing; preserve output for recovery.');
  if (!current) {
    const existing = await lstat(path.join(workspace.canonicalPath, '.next')).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (existing) throw new Error('Prebuild cannot acquire unknown existing generated output.');
  }
  return withGeneratedOutputExclusion(workspace, containingOwner, async () => {
    if (JSON.stringify(await generatedOutputOwner(workspace)) !== JSON.stringify(containingOwner)) {
      throw new Error('Generated-output owner changed before prebuild admission.');
    }
    if (!containingOwner) await assertLinkedGitBuildCustody(workspace, linkedGit);
    const previous = current ?? lastDisposedPrebuildOutput(workspace.canonicalPath);
    if (previous?.creationAuthority && !previous.owner) await assertLinkedGitBuildCustody(workspace, previous.creationAuthority.linkedGit);
    assertGeneratedOutputClaimsReleased(workspace);
    input.preflight();
    const disposed = !currentGeneratedOutputResource(workspace.canonicalPath)
      ? lastDisposedPrebuildOutput(workspace.canonicalPath) : null;
    if (disposed) {
      await assertWorktreeMaterializationIdentity(workspace.canonicalPath, disposed.workspace);
      assertWorkspaceRetentionReleased(disposed.output!.canonicalPath, disposed.output!);
    }
    const creator = await probeMetadataLockProcessIdentity(process.pid);
    if (creator.state !== 'live') throw new Error('Prebuild creation process identity is unknown.');
    const register = async () => {
      if (!containingOwner) await assertLinkedGitBuildCustody(workspace, linkedGit);
      const resource = await registerGeneratedOutputLocked(workspace, containingOwner,
        { kind: 'prebuild', pid: process.pid, identity: creator.identity, ...(linkedGit ? { linkedGit } : {}) });
      if (!resource.output || (!resource.owner && !resource.creationAuthority)
        || resource.origin !== 'managed-creation' || !['ready', 'succeeded'].includes(resource.state)
        || resource.bank || resource.bankCapture || resource.adoption || resource.recovery || resource.retirement) {
        throw new Error('Generated output has unresolved prebuild or retention authority.');
      }
      assertWorkspaceRetentionReleased(resource.output.canonicalPath, resource.output);
      return resource;
    };
    const resource = disposed ? null : await register();
    let invoked = false;
    return input.operation({ canReuse: Boolean(disposed) || resource?.state === 'succeeded', runBuild: async operation => {
      if (invoked) throw new Error('Prebuild producer may run only once per exclusion.');
      invoked = true;
      return runReservedProducer(workspace, resource ?? await register(), { mode: 'build', operation });
    } });
  });
}
