#!/usr/bin/env node
// Build-time inputs only; no application download or updater behavior.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.length !== 3) throw new Error('Usage: fetch-build-inputs.mjs CACHE_DIRECTORY');
const cache = resolve(process.argv[2]);
mkdirSync(cache, { recursive: true });
const inputs = JSON.parse(readFileSync(fileURLToPath(new URL('./build-inputs.json', import.meta.url)), 'utf8'));
const paths = {};
for (const [name, input] of Object.entries(inputs)) {
  const file = join(cache, input.file);
  if (!existsSync(file)) {
    const response = await fetch(input.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${input.url}; version ${input.version}; SHA256 ${input.sha256}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw new Error(`Checksum mismatch: ${input.url}; expected ${input.sha256}`);
    const scratch = mkdtempSync(join(cache, '.download-'));
    try {
      writeFileSync(join(scratch, input.file), bytes);
      renameSync(join(scratch, input.file), file);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  if (createHash('sha256').update(readFileSync(file)).digest('hex') !== input.sha256) throw new Error(`Cached checksum mismatch: ${input.file}; expected ${input.sha256}`);
  if (name !== 'node') chmodSync(file, 0o755);
  paths[name] = file;
}
const extracted = mkdtempSync(join(cache, 'node-runtime-'));
execFileSync('tar', ['-xJf', paths.node, '-C', extracted]);
paths.nodeRoot = join(extracted, `node-v${inputs.node.version}-linux-x64`);
console.log(JSON.stringify(paths));
