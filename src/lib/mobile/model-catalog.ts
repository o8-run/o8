import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { ORCHESTRATOR_MODEL_OPTIONS } from '@/lib/operator/default-options';
import { CODEX_MODEL_IDS, MODEL_IDS } from '@/lib/models';
import { formatModelLabel } from '@/lib/format';
import { supportedEffortsForLead } from '@/components/desktop/thoughts/composer-selector/state';

/** Fixed TS model options; dynamic ACP houses have no phone model contract. */
export function mobileModelCatalog() {
  const defaults = getOperatorDefaultsSync().values;
  return {
    version: 1 as const,
    agents: (['claude', 'codex'] as const).map(id => {
      const options = id === 'claude' ? ORCHESTRATOR_MODEL_OPTIONS
        : CODEX_MODEL_IDS.map(value => ({ value, label: formatModelLabel(value) }));
      return {
        id, label: id === 'claude' ? 'Claude' : 'Codex',
        defaultModel: options.some(option => option.value === defaults.orchestratorModel) ? defaults.orchestratorModel
          : id === 'codex' ? MODEL_IDS.codexDefault : MODEL_IDS.orchestratorDefault,
        models: options.map(option => {
          const efforts = [...supportedEffortsForLead(id, option.value, false, true)];
          return { id: option.value, label: option.label, efforts,
            defaultEffort: efforts.includes(defaults.thinkingEffort) ? defaults.thinkingEffort : efforts.includes('high') ? 'high' : null };
        }),
      };
    }),
  };
}

export function mobileModelError(backend: string | null | undefined, model: unknown): string | null {
  if (model === undefined || model === null) return null;
  const agent = mobileModelCatalog().agents.find(agent => agent.id === backend);
  if (!agent || typeof model !== 'string' || !agent.models.some(option => option.id === model)) {
    return `Unknown model for ${backend ?? 'auto'}: choose a model from the desktop catalog.`;
  }
  return null;
}
