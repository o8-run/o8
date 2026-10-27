import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSelectedRuntimeIdentitySync } from '@/lib/runtime/identity-catalog';

/** Explicit homes belong to pinned sessions or leads; otherwise use the selected worker. */
export function codexModelDiscoveryHome(): string {
  return getSelectedRuntimeIdentitySync('codex')?.configHomeRef
    ?? (process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'));
}

interface DiscoveredCodexModel {
  slug: string;
  supported_reasoning_levels?: Array<{ effort?: unknown } | null>;
}

/** Missing or unusable evidence never borrows a different account's catalogue. */
export function readCodexModelDiscovery(codexHome = codexModelDiscoveryHome()): DiscoveredCodexModel[] | null {
  try {
    const cache = JSON.parse(readFileSync(join(codexHome, 'models_cache.json'), 'utf8'));
    if (!Array.isArray(cache?.models)) return null;
    return cache.models.filter((model: DiscoveredCodexModel | null) => typeof model?.slug === 'string');
  } catch {
    return null;
  }
}
