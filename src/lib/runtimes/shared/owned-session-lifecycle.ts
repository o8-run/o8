import type {
  OwnedArchiveResponse,
  OwnedSessionStore,
  OwnedWorkspaceBindingReceipt,
  RebindOwnedWorkspaceInput,
  RebindOwnedWorkspaceResult,
} from './owned-session/types';
import type { OwnedSessionState } from './owned-session/types';

export interface OwnedSessionLifecycleRegistration {
  runtimeId: string;
  surfaceIdPrefix: string;
  commandLabel: string;
  /** Shared batch stores retain independent stdio and enforce packet start identity. */
  detachedPacketIdentity?: boolean;
  resolveRoot(): string;
  sessionState(surfaceId: string): Promise<OwnedSessionState>;
  archiveSession(surfaceId: string, workspace?: string): Promise<OwnedArchiveResponse>;
  resumeSession?(surfaceId: string, prompt: string): ReturnType<OwnedSessionStore['resume']>;
  retireSession?(surfaceId: string): Promise<{ retired: boolean; note: string }>;
  setDetachedSession?(surfaceId: string, reason: string | null): Promise<{
    updated: boolean;
    previouslyDetached: boolean;
    note: string;
  }>;
  getWorkspaceBinding?(surfaceId: string): Promise<OwnedWorkspaceBindingReceipt | null>;
  recoverArchivedWorkspace?(surfaceId: string, expected: OwnedWorkspaceBindingReceipt, publish: () => void): Promise<OwnedWorkspaceBindingReceipt>;
  rebindWorkspace?(surfaceId: string, input: RebindOwnedWorkspaceInput): Promise<RebindOwnedWorkspaceResult>;
}

const registrations = new Map<string, OwnedSessionLifecycleRegistration>();

export function registerOwnedSessionLifecycleHandler(
  registration: OwnedSessionLifecycleRegistration,
): OwnedSessionLifecycleRegistration {
  registrations.set(registration.surfaceIdPrefix, registration);
  return registration;
}

export function registerOwnedSessionLifecycle(options: {
  runtimeId: string;
  surfaceIdPrefix: string;
  commandLabel: string;
  rootEnvVar: string;
  rootDefault: string;
  store: OwnedSessionStore;
}): OwnedSessionLifecycleRegistration {
  const registration: OwnedSessionLifecycleRegistration = {
    runtimeId: options.runtimeId,
    surfaceIdPrefix: options.surfaceIdPrefix,
    commandLabel: options.commandLabel,
    detachedPacketIdentity: true,
    resolveRoot: () => process.env[options.rootEnvVar] || options.rootDefault,
    sessionState: (surfaceId) => options.store.sessionState(surfaceId),
    archiveSession: (surfaceId, workspace) => options.store.archiveSession(surfaceId, workspace),
    resumeSession: (surfaceId, prompt) => options.store.resume(surfaceId, prompt),
    ...(options.store.retireSession ? { retireSession: (surfaceId: string) => options.store.retireSession!(surfaceId) } : {}),
    ...(options.store.setDetachedSession ? {
      setDetachedSession: (surfaceId: string, reason: string | null) => (
        options.store.setDetachedSession!(surfaceId, reason)
      ),
    } : {}),
    ...(options.store.recoverArchivedWorkspace ? {
      recoverArchivedWorkspace: (surfaceId: string, expected: OwnedWorkspaceBindingReceipt, publish: () => void) => (
        options.store.recoverArchivedWorkspace!(surfaceId, expected, publish)
      ),
    } : {}),
    ...(options.store.getWorkspaceBinding && options.store.rebindWorkspace ? {
      getWorkspaceBinding: (surfaceId: string) => options.store.getWorkspaceBinding!(surfaceId),
      rebindWorkspace: (surfaceId: string, input: RebindOwnedWorkspaceInput) => (
        options.store.rebindWorkspace!(surfaceId, input)
      ),
    } : {}),
  };
  return registerOwnedSessionLifecycleHandler(registration);
}

export function getOwnedSessionLifecycle(
  surfaceId: string,
): OwnedSessionLifecycleRegistration | undefined {
  return [...registrations.values()]
    .find((registration) => surfaceId.startsWith(registration.surfaceIdPrefix));
}

export function listOwnedSessionLifecycles(): OwnedSessionLifecycleRegistration[] {
  return [...registrations.values()];
}
