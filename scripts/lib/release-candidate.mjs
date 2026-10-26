import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

/** Reuse a complete, identical candidate; never edit or clobber an existing tag. */
export function prepareCandidateRetry(candidate, assets, repos, manifestNames) {
  const existing = new Set();
  let published;
  for (const repo of repos) {
    const tag = `v${candidate.version}`;
    let inventory;
    try {
      inventory = JSON.parse(execFileSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'assets'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
      }));
    } catch (error) {
      if (/release not found|HTTP 404/i.test(`${error.message}\n${error.stderr ?? ''}`)) continue;
      throw new Error('Could not verify candidate release inventory.');
    }
    const names = assets.map(path => basename(path));
    if (!Array.isArray(inventory.assets)
      || !isDeepStrictEqual(inventory.assets.map(asset => asset.name).sort(), names.slice().sort())) {
      throw new Error('Existing candidate has different assets; use a new version.');
    }
    const dir = mkdtempSync(join(tmpdir(), 'o8-candidate-retry-'));
    try {
      execFileSync('gh', ['release', 'download', tag, '--repo', repo, '--dir', dir], {
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
      });
      let manifest;
      for (const path of assets) {
        const name = basename(path);
        const bytes = readFileSync(join(dir, name));
        if (!manifestNames.includes(name)) {
          if (!bytes.equals(readFileSync(path))) throw new Error('Existing candidate artifact or signature differs; use a new version.');
          continue;
        }
        const value = JSON.parse(bytes);
        // A retry generates a new clock value. Retain the original publication
        // date and require every other manifest field, including signatures.
        if (!isDeepStrictEqual({ ...value, pub_date: candidate.pub_date }, candidate)
          || (manifest && !isDeepStrictEqual(value, manifest))) {
          throw new Error('Existing candidate manifest differs; use a new version.');
        }
        manifest = value;
      }
      if (!manifest || (published && !isDeepStrictEqual(manifest, published))) {
        throw new Error('Existing candidate manifests differ between repositories.');
      }
      published = manifest;
      existing.add(repo);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return { manifest: published ?? candidate, existing };
}
