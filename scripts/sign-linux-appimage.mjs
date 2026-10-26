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
 *   4. Upload `<asset>.sig` next to it, and a regenerated `latest.json` that
 *      gains exactly one `linux-x86_64` entry (darwin entries untouched)
 *
 * Usage:
 *   npm run ship:linux-sig -- --tag v0.1.724
 *   npm run ship:linux-sig -- --tag v0.1.724 --repo o8-run/o8 --repo hurttlocker/o8-releases
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_REPOS,
  createLinuxSignatureDeps,
  signLinuxAppImage,
} from './lib/linux-appimage-signature.mjs';

import { execFileSync } from 'node:child_process';
import { acquireUpdateFeedLock, downloadFeed, publishBetaFeed, withCompletedPlatform } from './lib/update-feeds.mjs';

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
    'republishes the signature plus a latest.json carrying the linux-x86_64 entry.',
    '',
    `Default repositories: ${DEFAULT_REPOS.join(', ')}`,
    '',
    'Requires the updater signing key on this machine. Never runs on CI.',
  ].join('\n'));
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

  const lock = acquireUpdateFeedLock();
  let workDir;
  try {
    workDir = mkdtempSync(join(tmpdir(), 'o8-linux-appimage-sig-'));
    const readDir = join(workDir, 'current');
    mkdirSync(readDir);
    const deps = createLinuxSignatureDeps();
    const upload = deps.uploadAssets;
    // Keep the existing signer unchanged; publication merges only the Linux entry.
    deps.uploadAssets = ({ repo, tag, files }) => {
      const path = files.find(file => file.endsWith('/latest.json'));
      const candidate = JSON.parse(readFileSync(path, 'utf8'));
      const current = downloadFeed(repo, tag, 'latest.json', readDir);
      writeFileSync(path, `${JSON.stringify(withCompletedPlatform(current, candidate, 'linux-x86_64'), null, 2)}\n`);
      return upload({ repo, tag, files });
    };
    const result = await signLinuxAppImage({
      tag: options.tag,
      repos: options.repos,
      workDir,
      deps,
      log: (message) => console.log(`${LOG} ${message}`),
    });
    // Complete beta publication after the existing signing operation.
    if (result.latest.channel === 'beta') {
      const betaPath = join(workDir, 'beta.json');
      for (const repo of result.repos) {
        const current = downloadFeed(repo, options.tag, 'beta.json', readDir);
        const completed = withCompletedPlatform(current, result.latest, 'linux-x86_64');
        writeFileSync(betaPath, `${JSON.stringify(completed, null, 2)}\n`);
        execFileSync('gh', ['release', 'upload', options.tag, betaPath, '--clobber', '--repo', repo], { stdio: 'inherit', timeout: 60_000 });
      }
      publishBetaFeed(betaPath, result.repos, { lock, platform: 'linux-x86_64' });
    }
    console.log(`${LOG} published ${result.assetName}.sig and latest.json for ${options.tag}`);
    console.log(`${LOG} linux-x86_64 url: ${result.latest.platforms['linux-x86_64'].url}`);
  } finally {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    lock.release();
  }
}

main().catch((error) => {
  console.error(`${LOG} FATAL: ${error?.message ?? error}`);
  process.exit(1);
});
