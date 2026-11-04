/** Native Settings receives declared values and presence, never raw stored TOML. */
import { listRosterBotSettingsCandidates } from '@/lib/bots/roster';
import {
  getOperatorDefaults,
  getOperatorDefaultsTomlState,
  OPERATOR_DEFAULTS_FALLBACK,
  updateOperatorDefaults,
  type OperatorDefaults,
  type OperatorDefaultsWithSources,
} from '@/lib/operator/defaults';
import { assertRoutingTomlCompatibility, routingUpdateTouchesCompatibility } from '@/lib/operator/routing-compatibility';
import { getCachedInstanceIdentity } from '@/lib/panel/instance-identity';
import {
  SettingsTomlConflictError,
  withOperatorDefaultsWriteLock,
  writeScopedOperatorDefault,
  type OperatorDefaultsTomlState,
} from './operator-defaults-store';
import {
  isScopedSettingKey,
  readSettingsLayers,
  resolveSettingScope,
  SCOPED_SETTING_KEYS,
  SettingsScopeError,
  type SettingsLayerScope,
  type SettingsLayers,
} from './scopes';
import { parseOperatorDefaultsToml, projectOperatorDefaultsToml, serializeOperatorDefaultsToml } from './toml';

function safeValues(values: Partial<OperatorDefaults>): Partial<OperatorDefaults> {
  const copy = { ...values };
  for (const key of ['targetingTriage', 'targetingAction'] as const) {
    const tier = copy[key];
    if (tier) copy[key] = { runtime: tier.runtime, model: tier.model, effort: tier.effort };
  }
  return copy;
}

/**
 * The layers this window edits: global, the given project and this machine.
 * `values` are already resolved with the machine layer (see the store); the
 * project layer is applied here, under the machine layer and the environment.
 */
function scopedPayload(data: OperatorDefaultsWithSources, state: OperatorDefaultsTomlState, projectId: string | null) {
  const machineId = getCachedInstanceIdentity().instanceId;
  const layers: SettingsLayers = state.error ? { global: {}, project: {}, machine: {} } : readSettingsLayers(state.text);
  const project = projectId ? layers.project[projectId] ?? {} : {};
  const values: Record<string, unknown> = { ...data.values };
  for (const key of SCOPED_SETTING_KEYS) {
    if (data.sources[key] === 'env') continue;
    if (resolveSettingScope(layers, key, { projectId, machineId }) === 'project') values[key] = project[key];
  }
  return {
    values: safeValues(values as Partial<OperatorDefaults>),
    scope: {
      projectId,
      keys: SCOPED_SETTING_KEYS,
      layers: {
        global: safeValues(layers.global),
        project: safeValues(project),
        machine: safeValues(layers.machine[machineId] ?? {}),
      },
    },
  };
}

export function nativeSettingsPayload(data: OperatorDefaultsWithSources, state: OperatorDefaultsTomlState, projectId: string | null = null) {
  let text = '';
  let additionalSettingsSet = false;
  if (!state.error) ({ text, additionalSettingsSet } = projectOperatorDefaultsToml(state.text));
  const { values, scope } = scopedPayload(data, state, projectId);
  return {
    bots: listRosterBotSettingsCandidates(),
    values,
    scope,
    sources: data.sources,
    settingsToml: {
      text, revision: state.revision, additionalSettingsSet,
      error: state.error ? 'settings.toml is invalid. Repair it outside this editor, then refresh.' : null,
    },
  };
}

export async function readNativeSettings(projectId: string | null = null) {
  return withOperatorDefaultsWriteLock(async () => {
    // A direct file editor does not take our lock. Verify the read as well as
    // the later write, so values and their revision describe the same file.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await getOperatorDefaultsTomlState();
      const data = await getOperatorDefaults();
      const after = await getOperatorDefaultsTomlState();
      if (before.revision === after.revision) return nativeSettingsPayload(data, after, projectId);
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

/**
 * Sets or clears (`null`) one key in the project or machine layer. The machine
 * layer is always this server's; the client never names another machine.
 */
export async function updateNativeScopedSetting(
  scope: SettingsLayerScope,
  projectId: string | null,
  key: string,
  value: unknown,
  revision: unknown,
): Promise<void> {
  if (typeof revision !== 'string' || !revision) throw new Error('Refresh settings before saving.');
  if (!isScopedSettingKey(key)) throw new SettingsScopeError(`${key} can only be set globally.`);
  const machineId = getCachedInstanceIdentity().instanceId;
  const id = scope === 'machine' ? machineId : projectId;
  if (!id) throw new SettingsScopeError('Choose a project before saving a project setting.');
  // Routing keys must stay compatible as the layer's readers resolve them,
  // with the same refusals a global write gets.
  const validate = routingUpdateTouchesCompatibility({ [key]: true } as Partial<OperatorDefaults>)
    ? (next: string) => {
      const layers = readSettingsLayers(next);
      const project = scope === 'project' && Object.hasOwn(layers.project, id) ? layers.project[id] : {};
      const machine = Object.hasOwn(layers.machine, machineId) ? layers.machine[machineId] : {};
      assertRoutingTomlCompatibility(
        serializeOperatorDefaultsToml({ ...layers.global, ...project, ...machine }),
        OPERATOR_DEFAULTS_FALLBACK,
      );
    }
    : undefined;
  await withOperatorDefaultsWriteLock(() => writeScopedOperatorDefault(scope, id, key, value, revision, validate));
}
