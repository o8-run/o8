import { createDeclarativeAgentRuntime } from './shared/declarative-agent-runtime';
import { registerOwnedSessionLifecycle } from './shared/owned-session-lifecycle';
import { museOwnedAdapter, museOwnedStore } from '@/lib/muse/owned';

export const museRuntime = createDeclarativeAgentRuntime({ runtimeId: 'muse', displayName: 'Muse Code',
  surfaceIdPrefix: 'muse-owned:', supportsResume: true, costTelemetry: false }, museOwnedStore);

// Pin the durable mode and execution policy before the owned store starts a process.
museRuntime.launch = async opts => {
  if (opts.controlledProvider) return { ok: false, note: 'Muse Code uses its own account. Select an API runtime for a controlled provider task.' };
  const result = await museOwnedStore.launch({ cwd: opts.cwd, prompt: opts.prompt, promptMemoryRevision: opts.promptMemoryRevision, taskName: opts.taskName,
    runtimeIdentity: opts.runtimeIdentity,
    clientMutationId: opts.clientMutationId, laneId: opts.laneId, packetId: opts.packetId,
    model: opts.model, effort: opts.effort, executionPolicy: opts.executionPolicy, controlledTask: opts.controlledTask,
    runtimeConfig: opts.workMode ? { workMode: opts.workMode } : undefined });
  return { ok: result.ok, note: result.note, sessionKey: result.surfaceId, sideEffect: result.sideEffect };
};

registerOwnedSessionLifecycle({ ...museOwnedAdapter, commandLabel: 'Muse Code', store: museOwnedStore });
