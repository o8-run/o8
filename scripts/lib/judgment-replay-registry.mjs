import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

/** Discover source-owned label modules; additions never edit a central label list. */
export async function discoverReplayLabels(directory) {
  const files = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.mjs'))
    .map(entry => entry.name).sort();
  const entries = await Promise.all(files.map(async file => {
    const { default: entry } = await import(pathToFileURL(join(fileURLToPath(directory), file)).href);
    if (!entry || !/^[A-Za-z][A-Za-z0-9-]*$/.test(entry.name)
      || entry.name === 'all-recorded' || !['approval', 'recorded'].includes(entry.kind)
      || !Number.isFinite(entry.order ?? 1000)) throw new Error(`Invalid replay label module: ${file}`);
    if (entry.kind === 'recorded' && ['load', 'label', 'render'].some(method => typeof entry[method] !== 'function')) {
      throw new Error(`Incomplete replay label module: ${file}`);
    }
    return { ...entry, order: entry.order ?? 1000 };
  }));
  const names = new Set();
  for (const entry of entries) {
    if (names.has(entry.name)) throw new Error(`Duplicate replay label: ${entry.name}`);
    names.add(entry.name);
  }
  return entries.sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
}
