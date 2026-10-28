#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { artifactChannel } from './lib/build-channel.mjs';
import { dataDir, releaseRange } from './lib/fixed-reports.mjs';
import { readLinuxBuildChannel } from './lib/linux-build-channel.mjs';
import { DEFAULT_REPOS } from './lib/linux-appimage-signature.mjs';
import { verifyMacosDmgMatchesApp } from './lib/macos-release-artifacts.mjs';
import { releaseBuildProfile } from './lib/release-build-profile.mjs';
import { acquirePublicationLock, BETA_FEED_TAG, compareVersions } from './lib/release-publication.mjs';
import { warmUpdatePublication } from './lib/release-update-warmup.mjs';
import { stableReleaseEffects } from './lib/stable-release-effects.mjs';
import { verifyUpdaterSignature } from './lib/updater-signature.mjs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
function view(repo, tag) {
  return JSON.parse(gh(['release', 'view', ...(tag ? [tag] : []), '--repo', repo,
    '--json', 'tagName,isDraft,isPrerelease,publishedAt,assets']));
}
function download(repo, tag, dir, pattern) {
  mkdirSync(dir, { recursive: true });
  gh(['release', 'download', tag, '--repo', repo, '--dir', dir, ...(pattern ? ['--pattern', pattern] : [])]);
}
function manifestAsset(url, version) {
  const parsed = new URL(url);
  const prefix = `/hurttlocker/o8-releases/releases/download/v${version}/`;
  if (parsed.origin !== 'https://github.com' || parsed.username || parsed.password || parsed.search || parsed.hash
    || !parsed.pathname.startsWith(prefix)) throw new Error('Invalid candidate asset URL.');
  const name = decodeURIComponent(parsed.pathname.slice(prefix.length));
  if (!name || basename(name) !== name || /[\\/\x00-\x1f*?\[\]]/.test(name)) throw new Error('Invalid candidate asset name.');
  return name;
}
function stablePreflight(repo, version, candidate, dir) {
  const release = view(repo);
  if (release.isDraft !== false || release.isPrerelease !== false) throw new Error('Stable release evidence is invalid.');
  download(repo, release.tagName, dir, 'latest.json');
  const current = json(join(dir, 'latest.json'));
  if (!['stable', undefined].includes(current.channel) || release.tagName !== `v${current.version}`)
    throw new Error('Stable manifest identity is invalid.');
  const comparison = compareVersions(version, current.version);
  if (comparison < 0) throw new Error('Refusing to downgrade stable.');
  for (const platform of Object.keys(current.platforms ?? {})) {
    if (!Object.hasOwn(candidate.platforms, platform)) throw new Error('Candidate would remove a stable platform.');
  }
  if (comparison === 0 && (current.channel !== 'stable' || !isDeepStrictEqual(current.platforms, candidate.platforms)))
    throw new Error('Stable version already has different artifacts or channel.');
  return { repo, tag: release.tagName, previousVersion: current.version, alreadyServing: comparison === 0 };
}
function persist(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

async function main(args) {
  const [tag, ...flags] = args;
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? '')
    || flags.some(flag => flag !== '--dry-run') || new Set(flags).size !== flags.length)
    throw new Error('Usage: node scripts/promote.mjs vX.Y.Z [--dry-run]');
  const version = tag.slice(1), dryRun = flags.includes('--dry-run'), root = process.cwd();
  const lock = acquirePublicationLock();
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'o8-promote-'));
    const destinations = [];
    let candidate, assets;
    for (const [index, repo] of DEFAULT_REPOS.entries()) {
      const release = view(repo, tag);
      if (release.tagName !== tag || release.isDraft !== false || typeof release.isPrerelease !== 'boolean')
        throw new Error('Candidate release is not published.');
      const candidateDir = join(dir, String(index), 'candidate');
      download(repo, tag, candidateDir);
      const names = readdirSync(candidateDir).filter(name => !['latest.json', 'fixed.json'].includes(name)).sort();
      if (!names.includes('beta.json')) throw new Error('Candidate has no beta manifest.');
      const hashes = Object.fromEntries(names.map(name => [name, sha256(join(candidateDir, name))]));
      if (assets && !isDeepStrictEqual(assets, hashes)) throw new Error('Candidate assets differ between repositories.');
      assets = hashes;
      const beta = json(join(candidateDir, 'beta.json'));
      if (beta.channel !== 'beta' || beta.version !== version || !Object.keys(beta.platforms ?? {}).length)
        throw new Error('Candidate beta identity or platforms are invalid.');
      if (candidate && !isDeepStrictEqual(candidate, beta)) throw new Error('Candidate manifests differ.');
      candidate = beta;
      const authenticated = new Map();
      for (const [platform, entry] of Object.entries(beta.platforms)) {
        const name = manifestAsset(entry.url, version);
        const archive = join(candidateDir, name), signature = `${archive}.sig`;
        if (!names.includes(name) || !names.includes(`${name}.sig`)
          || typeof entry.signature !== 'string' || entry.signature.trim() !== readFileSync(signature, 'utf8').trim())
          throw new Error('Missing or mismatched updater signature.');
        verifyUpdaterSignature(root, archive, signature);
        let identity;
        if (platform.startsWith('darwin-') && name.endsWith('.tar.gz')) {
          const architecture = { 'darwin-aarch64': 'arm64', 'darwin-x86_64': 'x86_64' }[platform];
          if (!architecture || !['o8.app.tar.gz', `o8_${architecture}.app.tar.gz`].includes(name))
            throw new Error('Updater platform does not match its archive architecture.');
          identity = artifactChannel(root, version, 'beta', { updaterArchive: archive, updaterSignature: signature }).identity;
        } else if (platform.startsWith('linux-') && name.endsWith('.AppImage')) {
          identity = readLinuxBuildChannel(root, archive, signature, version, 'beta');
        } else throw new Error('Unsupported authenticated candidate platform.');
        if (beta.buildIdentity && !isDeepStrictEqual(beta.buildIdentity, identity)) throw new Error('Manifest build identity differs from signed bytes.');
        authenticated.set(name, platform);
      }
      // CPU manifests can reference only CPU archives while retaining universal
      // delivery assets. Authenticate retained archives too, not only feed URLs.
      for (const name of names.filter(name => name.endsWith('.tar.gz'))) {
        if (!/^o8(?:_(?:arm64|x86_64))?\.app\.tar\.gz$/.test(name)) throw new Error('Unknown macOS updater archive.');
        const architecture = name === 'o8.app.tar.gz' ? 'universal' : name.slice(3, -11);
        if (!names.includes(`o8_${version}_${architecture}.dmg`)) throw new Error('Updater archive has no matching DMG.');
        if (!names.includes(`${name}.sig`)) throw new Error('Retained updater archive has no signature.');
        if (!authenticated.has(name)) {
          artifactChannel(root, version, 'beta', { updaterArchive: join(candidateDir, name), updaterSignature: join(candidateDir, `${name}.sig`) });
          authenticated.set(name, 'darwin-retained');
        }
      }
      const dmgs = names.filter(name => name.endsWith('.dmg'));
      if (!dmgs.length) throw new Error('Candidate has no notarized DMG.');
      for (const name of dmgs) {
        const architecture = name.endsWith('_universal.dmg') ? undefined
          : name.endsWith('_arm64.dmg') ? 'arm64' : name.endsWith('_x86_64.dmg') ? 'x86_64' : null;
        if (architecture === null || !name.startsWith(`o8_${version}_`)) throw new Error('Unknown DMG identity.');
        const archiveName = architecture === undefined ? 'o8.app.tar.gz' : `o8_${architecture}.app.tar.gz`;
        if (!authenticated.has(archiveName)) throw new Error('DMG has no authenticated matching archive.');
        const extraction = join(dir, String(index), name + '-app');
        mkdirSync(extraction);
        execFileSync('tar', ['xzf', join(candidateDir, archiveName), '-C', extraction], { stdio: 'pipe' });
        verifyMacosDmgMatchesApp(join(extraction, 'o8.app'), join(candidateDir, name), version, architecture);
        execFileSync('xcrun', ['stapler', 'validate', join(candidateDir, name)], { stdio: 'pipe' });
      }
      const allowed = new Set(['beta.json', ...dmgs, ...[...authenticated.keys()].flatMap(name => [name, `${name}.sig`])]);
      if (names.some(name => !allowed.has(name))) throw new Error('Candidate contains an unverified asset.');
      const feed = view(repo, BETA_FEED_TAG);
      if (feed.tagName !== BETA_FEED_TAG || feed.isDraft !== false || feed.isPrerelease !== true) throw new Error('Invalid beta feed anchor.');
      const feedDir = join(dir, String(index), 'beta-feed');
      download(repo, BETA_FEED_TAG, feedDir, 'beta.json');
      const currentBeta = json(join(feedDir, 'beta.json'));
      if (currentBeta.channel !== 'beta' || compareVersions(currentBeta.version, version) < 0)
        throw new Error('Beta feed must name the candidate or a newer version.');
      destinations.push(stablePreflight(repo, version, beta, join(dir, String(index), 'stable')));
    }
    // Resolve all metadata before any provider write, anchored at the promoted tag.
    const range = releaseRange(tag);
    const receiptPath = join(dataDir(), 'release-verification', `${tag}.json`);
    const previous = existsSync(receiptPath) ? json(receiptPath) : null;
    const receipt = { schema: 'o8/promotion-verification/v1', status: 'verified', version, channel: 'beta',
      verifiedAt: new Date().toISOString(), repositories: DEFAULT_REPOS, assets, range,
      checks: { updaterSignatures: true, embeddedIdentity: true, dmgMatchesArchive: true, staple: true, identicalRepositories: true, betaFeed: true },
      completion: previous?.version === version && isDeepStrictEqual(previous.assets, assets) ? previous.completion ?? {} : {},
      installedSmoke: previous?.version === version && isDeepStrictEqual(previous.assets, assets) ? previous.installedSmoke ?? null : null };
    persist(receiptPath, receipt);
    // Publication consumes a persisted receipt, never a manifest-only assertion.
    const verified = json(receiptPath);
    if (verified.schema !== receipt.schema || verified.status !== 'verified' || verified.version !== version
      || verified.channel !== 'beta' || !isDeepStrictEqual(verified.assets, assets)
      || !isDeepStrictEqual(verified.checks, receipt.checks)) throw new Error('Missing or invalid verification receipt.');
    for (const [index] of DEFAULT_REPOS.entries()) for (const [name, hash] of Object.entries(verified.assets)) {
      if (sha256(join(dir, String(index), 'candidate', name)) !== hash) throw new Error('Receipt asset hash changed.');
    }
    console.log(`[promote] verified ${tag}: ${Object.keys(assets).length} identical assets in both repositories; signatures, signed beta identity, DMG match, staple and feeds passed.`);
    console.log(`[promote] verification receipt: ${receiptPath}`);
    const plan = { version, channel: 'stable', repositories: DEFAULT_REPOS,
      effects: ['upload latest.json marked stable and fixed.json to the candidate tag in both repositories',
        'edit candidate releases --prerelease=false --latest=true', 'reconcile Fixes-Report ids and notify reporters',
        'publish stable changelog and latest-ship feed', 'publish stable release announcement'],
      betaFeed: 'unchanged', updaterArtifacts: 'unchanged', alreadyServing: destinations.every(target => target.alreadyServing) };
    console.log(`[promote] ${dryRun ? 'dry-run plan' : 'plan'}: ${JSON.stringify(plan)}`);
    if (dryRun) return;
    const stable = stableReleaseEffects({ root, version, tag, range, notesRef: tag });
    const pubDate = candidate.pub_date || new Date().toISOString();
    const latestPath = join(dir, 'latest.json'), fixedPath = join(dir, 'fixed.json');
    writeFileSync(latestPath, `${JSON.stringify({ ...candidate, channel: 'stable' }, null, 2)}\n`);
    await stable.prepareFixed(fixedPath, pubDate);
    const notes = stable.prepareNotes();
    // All destinations passed. A retry repairs partial writes without touching beta bytes.
    for (const [index, target] of destinations.entries()) {
      stablePreflight(target.repo, version, candidate, join(dir, 'recheck', String(index)));
      gh(['release', 'upload', tag, latestPath, fixedPath, '--clobber', '--repo', target.repo]);
      gh(['release', 'edit', tag, '--prerelease=false', '--latest=true', '--notes', notes, '--repo', target.repo]);
    }
    try {
      const offerPath = join(releaseBuildProfile(root, process.env, { release: true }).profile,
        'update-publication', `${tag}.json`);
      const offered = existsSync(offerPath) ? json(offerPath) : null;
      // A retry must preserve successful offer evidence byte for byte.
      if (offered?.schema !== 'o8/update-publication-receipt/v1' || offered.version !== version
        || !['offered', 'completed'].includes(offered.status)) {
        const previousVersion = range.split('..')[0].replace(/^v/, '');
        if (compareVersions(previousVersion, version) >= 0) throw new Error('Offer probe requires an older stable version.');
        const offer = await warmUpdatePublication({ root, version, previousVersion,
          publishedAt: stable.resolvePublishedAt(pubDate), receiptPath: offerPath });
        const timing = offer.publishToOfferMs === null ? 'unverified' : `${offer.publishToOfferMs}ms`;
        console.log(`[promote] update publication ${offer.status}; publish-to-offer ${timing}; within-five-minutes=${offer.withinPublishToOfferBudget ?? 'unverified'}`);
      }
    } catch {
      console.warn('[promote] update publication verification unavailable; no fresh-offer receipt was recorded.');
    }
    const completion = await stable.complete(pubDate, { completed: verified.completion,
      mark(step) { verified.completion[step] = true; persist(receiptPath, verified); } });
    if (!completion.complete) throw new Error(`Stable completion needs retry: ${completion.failures.join(', ')}`);
    console.log(`[promote] done: stable ${tag}; beta tag, beta.json and signed artifacts unchanged.`);
  } finally {
    try { if (dir) rmSync(dir, { recursive: true, force: true }); }
    finally { lock.release(); }
  }
}
main(process.argv.slice(2)).catch(error => {
  console.error(`[promote] Promotion refused: ${error.message}`);
  process.exitCode = 1;
});
