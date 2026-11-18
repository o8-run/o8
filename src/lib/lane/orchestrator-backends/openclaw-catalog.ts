import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Shared path and reader; importing the catalogue never loads a live backend.
export const OPENCLAW_SOURCE_CONFIG = join(homedir(), '.openclaw', 'openclaw.json');

export function listOpenclawAgents(): Array<{ id: string; name: string }> {
  try {
    const source = JSON.parse(readFileSync(OPENCLAW_SOURCE_CONFIG, 'utf8')) as {
      agents?: { list?: Array<{ id?: unknown; name?: unknown }> };
    };
    const rawList = source.agents?.list;
    const list = Array.isArray(rawList) ? rawList : [];
    return list
      .map((a) => {
        const id = typeof a.id === 'string' ? a.id : '';
        const name = typeof a.name === 'string' && a.name.trim() ? a.name : id;
        return { id, name };
      })
      .filter((a) => a.id);
  } catch {
    return [];
  }
}

