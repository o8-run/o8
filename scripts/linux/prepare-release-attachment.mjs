#!/usr/bin/env node
/** Prepare authenticated attachments only. This command never uploads or signs. */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertLinuxArtifactChannels } from '../lib/linux-build-channel.mjs';
import { withLinuxPlatform } from '../lib/linux-appimage-signature.mjs';

function main() {
  if (process.env.O8_PUBLISH_LINUX !== 'true') {
    console.log(JSON.stringify({ status: 'disabled', publishLinux: false, assets: [] }));
    return;
  }
  const tag = process.env.RELEASE_TAG;
  const match = /^v(\d+\.\d+\.\d+)$/.exec(tag ?? '');
  const repo = process.env.GH_REPO;
  if (!match || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('Expected release tag and source repository');
  const version = match[1];
  const signature = process.env.UPDATER_SIGNATURE?.trim();
  if (!signature) throw new Error('Public updater signature is required');
  const images = readdirSync('packages').filter(name => name.endsWith('.AppImage'));
  if (images.length !== 1) throw new Error('Expected exactly one GPUI AppImage');
  const source = join('packages', images[0]);
  writeFileSync(`${source}.sig`, signature + '\n', { flag: 'wx' });
  // Authenticate bytes before reading identity. Distribution installers stay
  // outside the upload list because they have no authenticated channel.
  const [identity] = assertLinuxArtifactChannels(process.cwd(), version, undefined, [source, `${source}.sig`]);
  const manifestName = { stable: 'latest.json', beta: 'beta.json', preview: 'preview.json' }[identity.channel];
  const scratch = mkdtempSync(join(tmpdir(), 'o8-linux-attach-'));
  try {
    execFileSync('gh', ['release', 'download', tag, '--repo', repo, '--pattern', manifestName, '--dir', scratch],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const manifest = JSON.parse(readFileSync(join(scratch, manifestName), 'utf8'));
    if (manifest.version !== version || manifest.channel !== identity.channel) {
      throw new Error('Published manifest channel/version does not match signed Linux build identity');
    }
    // Apply the existing completion publisher's download-anchor validation.
    // Discard the proposed manifest: attachment never writes an updater feed.
    withLinuxPlatform({ latest: manifest, version, signature });
    mkdirSync('publish'); // Exclusive: never overwrite an operator's output.
    const name = `o8-${version}-x86_64.AppImage`;
    copyFileSync(source, join('publish', name));
    copyFileSync(`${source}.sig`, join('publish', `${name}.sig`));
    console.log(JSON.stringify({ status: 'prepared', channel: identity.channel, version, assets: [name, `${name}.sig`] }));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
try { main(); } catch (error) { console.error(`Linux attachment refused: ${error.message}`); process.exitCode = 1; }
