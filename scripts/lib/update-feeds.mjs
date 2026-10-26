import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const heldLocks = new WeakSet();

/** Shared by beta publication and platform completion. */
export function acquireUpdateFeedLock() {
  const path = process.env.O8_UPDATE_FEED_LOCK_PATH || join(tmpdir(), 'o8-update-feed.lock');
  const fd = openSync(path, 'wx', 0o600);
  const lock = { release() {
    if (!heldLocks.delete(lock)) return;
    process.removeListener('exit', lock.release);
    closeSync(fd);
    unlinkSync(path);
  } };
  heldLocks.add(lock);
  process.once('exit', lock.release);
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); }
  catch (error) { lock.release(); throw error; }
  return lock;
}

export function compareReleaseVersions(left, right) {
  const parse = value => {
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
      throw new Error('Channel manifests require a plain release version.');
    }
    return value.split('.').map(BigInt);
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export function feedAnchor(repo) {
  const tag = execFileSync('gh', ['release', 'view', '--repo', repo, '--json', 'tagName', '--jq', '.tagName'], {
    encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('The stable feed anchor is unavailable.');
  return tag;
}

export function downloadFeed(repo, tag, name, dir) {
  execFileSync('gh', ['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', dir, '--clobber'], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  });
  return JSON.parse(readFileSync(join(dir, name), 'utf8'));
}

/** A completion adds one platform, preserving the manifest's version and other fields. */
export function withCompletedPlatform(current, candidate, platform) {
  if (compareReleaseVersions(current.version, candidate.version) !== 0
    || current.channel !== candidate.channel || !candidate.platforms?.[platform]) {
    throw new Error('Platform completion requires the same manifest version and channel.');
  }
  return { ...current, platforms: { ...current.platforms, [platform]: candidate.platforms[platform] } };
}

function betaFeed(repo, tag, dir) {
  // Distinguish a first publication from a failed download; errors never mean absent.
  const inventory = JSON.parse(execFileSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'assets'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  }));
  if (!Array.isArray(inventory.assets)) throw new Error('The feed inventory is unavailable.');
  if (!inventory.assets.some(asset => asset.name === 'beta.json')) return null;
  const current = downloadFeed(repo, tag, 'beta.json', dir);
  if (current.channel !== 'beta') throw new Error('The beta feed identity is missing.');
  compareReleaseVersions(current.version, current.version);
  return current;
}

function assertBetaAdvance(candidate, current) {
  if (current && (compareReleaseVersions(candidate.version, current.version) < 0
    || (current.version === candidate.version
      && !isDeepStrictEqual(current, { ...candidate, pub_date: current.pub_date })))) {
    throw new Error('Beta publication cannot downgrade or replace an existing version.');
  }
}

function assertStableCurrent(candidate, repo, tag, dir) {
  const stable = downloadFeed(repo, tag, 'latest.json', dir);
  if (compareReleaseVersions(candidate.version, stable.version) < 0
    || (candidate.version === stable.version && !isDeepStrictEqual(candidate.platforms, stable.platforms))) {
    throw new Error('Beta publication cannot downgrade or replace the stable version.');
  }
}

/** Validate every destination before writing local manifests or release assets. */
export function assertBetaPublicationCurrent(candidate, repos, { lock }) {
  if (!heldLocks.has(lock)) throw new Error('A live channel lock is required.');
  if (candidate.channel !== 'beta') throw new Error('The candidate is not beta.');
  compareReleaseVersions(candidate.version, candidate.version);
  const dir = mkdtempSync(join(tmpdir(), 'o8-feed-preflight-'));
  try {
    for (const repo of repos) {
      const tag = feedAnchor(repo);
      assertStableCurrent(candidate, repo, tag, dir);
      assertBetaAdvance(candidate, betaFeed(repo, tag, dir));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Stable bytes stay in place. Platform completion never advances a channel. */
export function publishBetaFeed(manifestPath, repos, { lock, platform } = {}) {
  const owner = lock ?? acquireUpdateFeedLock();
  let dir;
  try {
    if (!heldLocks.has(owner)) throw new Error('A live channel lock is required.');
    dir = mkdtempSync(join(tmpdir(), 'o8-feed-'));
    const candidate = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (candidate.channel !== 'beta') throw new Error('The candidate is not beta.');
    compareReleaseVersions(candidate.version, candidate.version);
    const select = current => {
      if (platform) {
        // Late completion remains useful on its tag without rolling back a newer beta.
        if (!current || current.version !== candidate.version) return null;
        return withCompletedPlatform(current, candidate, platform);
      }
      assertBetaAdvance(candidate, current);
      return candidate;
    };
    const targets = repos.map(repo => {
      const tag = feedAnchor(repo);
      if (!platform) assertStableCurrent(candidate, repo, tag, dir);
      select(betaFeed(repo, tag, dir));
      return { repo, tag };
    });
    const path = join(dir, 'beta.json');
    for (const { repo, tag } of targets) {
      // Recheck immediately before upload, retaining any matching-version entries.
      if (!platform) assertStableCurrent(candidate, repo, tag, dir);
      const manifest = select(betaFeed(repo, tag, dir));
      if (!manifest) continue;
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
      execFileSync('gh', ['release', 'upload', tag, path, '--clobber', '--repo', repo], {
        stdio: 'inherit', timeout: 60_000,
      });
    }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (!lock) owner.release();
  }
}
