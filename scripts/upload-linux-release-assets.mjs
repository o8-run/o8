#!/usr/bin/env node
/** Attach a verified pair with ownership-labelled rollback of partial uploads. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function main() {
  const tag = process.env.RELEASE_TAG;
  const repo = process.env.GH_REPO;
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('Invalid release identity');
  const name = `o8-${tag.slice(1)}-x86_64.AppImage`;
  const names = [name, `${name}.sig`];
  if (readdirSync('publish').sort().join('\n') !== [...names].sort().join('\n')) throw new Error('Expected exactly the verified AppImage and signature');
  for (const file of names) if (!statSync(join('publish', file)).size) throw new Error('Empty release asset');
  const gh = args => execFileSync('gh', args, { encoding: 'utf8' });
  const assets = () => JSON.parse(gh(['api', `repos/${repo}/releases/tags/${tag}`])).assets;
  const before = assets();
  if (before.some(asset => names.includes(asset.name))) throw new Error('Release asset already exists; refusing replacement');
  const beforeIds = new Set(before.map(asset => asset.id));
  const label = `o8-linux-upload-${randomUUID()}`;
  try {
    gh(['release', 'upload', tag, '--repo', repo, ...names.map(file => `${join('publish', file)}#${label}`)]);
    const after = assets();
    if (!names.every(file => after.some(asset => asset.name === file && asset.label === label
      && asset.size === statSync(join('publish', file)).size))) throw new Error('Release upload pair was incomplete');
  } catch (error) {
    // IDs and a unique label fence cleanup from preexisting or concurrent assets.
    for (const asset of assets()) {
      if (names.includes(asset.name) && asset.label === label && !beforeIds.has(asset.id)) {
        gh(['api', '--method', 'DELETE', `repos/${repo}/releases/assets/${asset.id}`]);
      }
    }
    throw error;
  }
}
try { main(); } catch (error) { console.error(`Linux attachment failed: ${error.message}`); process.exitCode = 1; }
