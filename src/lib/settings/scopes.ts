/**
 * Scoped settings layers inside settings.toml.
 *
 * The top-level declared keys are the global layer. Project and machine layers
 * live under `[scope.project."<project id>"]` and `[scope.machine."<instance id>"]`
 * with the same table paths as the global layer. A flat file without a `[scope]`
 * table reads as the global layer alone; the first scoped write adds
 * `scope.version` and keeps every flat value in place as the global layer.
 *
 * Resolution is per key: machine over project over global over default. The
 * server environment still wins over every layer (see resolveDefaults).
 */
import { parse, stringify } from 'smol-toml';

import type { OperatorDefaults } from '@/lib/operator/defaults';
import {
  OPERATOR_DEFAULTS_TOML_KEYS,
  OPERATOR_DEFAULTS_TOML_MAPPING,
  parseOperatorDefaultsToml,
  serializeOperatorDefaultsToml,
} from './toml';

export const SETTINGS_SCOPE_VERSION = 1;

export type SettingsLayerScope = 'project' | 'machine';
export type SettingsScope = 'global' | SettingsLayerScope;
export type ResolvedSettingsScope = SettingsScope | 'default';
type Key = keyof OperatorDefaults;
type Values = Partial<OperatorDefaults>;

/**
 * Keys a project or machine layer may hold. Knowledge sources need an operator
 * credential, the next-window preference has side effects outside this file,
 * and endpoint URLs can carry credentials; those stay global only.
 */
const GLOBAL_ONLY: ReadonlySet<Key> = new Set<Key>([
  'knowledgeSources',
  'experimentalNext',
  'localInferenceBaseUrl',
  'telemetryIngestUrl',
]);
export const SCOPED_SETTING_KEYS: readonly Key[] = Object.freeze(
  OPERATOR_DEFAULTS_TOML_KEYS.filter((key) => !GLOBAL_ONLY.has(key)),
);
const SCOPED = new Set<string>(SCOPED_SETTING_KEYS);

export function isScopedSettingKey(key: string): key is Key {
  return SCOPED.has(key);
}

export interface SettingsLayers {
  global: Values;
  project: Record<string, Values>;
  machine: Record<string, Values>;
}

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function scopedOnly(values: Values): Values {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) if (SCOPED.has(key)) copy[key] = value;
  return copy as Values;
}

/** Ids that would address an object's prototype instead of an own key. */
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
export function isSettingsLayerId(id: string): boolean {
  return id.length > 0 && id.length <= 200 && !RESERVED_IDS.has(id);
}

function parseLayer(layer: unknown): Values {
  return isTable(layer) ? scopedOnly(parseOperatorDefaultsToml(stringify(layer))) : {};
}

/**
 * One invalid layer never invalidates the file: the global layer and every
 * other layer keep applying, and the bad layer is skipped until repaired.
 */
function readLayer(table: unknown): Record<string, Values> {
  const layers: Record<string, Values> = {};
  if (!isTable(table)) return layers;
  for (const [id, layer] of Object.entries(table)) {
    if (!isSettingsLayerId(id)) continue;
    try {
      const values = parseLayer(layer);
      if (Object.keys(values).length > 0) layers[id] = values;
    } catch {
      // Parser errors can quote stored values; name only the layer kind.
      console.error('[operator-defaults] Skipping an invalid settings scope layer in settings.toml.');
    }
  }
  return layers;
}

/** Reads every layer. A flat file (no `[scope]` table) is the global layer alone. */
export function readSettingsLayers(raw: string | undefined): SettingsLayers {
  if (raw === undefined) return { global: {}, project: {}, machine: {} };
  const global = parseOperatorDefaultsToml(raw);
  const scope = (parse(raw) as Table).scope;
  if (!isTable(scope)) return { global, project: {}, machine: {} };
  return { global, project: readLayer(scope.project), machine: readLayer(scope.machine) };
}

/** Only this server's machine layer, for the hot read path; invalid reads as unset. */
export function machineLayerValues(raw: string, machineId: string): Values {
  const scope = (parse(raw) as Table).scope;
  const machines = isTable(scope) && isTable(scope.machine) ? scope.machine : {};
  if (!isSettingsLayerId(machineId) || !Object.hasOwn(machines, machineId)) return {};
  return readLayer({ [machineId]: machines[machineId] })[machineId] ?? {};
}

export interface ScopeIds {
  projectId?: string | null;
  machineId: string;
}

export function resolveSettingScope(layers: SettingsLayers, key: Key, ids: ScopeIds): ResolvedSettingsScope {
  const machine = Object.hasOwn(layers.machine, ids.machineId) ? layers.machine[ids.machineId] : {};
  const project = ids.projectId && Object.hasOwn(layers.project, ids.projectId) ? layers.project[ids.projectId] : {};
  if (Object.hasOwn(machine, key)) return 'machine';
  if (Object.hasOwn(project, key)) return 'project';
  if (Object.hasOwn(layers.global, key)) return 'global';
  return 'default';
}

/** Per-key resolution over `defaults`: machine over project over global over default. */
export function resolveSettingsLayers(
  layers: SettingsLayers,
  defaults: OperatorDefaults,
  ids: ScopeIds,
): { values: OperatorDefaults; scopes: Partial<Record<Key, ResolvedSettingsScope>> } {
  const values = { ...defaults } as Record<string, unknown>;
  const scopes: Partial<Record<Key, ResolvedSettingsScope>> = {};
  for (const key of OPERATOR_DEFAULTS_TOML_KEYS) {
    const scope = resolveSettingScope(layers, key, ids);
    scopes[key] = scope;
    if (scope === 'machine') values[key] = layers.machine[ids.machineId][key];
    else if (scope === 'project') values[key] = layers.project[ids.projectId as string][key];
    else if (scope === 'global') values[key] = layers.global[key];
  }
  return { values: values as unknown as OperatorDefaults, scopes };
}

function deletePath(table: Table, path: readonly string[]): void {
  const [head, ...rest] = path;
  if (rest.length === 0) {
    delete table[head];
    return;
  }
  const child = table[head];
  if (!isTable(child)) return;
  deletePath(child, rest);
  if (Object.keys(child).length === 0) delete table[head];
}

export class SettingsScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsScopeError';
  }
}

/**
 * Sets (or with `null`, clears) one key in a project or machine layer and
 * returns the new file text. Every other key and table is kept as stored.
 */
export function writeScopedSetting(
  raw: string | undefined,
  scope: SettingsLayerScope,
  id: string,
  key: string,
  value: unknown,
): string {
  if (!isScopedSettingKey(key)) throw new SettingsScopeError(`${key} can only be set globally.`);
  if (!isSettingsLayerId(id)) throw new SettingsScopeError(`A valid ${scope} id is required.`);
  const document = raw === undefined ? {} : (parse(raw) as Table);
  // The global layer must be valid, so a scoped write never hides a bad file.
  if (raw !== undefined) parseOperatorDefaultsToml(raw);
  const scopeTable: Table = isTable(document.scope) ? document.scope : {};
  scopeTable.version = SETTINGS_SCOPE_VERSION;
  const layers: Table = isTable(scopeTable[scope]) ? scopeTable[scope] as Table : {};
  let layer: Table = Object.hasOwn(layers, id) && isTable(layers[id]) ? layers[id] as Table : {};
  try {
    parseLayer(layer);
  } catch {
    throw new SettingsScopeError(`This ${scope} layer in settings.toml is invalid. Repair it, then save.`);
  }
  if (value === null) {
    deletePath(layer, OPERATOR_DEFAULTS_TOML_MAPPING[key].path);
  } else {
    // The shared serializer validates the value exactly as a global write does.
    layer = parse(serializeOperatorDefaultsToml({ [key]: value } as Values, stringify(layer))) as Table;
  }
  if (Object.keys(layer).length > 0) layers[id] = layer;
  else delete layers[id];
  if (Object.keys(layers).length > 0) scopeTable[scope] = layers;
  else delete scopeTable[scope];
  document.scope = scopeTable;
  return stringify(document);
}
