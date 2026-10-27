#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_REPOS } from './lib/linux-appimage-signature.mjs';
import { requireSmokeReceipts } from './lib/smoke-receipt.mjs';
import { acquirePublicationLock, compareVersions } from './lib/release-publication.mjs';

function options(args) {
  let version;
  const repos = [];
  const receipts = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Expected --version <version> and optional --repo <repository>.');
    if (args[i - 1] === '--smoke-receipt') receipts.push(value);
    else if (args[i - 1] === '--version') version = value;
    else if (args[i - 1] === '--repo' && /^[\w.-]+\/[\w.-]+$/.test(value)) repos.push(value);
    else throw new Error('Unknown promote option.');
  }
  compareVersions(version, version);
  return { version, receipts, repos: repos.length ? [...new Set(repos)] : DEFAULT_REPOS };
}

function feedAnchor(repo) {
  const tag = execFileSync('gh', ['release', 'view', '--repo', repo, '--json', 'tagName', '--jq', '.tagName'], {
    encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('The stable feed anchor is unavailable.');
  return tag;
}

function download(repo, tag, name, dir) {
  execFileSync('gh', ['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', dir, '--clobber'], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  });
  return JSON.parse(readFileSync(join(dir, name), 'utf8'));
}

function validateCandidate(candidate, version) {
  if (candidate.channel !== 'beta') throw new Error('The candidate is not a beta manifest.');
  if (candidate.version !== version) throw new Error('The beta manifest does not match the requested version.');
  const platforms = Object.values(candidate.platforms ?? {});
  if (!platforms.length) throw new Error('The beta manifest has no signed artifacts.');
  for (const platform of platforms) {
    const url = new URL(platform.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || !url.pathname.includes(`/releases/download/v${version}/`)
      || typeof platform.signature !== 'string' || !platform.signature.trim()) {
      throw new Error('The beta manifest contains an invalid signed artifact.');
    }
  }
}

function validateStable(candidate, stable) {
  if (compareVersions(candidate.version, stable.version) < 0) throw new Error('Promotion cannot downgrade stable.');
  if (stable.version === candidate.version && JSON.stringify(stable) !== JSON.stringify(candidate)) throw new Error('Stable version already has different artifacts.');
  for (const platform of Object.keys(stable.platforms ?? {})) {
    if (!Object.hasOwn(candidate.platforms, platform)) throw new Error('The beta candidate is missing a stable platform.');
  }
}

async function main() {
  const { version, repos, receipts } = options(process.argv.slice(2));
  // One lock across all versions and destinations, held through the last write.
  // Fail closed on existing locks; never remove another command's live lock.
  const lock = acquirePublicationLock();
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'o8-promote-'));
    let candidate;
    const targets = [];
    // Validate every destination before the first stable write.
    for (const repo of repos) {
      const beta = download(repo, `v${version}`, 'beta.json', dir);
      validateCandidate(beta, version);
      if (candidate && JSON.stringify(candidate) !== JSON.stringify(beta)) throw new Error('Beta manifests differ between repositories.');
      candidate = beta;
      const tag = feedAnchor(repo);
      const stable = download(repo, tag, 'latest.json', dir);
      validateStable({ ...beta, channel: 'stable' }, stable);
      targets.push({ repo, tag });
    }
    requireSmokeReceipts(candidate, receipts);
    const promoted = { ...candidate, channel: 'stable' };
    const manifest = join(dir, 'latest.json');
    writeFileSync(manifest, `${JSON.stringify(promoted, null, 2)}\n`);
    for (const { repo, tag } of targets) {
      // Re-read inside the lock immediately before each stable write.
      validateStable(promoted, download(repo, tag, 'latest.json', dir));
      writeFileSync(manifest, `${JSON.stringify(promoted, null, 2)}\n`);
      execFileSync('gh', ['release', 'upload', tag, manifest, '--clobber', '--repo', repo], { stdio: 'inherit', timeout: 60_000 });
    }
    console.log(`[promote] Stable now serves ${version} using the beta artifacts.`);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
    lock.release();
  }
}

main().catch(() => {
  // Provider errors can include local paths or credentials. Keep public output bounded.
  console.error('[promote] Promotion failed: check the smoke receipt, beta version, signed manifest, stable platforms, promotion lock and repository access.');
  process.exitCode = 1;
});
