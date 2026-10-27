import { readMemoryRevision } from '@/lib/cortex/memory-revision';
import type { LaunchOptions } from '@/lib/runtimes/types';

export class ForgottenCloudContextError extends Error {
  constructor() { super('Worker memory changed. Start a fresh dispatch.'); }
}

export function assertCloudLaunchMemory(launch: LaunchOptions): void {
  if (launch.packetId && (launch.promptMemoryRevision ?? '0') !== readMemoryRevision()) throw new ForgottenCloudContextError();
}

/** Fields a scoped external worker may receive from the coordinator. */
export function workerLaunchPayload(launch: LaunchOptions) {
  assertCloudLaunchMemory(launch);
  return {
    prompt: launch.prompt,
    model: launch.model,
    effort: launch.effort,
    packetId: launch.packetId,
    workMode: launch.workMode,
    remoteSource: launch.remoteSource,
    remoteManifestHash: launch.remoteManifestHash,
    remotePreview: launch.remotePreview,
    remoteServiceSession: launch.remoteServiceSession,
  };
}
