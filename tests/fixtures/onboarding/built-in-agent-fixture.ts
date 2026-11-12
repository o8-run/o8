import type { OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import { createBuiltInAgentRuntime } from '@/lib/setup/built-in-agent';
import type { Plan } from '@/lib/entitlement/types';

/** Fixture identity only. Never a candidate for the production registration. */
export const PREVIEW_BUILT_IN_AGENT_ID = '__preview_builtin_agent__' as OrchestratorRuntime;

export function previewBuiltInAgent(_plan: Plan = 'free', platform = 'darwin') {
  return createBuiltInAgentRuntime({ id: PREVIEW_BUILT_IN_AGENT_ID, backend: 'o8' }, platform);
}
