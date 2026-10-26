/** Read-only admission for identifiable legacy o8 files. Migration belongs to #4340. */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { decryptValueSync } from '@/lib/db/master-key';
import { providerCredentialMaterials } from './key-store';
import { matchesProviderCredential } from './credential-materials';
import { canonicalProfilePath, profileContains, selectedRuntimeProfiles } from './runtime-profile-paths';
import type { ChildMetadataRedaction } from './spawn-environment';
import { assertNoRecordedApiProfileChild } from './runtime-profile-processes';

const warned = new Set<string>();
const issue = '#4340 (https://github.com/hurttlocker/o8/issues/4340)';
function warn(file: string): void {
  if (warned.has(file)) return;
  warned.add(file);
  // Profile paths can themselves be saved secrets, including on calls without a launch redactor.
  console.warn(`[payer-policy] Legacy o8 runtime config left unchanged. See ${issue}.`);
}

function records(): string[] {
  const file = join(getDataDir(), 'owned-credential-artifacts.json');
  if (!existsSync(file)) return [];
  let records: unknown;
  try { records = JSON.parse(readFileSync(file, 'utf8')); } catch { warn(file); return []; }
  if (!Array.isArray(records) || records.length > 100_000) { warn(file); return []; }
  return records.flatMap(record => {
    if (record?.owner !== 'o8' || record.runtime === 'codex' || typeof record.runtime !== 'string'
      || typeof record.path !== 'string' || !isAbsolute(record.path) || typeof record.replacement !== 'string'
      // payer policy part b: MCP consumers retain their existing config contract.
      || profileContains(join(getDataDir(), 'mcp'), record.path)) return [];
    const encrypted = /^enc:([a-f0-9]{24}):([a-f0-9]+)$/i.exec(record.replacement);
    if (!encrypted) return [];
    try {
      const payload = JSON.parse(decryptValueSync(encrypted[2], encrypted[1]) ?? 'null');
      if (payload?.owner !== 'o8' || payload.runtime !== record.runtime || payload.path !== record.path
        || typeof payload.contents !== 'string') return [];
      // Historical writers stored canonical paths. A retargeted link no longer
      // establishes ownership of the current target, even with an authentic receipt.
      if (existsSync(record.path) && (!lstatSync(record.path).isFile() || canonicalProfilePath(record.path) !== record.path)) {
        warn(record.path); return [];
      }
      return [record.path];
    } catch { return []; }
  });
}

export function warnLegacyRuntimeConfigs(): void {
  for (const file of records()) if (existsSync(file)) warn(file);
}

/** Read only authenticated o8 destinations; operator-owned files are not inspected. */
export function assertRuntimeProfilesAvailable(profiles: readonly string[], checkApiSurvivors = true, metadata?: ChildMetadataRedaction): void {
  if (checkApiSurvivors) assertNoRecordedApiProfileChild(profiles, metadata);
  const materials = providerCredentialMaterials();
  for (const file of records()) {
    if (!profiles.some(profile => profileContains(profile, file)) || !existsSync(file)) continue;
    const label = JSON.stringify(metadata ? metadata.redact(file) : file);
    let raw: string;
    try { raw = readFileSync(file, 'utf8'); }
    catch { throw new Error(`Cannot inspect legacy o8 file ${label}. Stop its runtime and check file access before retrying. See ${issue}.`); }
    if (!matchesProviderCredential(raw, materials)) continue;
    warn(file);
    throw new Error(`Legacy o8 file ${label} contains a saved provider credential. Stop the old runtime, then manually remove the saved provider credential from that file or move the file aside and configure subscription login before retrying. See ${issue}.`);
  }
}

export function assertLegacyRuntimeConfigSelection(runtimeId: string | undefined, env: Record<string, string | undefined>, args: readonly string[], cwd?: string, metadata?: ChildMetadataRedaction): string[] {
  const profiles = selectedRuntimeProfiles(runtimeId, env, args, cwd);
  assertRuntimeProfilesAvailable(profiles, !runtimeId || ['acp', 'hermes', 'openclaw'].includes(runtimeId), metadata);
  return profiles;
}
