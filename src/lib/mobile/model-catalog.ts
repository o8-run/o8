import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { ORCHESTRATOR_MODEL_OPTIONS } from '@/lib/operator/default-options';
import { CODEX_MODEL_IDS, MODEL_IDS } from '@/lib/models';
import { formatModelLabel } from '@/lib/format';
import { supportedEffortsForLead } from '@/components/desktop/thoughts/composer-selector/state';
import { readCodexModelDiscovery } from '@/lib/codex/model-discovery-cache';

/** Fixed TS model options; dynamic ACP houses have no phone model contract. */
/**
 * Codex models this computer's account can run. The CLI records them after it
 * signs in; a plan without the newest model would otherwise be offered it and
 * fail the turn. No record, or one that names none of ours, keeps the full list.
 */
export function codexModelsForAccount(discovered: Array<{ slug: string }> | null = readCodexModelDiscovery()): readonly string[] {
  const available = new Set(discovered?.map(model => model.slug));
  const offered = CODEX_MODEL_IDS.filter(id => available.has(id));
  return offered.length ? offered : CODEX_MODEL_IDS;
}

export function mobileModelCatalog(codexModels: readonly string[] = codexModelsForAccount()) {
  const defaults = getOperatorDefaultsSync().values;
  return {
    version: 1 as const,
    agents: (['claude', 'codex'] as const).map(id => {
      const options = id === 'claude' ? ORCHESTRATOR_MODEL_OPTIONS
        : codexModels.map(value => ({ value, label: formatModelLabel(value) }));
      return {
        id, label: id === 'claude' ? 'Claude' : 'Codex',
        defaultModel: options.some(option => option.value === defaults.orchestratorModel) ? defaults.orchestratorModel
          : id === 'codex' ? (options.some(option => option.value === MODEL_IDS.codexDefault) ? MODEL_IDS.codexDefault : options[0]!.value)
            : MODEL_IDS.orchestratorDefault,
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
