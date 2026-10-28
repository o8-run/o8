import { boundedMuseRequest, createMuseHost } from './host';
import { museRecord } from './protocol';
import { captureMuseRuntimeConfig, museRoot } from './roots';
import { getSelectedRuntimeIdentity } from '@/lib/runtime/identity-catalog';

export interface MuseModel {
  id: string;
  label: string;
  provider: string;
  isDefault: boolean;
  efforts: string[] | null;
}

export interface MuseModelCatalog {
  models: MuseModel[];
  observedAt: string;
  source: 'probe' | 'cache';
  authStatus: 'unknown';
}

const validEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export function decodeMuseModels(value: unknown): MuseModel[] {
  const data = museRecord(value);
  if (data.providerId !== 'meta' || !Array.isArray(data.models)) throw new Error('Muse returned an incompatible model catalog.');
  const seen = new Set<string>();
  return data.models.flatMap(value => {
    const row = museRecord(value);
    if (row.providerId !== 'meta' || typeof row.modelId !== 'string' || !row.modelId.trim() || seen.has(row.modelId)) return [];
    seen.add(row.modelId);
    return [{ id: row.modelId, label: typeof row.displayLabel === 'string' ? row.displayLabel : row.modelId,
      provider: 'meta', isDefault: row.isDefault === true,
      efforts: Array.isArray(row.variants) ? row.variants.filter((value): value is string => typeof value === 'string' && validEfforts.has(value)) : null }];
  });
}

/** Discovery executes no turn and never promotes catalog presence into login evidence. */
export async function probeMuseModels(cwd: string, _force = false, config = captureMuseRuntimeConfig()): Promise<MuseModelCatalog> {
  // The protocol snapshot has no account revision or subscription. A cached
  // result cannot establish support after sign-in, config or model changes.
  const host = await createMuseHost({ cwd, readOnly: true,
    configRoot: museRoot(config.museConfigRoot, true), dataRoot: museRoot(config.museDataRoot, true) });
  try {
    return { models: decodeMuseModels(await boundedMuseRequest(host.connection.request('model/list', {}), host)),
      observedAt: new Date().toISOString(), source: 'probe', authStatus: 'unknown' };
  } finally { await host.close(); }
}

export async function museWorkerModelContext(persisted?: Record<string, string>) {
  if (persisted?.museConfigRoot && persisted.museDataRoot) return persisted;
  const config = captureMuseRuntimeConfig();
  const selected = await getSelectedRuntimeIdentity('muse');
  return { ...config, museConfigRoot: selected ? museRoot(selected.configHomeRef) : config.museConfigRoot };
}
