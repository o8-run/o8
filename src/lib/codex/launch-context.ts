import { codexModelDiscoveryHome } from './model-discovery-cache';
import { resolveEffortPin, type ResolveEffortPinInput } from '@/lib/orchestrator/effort-pin';

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
