/** Native Settings receives declared values and presence, never raw stored TOML. */
import {
  getOperatorDefaults,
  getOperatorDefaultsTomlState,
  OPERATOR_DEFAULTS_FALLBACK,
  updateOperatorDefaults,
  type OperatorDefaults,
  type OperatorDefaultsWithSources,
} from '@/lib/operator/defaults';
import {
  SettingsTomlConflictError,
  withOperatorDefaultsWriteLock,
  type OperatorDefaultsTomlState,
} from './operator-defaults-store';
import { parseOperatorDefaultsToml, projectOperatorDefaultsToml, serializeOperatorDefaultsToml } from './toml';

function safeValues(values: Partial<OperatorDefaults>): Partial<OperatorDefaults> {
  const copy = { ...values };
  for (const key of ['targetingTriage', 'targetingAction'] as const) {
    const tier = copy[key];
    if (tier) copy[key] = { runtime: tier.runtime, model: tier.model, effort: tier.effort };
  }
  return copy;
}

export function nativeSettingsPayload(data: OperatorDefaultsWithSources, state: OperatorDefaultsTomlState) {
  let text = '';
  let additionalSettingsSet = false;
  if (!state.error) ({ text, additionalSettingsSet } = projectOperatorDefaultsToml(state.text));
  return {
    values: safeValues(data.values),
    sources: data.sources,
    settingsToml: {
      text, revision: state.revision, additionalSettingsSet,
      error: state.error ? 'settings.toml is invalid. Repair it outside this editor, then refresh.' : null,
    },
  };
}

export async function readNativeSettings() {
  return withOperatorDefaultsWriteLock(async () => {
    // A direct file editor does not take our lock. Verify the read as well as
    // the later write, so values and their revision describe the same file.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await getOperatorDefaultsTomlState();
      const data = await getOperatorDefaults();
      const after = await getOperatorDefaultsTomlState();
      if (before.revision === after.revision) return nativeSettingsPayload(data, after);
    }
    throw new SettingsTomlConflictError();
  });
}

export async function mergeNativeSettingsToml(text: string, revision: string): Promise<string> {
  if (projectOperatorDefaultsToml(text).additionalSettingsSet) {
    throw new Error('This editor accepts declared settings only. Use the write-only provider controls to replace keys.');
  }
  const state = await getOperatorDefaultsTomlState();
  if (state.revision !== revision) throw new SettingsTomlConflictError();
  // Omitted declared settings reset to their defaults, like a desktop file
  // replacement. Unknown tables (including credentials) remain only on server.
  return serializeOperatorDefaultsToml({ ...OPERATOR_DEFAULTS_FALLBACK, ...safeValues(parseOperatorDefaultsToml(text)) }, state.text);
}

export async function updateNativeSettings(update: Partial<OperatorDefaults>, revision: unknown) {
  if (typeof revision !== 'string' || !revision) throw new Error('Refresh settings before saving.');
  // Use the same normalization, routing refusals and persistence path as the
  // desktop. The revision is checked inside its shared write lock and before
  // rename; a conditional update never retries against a newer file.
  return updateOperatorDefaults(update, revision);
}
