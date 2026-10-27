import { codexModelDiscoveryHome } from './model-discovery-cache';
import { resolveEffortPin, type ResolveEffortPinInput } from '@/lib/orchestrator/effort-pin';
import { getRuntimeLaunchIdentitySync, type RuntimeLaunchIdentity } from '@/lib/runtime/identity-catalog';

/** Carry this server-resolved identity from early admission into the owned store. */
export function resolveCodexLaunchIdentity(packetId?: string): RuntimeLaunchIdentity {
  return getRuntimeLaunchIdentitySync('codex', packetId) ?? {
    id: 'codex-local-default', label: 'Current local sign-in', configHomeRef: codexModelDiscoveryHome(),
  };
}

/** Resolve once so admission and the child environment cannot select different accounts. */
export function resolveCodexLaunchContext(
  input: Omit<ResolveEffortPinInput, 'runtime'> & { runtime?: 'codex' | 'cloud' },
) {
  const codexHome = input.codexHome ?? codexModelDiscoveryHome();
  return {
    effortPin: resolveEffortPin({ ...input, runtime: input.runtime ?? 'codex', codexHome }),
    env: { CODEX_HOME: codexHome },
  };
}
