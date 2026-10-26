// Filesystem-backed GitHub release boundary; no network or real signing tools.
export const releaseCandidateProvider = `
function candidateRelease(args) {
  const repo = args[args.indexOf(args.includes('--repo') ? '--repo' : '-R') + 1];
  const root = process.env.O8_CHANNEL_TEST_RELEASES;
  const anchor = JSON.parse(readFileSync(join(root, 'anchors.json'), 'utf8'))[repo];
  const tag = args[2]?.startsWith('v') ? args[2] : anchor;
  const directory = join(root, repo.replaceAll('/', '-'), tag);
  if (args[1] === 'view') {
    if (!existsSync(directory)) throw new Error('release not found');
    if (args.includes('tagName')) return anchor;
    if (args.includes('assets')) return JSON.stringify({ assets: readdirSync(directory).map(name => ({ name })) });
    return '{}';
  }
  if (args[1] === 'download') {
    const destination = args[args.indexOf('--dir') + 1];
    const names = args.includes('--pattern') ? [args[args.indexOf('--pattern') + 1]] : readdirSync(directory);
    for (const name of names) cpSync(join(directory, name), join(destination, name));
    return '';
  }
  if (args[1] === 'create' || args[1] === 'upload') {
    if (args[1] === 'create' && repo === 'hurttlocker/o8-releases' && process.env.O8_CHANNEL_TEST_FAIL_MIRROR === '1') {
      throw new Error('mirror unavailable');
    }
    mkdirSync(directory, { recursive: true });
    for (const path of args.slice(3)) {
      if (!path.startsWith('--') && existsSync(path) && !readdirSafe(path)) cpSync(path, join(directory, basename(path)));
    }
    return '';
  }
  if (args[1] === 'edit') return '';
  throw new Error('unexpected fixture release operation');
}
function readdirSafe(path) { try { readdirSync(path); return true; } catch { return false; } }
`;
