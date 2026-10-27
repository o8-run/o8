#!/usr/bin/env node
/**
 * Operator step: sign a CI-published Linux AppImage and put it in the updater
 * manifest.
 *
 * `tauri.portci.conf.json` sets `createUpdaterArtifacts: false`, so the Linux
 * build published by the port-build workflow carries no `.AppImage.sig` and the
 * updater cannot accept it. The minisign key never leaves the ship machine, so
 * the signature is produced here, by hand, against an already-published tag:
 *
 *   1. Verify the tag's release is published (not a draft) and actually holds
 *      the expected `o8_<version>_linux_amd64_preview.AppImage`
 *   2. Download that asset
 *   3. Sign it with the same key + invocation the macOS updater artifact uses
 *   4. Verify the signature and inspect the embedded build channel without
 *      executing the AppImage, then add only `linux-x86_64` to that channel's
 *      matching manifest on each repository
 *
 * Usage:
 *   npm run ship:linux-sig -- --tag v0.1.724
 *   npm run ship:linux-sig -- --tag v0.1.724 --repo o8-run/o8 --repo hurttlocker/o8-releases
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_REPOS,
  createLinuxSignatureDeps,
  signLinuxAppImage,
  versionFromTag,
  withLinuxPlatform,
} from './lib/linux-appimage-signature.mjs';
import { readLinuxBuildChannel } from './lib/linux-build-channel.mjs';
import { acquirePublicationLock, BETA_FEED_TAG } from './lib/release-publication.mjs';

const LOG = '[sign-linux-appimage]';

function parseArgs(argv) {
  const options = { tag: null, repos: [], help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--tag') options.tag = argv[++index] ?? null;
    else if (arg.startsWith('--tag=')) options.tag = arg.slice('--tag='.length);
    else if (arg === '--repo') options.repos.push(argv[++index] ?? '');
    else if (arg.startsWith('--repo=')) options.repos.push(arg.slice('--repo='.length));
    else throw new Error(`unrecognized argument: ${arg}`);
  }
  if (options.repos.length === 0) options.repos = [...DEFAULT_REPOS];
  return options;
}

function usage() {
  console.log([
    'Usage: npm run ship:linux-sig -- --tag <vX.Y.Z> [--repo <owner/name> ...]',
    '',
    'Signs the tag\'s published Linux AppImage with the operator updater key and',
    'republishes the signature plus the signed build channel\'s updater manifest.',
    '',
    `Default repositories: ${DEFAULT_REPOS.join(', ')}`,
    '',
    'Requires the updater signing key on this machine. Never runs on CI.',
  ].join('\n'));
}

function channelSignatureDeps(root, options, workDir) {
  const original = createLinuxSignatureDeps();
  const version = versionFromTag(options.tag);
  const manifests = new Map();
  let identity;
  let signature;
  let installerSha256;
  const completeManifest = (current) => {
    const latest = withLinuxPlatform({ latest: current, version, signature });
    if (identity.channel === 'beta') {
      const url = latest.platforms['linux-x86_64'].url;
      latest.installers = [...(current.installers ?? []).filter(entry => entry.url !== url), { url, sha256: installerSha256 }];
    }
    return latest;
  };
  const manifestName = () => ({ stable: 'latest.json', beta: 'beta.json', preview: 'preview.json' })[identity.channel];
  const requireManifest = (latest) => {
    if (latest?.version !== version || latest.channel !== identity.channel) {
      throw new Error(`Published manifest channel/version does not match signed Linux build identity (${identity.channel} ${version})`);
    }
    return latest;
  };
  const downloadManifest = (repo, tag, label) => {
    const destDir = join(workDir, label);
    mkdirSync(destDir, { recursive: true });
    const name = manifestName();
    execFileSync('gh', ['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', destDir, '--clobber'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(readFileSync(join(destDir, name), 'utf8'));
  };
  const writeManifest = (repo, latest, label) => {
    const directory = join(workDir, label, repo.replaceAll('/', '-'));
    mkdirSync(directory, { recursive: true });
    const path = join(directory, manifestName());
    writeFileSync(path, `${JSON.stringify(latest, null, 2)}\n`);
    return path;
  };
  return {
    deps: {
      ...original,
      signAppImage: async (args) => {
        const sigPath = await original.signAppImage(args);
        identity = readLinuxBuildChannel(root, args.filePath, sigPath, version);
        signature = readFileSync(sigPath, 'utf8').trim();
        installerSha256 = createHash('sha256').update(readFileSync(args.filePath)).digest('hex');
        return sigPath;
      },
      fetchLatestJson: ({ repo, tag }) => {
        // Preflight every destination before any manifest upload. The shared
        // publication lock keeps local publishers from changing these feeds.
        for (const [index, target] of options.repos.entries()) {
          const current = requireManifest(downloadManifest(target, tag, `current-${index}`));
          // Validate the Darwin URL before the first repository is mutated.
          withLinuxPlatform({ latest: current, version, signature });
          manifests.set(target, current);
        }
        return manifests.get(repo);
      },
      writeLatestJson: ({ latest }) => { writeManifest(options.repos[0], latest, 'generated'); },
      uploadAssets: ({ repo, tag, files }) => {
        const current = requireManifest(manifests.get(repo));
        const latest = completeManifest(current);
        const path = writeManifest(repo, latest, 'tag-completion');
        original.uploadAssets({ repo, tag, files: [files[0], path] });
      },
    },
    manifestName,
    completeRollingBeta: () => {
      if (identity.channel !== 'beta') return;
      for (const [index, repo] of options.repos.entries()) {
        const release = original.fetchRelease({ repo, tag: BETA_FEED_TAG });
        if (!release || release.isDraft) throw new Error(`Beta feed anchor ${BETA_FEED_TAG} must be provisioned and published by an operator in ${repo}`);
        const current = downloadManifest(repo, BETA_FEED_TAG, `rolling-${index}`);
        if (current.channel !== 'beta') throw new Error(`Beta feed anchor in ${repo} has an invalid channel identity`);
        // Completing an older or newer tag cannot advance or roll back the
        // independently provisioned rolling feed.
        if (current.version !== version) {
          console.log(`${LOG} leaving ${repo} beta anchor at ${current.version}`);
          continue;
        }
        const latest = completeManifest(current);
        const path = writeManifest(repo, latest, 'rolling-completion');
        original.uploadAssets({ repo, tag: BETA_FEED_TAG, files: [path] });
      }
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (!options.tag) throw new Error('--tag is required (for example --tag v0.1.724)');
  // The key is an operator secret; a CI runner must never reach the signer.
  if (process.env.CI) throw new Error('refusing to run on CI — the updater signing key stays on the ship machine');

  const lock = acquirePublicationLock();
  let workDir;
  try {
    workDir = mkdtempSync(join(tmpdir(), 'o8-linux-appimage-sig-'));
    const channel = channelSignatureDeps(process.cwd(), options, workDir);
    const result = await signLinuxAppImage({
      tag: options.tag,
      repos: options.repos,
      workDir,
      deps: channel.deps,
      log: (message) => console.log(`${LOG} ${message.includes('latest.json') ? message.replaceAll('latest.json', channel.manifestName()) : message}`),
    });
    channel.completeRollingBeta();
    console.log(`${LOG} published ${result.assetName}.sig and ${channel.manifestName()} for ${options.tag}`);
    console.log(`${LOG} linux-x86_64 url: ${result.latest.platforms['linux-x86_64'].url}`);
  } finally {
    try { if (workDir) rmSync(workDir, { recursive: true, force: true }); }
    finally { lock.release(); }
  }
}

main().catch((error) => {
  console.error(`${LOG} FATAL: ${error?.message ?? error}`);
  process.exit(1);
});
