const NUMBER = '(?:0|[1-9][0-9]*)';
const STABLE_VERSION = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}$`);
const PREVIEW_VERSION = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}-preview\\.${NUMBER}$`);

/** Fail before build or publication when a channel could reach the wrong feed. */
export function resolveReleaseChannel(version, env = process.env) {
  const channel = env.O8_RELEASE_CHANNEL?.trim() || 'stable';
  if (channel !== 'stable' && channel !== 'preview') {
    throw new Error('O8_RELEASE_CHANNEL must be stable or preview.');
  }
  const preview = channel === 'preview';
  if (!(preview ? PREVIEW_VERSION : STABLE_VERSION).test(version)) {
    throw new Error(preview
      ? 'Preview releases require a unique version such as 0.1.741-preview.1.'
      : 'Stable releases require a version without a prerelease suffix.');
  }
  if (preview && env.O8_RELEASE_CLOBBER === '1') {
    throw new Error('Preview artifacts are immutable; use a new preview version.');
  }
  return Object.freeze({
    channel,
    preview,
    tag: `v${version}`,
    manifestName: preview ? 'preview.json' : 'latest.json',
    githubFlags: preview ? ['--prerelease', '--latest=false'] : [],
    publishStableEffects: !preview,
  });
}
