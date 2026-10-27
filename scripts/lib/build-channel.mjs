import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveMacosReleaseArtifacts } from './macos-release-artifacts.mjs';
import { verifyUpdaterSignature } from './updater-signature.mjs';
export const BUILD_CHANNEL_FILE = 'o8-build-channel.json';
/** Build intent is source input. Publication never reads a channel environment variable. */
export function buildChannel(root, version) {
  const channel = version.includes('-preview.')
    ? 'preview'
    : JSON.parse(readFileSync(join(root, 'release-build.json'), 'utf8'))
        .channel;
  if (!['stable', 'beta', 'preview'].includes(channel))
    throw new Error('Invalid build channel identity.');
  return { schema: 'o8/build-channel/v1', version, channel };
}
export function writeBuildChannel(root, server, version) {
  writeFileSync(
    join(server, BUILD_CHANNEL_FILE),
    `${JSON.stringify(buildChannel(root, version))}\n`,
  );
}
/** Authenticate the archive BEFORE extracting its embedded manifest. No unsigned sidecar fallback. */
export function artifactChannel(root, version, expected, suppliedArtifacts) {
  const artifacts =
    suppliedArtifacts ?? resolveMacosReleaseArtifacts(root, version);
  verifyUpdaterSignature(
    root,
    artifacts.updaterArchive,
    artifacts.updaterSignature,
  );
  const bytes = execFileSync(
    'tar',
    [
      'xOf',
      artifacts.updaterArchive,
      `o8.app/Contents/Resources/server/${BUILD_CHANNEL_FILE}`,
    ],
    { encoding: 'utf8', maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let identity;
  try {
    identity = JSON.parse(bytes);
  } catch {
    throw new Error('Invalid signed build channel identity.');
  }
  if (
    identity.schema !== 'o8/build-channel/v1' ||
    identity.version !== version ||
    identity.channel !== expected
  ) {
    throw new Error(
      'Signed build channel identity does not match this publisher.',
    );
  }
  return { artifacts, identity };
}
