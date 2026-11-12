#!/usr/bin/env node
// Cache only a verified executable. Resolution failures retain the original
// Cargo installation path; advisory checks never depend on registry metadata.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

const hash = value => createHash('sha256').update(value).digest('hex');
let values;
try {
  const toolchain = process.argv[2];
  const image = [process.env.ImageOS, process.env.ImageVersion];
  if (!toolchain?.trim() || image.some(value => !value?.trim())) throw new Error('Build identity unavailable');
  const response = await fetch(process.env.AUDIT_TOOL_REGISTRY_URL ?? 'https://crates.io/api/v1/crates/cargo-audit', {
    headers: { 'User-Agent': 'o8-ci-audit-tool-cache' }, signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('Registry unavailable');
  const metadata = await response.json();
  const version = metadata?.crate?.max_stable_version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('No stable version');
  const release = Array.isArray(metadata?.versions)
    ? metadata.versions.find(entry => entry?.num === version && entry?.yanked === false) : undefined;
  const source = release?.checksum;
  if (typeof source !== 'string' || !/^[a-f0-9]{64}$/.test(source)) throw new Error('No source checksum');
  values = { cacheable: 'true', version, source, toolchain: hash(toolchain), image: hash(JSON.stringify(image)),
    recipe: hash(readFileSync(new URL('./install-audit-tool.sh', import.meta.url))) };
} catch {
  console.log('[audit-tool-cache] Identity unavailable; using uncached Cargo installation');
  values = { cacheable: 'false' };
}
appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
