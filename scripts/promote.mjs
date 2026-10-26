#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_REPOS } from './lib/linux-appimage-signature.mjs';
import { compareReleaseVersions, feedAnchor } from './lib/update-feeds.mjs';

function options(args) {
  let version;
  const repos = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Expected --version <version> and optional --repo <repository>.');
    if (args[i - 1] === '--version') version = value;
    else if (args[i - 1] === '--repo' && /^[\w.-]+\/[\w.-]+$/.test(value)) repos.push(value);
    else throw new Error('Unknown promote option.');
  }
  compareReleaseVersions(version, version);
  return { version, repos: repos.length ? [...new Set(repos)] : DEFAULT_REPOS };
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

async function main() {
  const { version, repos } = options(process.argv.slice(2));
  const dir = mkdtempSync(join(tmpdir(), 'o8-promote-'));
  try {
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
      if (compareReleaseVersions(version, stable.version) < 0) throw new Error('Promotion cannot downgrade stable.');
      if (stable.version === version && JSON.stringify(stable) !== JSON.stringify(beta)) throw new Error('Stable version already has different artifacts.');
      targets.push({ repo, tag });
    }
    const manifest = join(dir, 'latest.json');
    writeFileSync(manifest, `${JSON.stringify(candidate, null, 2)}\n`);
    for (const { repo, tag } of targets) {
      execFileSync('gh', ['release', 'upload', tag, manifest, '--clobber', '--repo', repo], { stdio: 'inherit', timeout: 60_000 });
    }
    console.log(`[promote] Stable now serves ${version} using the beta artifacts.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(() => {
  // Provider errors can include local paths or credentials. Keep public output bounded.
  console.error('[promote] Promotion failed: check the beta version, signed manifest, stable feed and repository access.');
  process.exitCode = 1;
});
