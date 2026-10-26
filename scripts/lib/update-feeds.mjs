import { execFileSync } from 'node:child_process';

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

/** Keep the existing latest-release URL and stable bytes in place. */
export function publishBetaFeed(manifestPath, repos) {
  const targets = repos.map(repo => ({ repo, tag: feedAnchor(repo) }));
  for (const { repo, tag } of targets) {
    execFileSync('gh', ['release', 'upload', tag, manifestPath, '--clobber', '--repo', repo], {
      stdio: 'inherit', timeout: 60_000,
    });
  }
}
