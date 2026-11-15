import { describe, expect, it } from 'vitest';
import {
  DARWIN_UPDATER_ASSET,
  GH_COMMAND,
  LATEST_JSON_ASSET,
  SIGNER_ARGS,
  SIGNER_COMMAND,
  SIGNING_KEY_ENV,
  SIGNING_KEY_PASSWORD_ENV,
  createLinuxSignatureDeps,
  resolveSigningKey,
  signLinuxAppImage,
  versionFromTag,
  withLinuxPlatform,
  type LinuxSignatureDeps,
  type ReleaseUpdaterManifest,
} from '../scripts/lib/linux-appimage-signature.mjs';
import { publishedLinuxAssetName } from '../scripts/lib/release-manifest.mjs';

const TAG = 'v0.1.724';
const VERSION = '0.1.724';
const ASSET = publishedLinuxAssetName(VERSION);
const BASE = 'https://github.com/hurttlocker/o8-releases/releases/download/v0.1.724';

function publishedLatest(): ReleaseUpdaterManifest {
  return {
    version: VERSION,
    notes: 'o8 v0.1.724',
    pub_date: '2026-09-01T00:00:00.000Z',
    platforms: {
      'darwin-x86_64': { signature: 'darwin-sig', url: `${BASE}/${DARWIN_UPDATER_ASSET}` },
      'darwin-aarch64': { signature: 'darwin-sig', url: `${BASE}/${DARWIN_UPDATER_ASSET}` },
    },
  };
}

type Call = { name: string; args: Record<string, unknown> };

function harness(overrides: Partial<LinuxSignatureDeps> = {}) {
  const calls: Call[] = [];
  const record = (name: string, args: Record<string, unknown>) => calls.push({ name, args });
  const deps: LinuxSignatureDeps = {
    resolveSigningKey: () => 'operator-key',
    fetchRelease: ({ repo, tag }) => {
      record('fetchRelease', { repo, tag });
      return { isDraft: false, assets: [ASSET, 'o8.app.tar.gz', LATEST_JSON_ASSET] };
    },
    downloadAsset: ({ repo, tag, assetName, destDir }) => {
      record('downloadAsset', { repo, tag, assetName, destDir });
      return `${destDir}/${assetName}`;
    },
    signAppImage: ({ filePath, signingKey }) => {
      record('signAppImage', { filePath, signingKey });
      return `${filePath}.sig`;
    },
    readSignature: ({ sigPath }) => {
      record('readSignature', { sigPath });
      return 'linux-sig\n';
    },
    fetchLatestJson: ({ repo, tag, destDir }) => {
      record('fetchLatestJson', { repo, tag, destDir });
      return publishedLatest();
    },
    writeLatestJson: ({ path, latest }) => { record('writeLatestJson', { path, latest }); },
    uploadAssets: ({ repo, tag, files }) => { record('uploadAssets', { repo, tag, files }); },
    ...overrides,
  };
  return { calls, deps };
}

describe('linux AppImage updater signature', () => {
  it('signs the published asset and publishes the signature plus manifest', async () => {
    const { calls, deps } = harness();
    const result = await signLinuxAppImage({
      tag: TAG,
      workDir: '/work',
      deps,
    });

    expect(result.assetName).toBe(ASSET);
    expect(calls.filter((call) => call.name === 'fetchRelease').map((call) => call.args.repo))
      .toEqual(['o8-run/o8', 'hurttlocker/o8-releases']);
    expect(calls.find((call) => call.name === 'downloadAsset')?.args)
      .toMatchObject({ repo: 'o8-run/o8', assetName: ASSET, destDir: '/work' });
    expect(calls.find((call) => call.name === 'signAppImage')?.args)
      .toEqual({ filePath: `/work/${ASSET}`, signingKey: 'operator-key' });

    const uploads = calls.filter((call) => call.name === 'uploadAssets');
    expect(uploads.map((call) => call.args.repo)).toEqual(['o8-run/o8', 'hurttlocker/o8-releases']);
    for (const upload of uploads) {
      expect(upload.args.files).toEqual([`/work/${ASSET}.sig`, `/work/${LATEST_JSON_ASSET}`]);
    }
  });

  it('adds exactly one linux entry and leaves the darwin entries byte-for-byte', () => {
    const latest = publishedLatest();
    const next = withLinuxPlatform({ latest, version: VERSION, signature: 'linux-sig' });

    expect(Object.keys(next.platforms)).toEqual(['darwin-x86_64', 'darwin-aarch64', 'linux-x86_64']);
    expect(JSON.stringify(next.platforms['darwin-x86_64'])).toBe(JSON.stringify(latest.platforms['darwin-x86_64']));
    expect(JSON.stringify(next.platforms['darwin-aarch64'])).toBe(JSON.stringify(latest.platforms['darwin-aarch64']));
    expect(next.platforms['linux-x86_64']).toEqual({ signature: 'linux-sig', url: `${BASE}/${ASSET}` });
    expect(latest.platforms['linux-x86_64']).toBeUndefined();
  });

  it('keeps CPU-specific Darwin entries when adding the Linux signature', () => {
    const latest = publishedLatest();
    latest.platforms['darwin-x86_64'] = { signature: 'intel-sig', url: `${BASE}/o8_x86_64.app.tar.gz` };
    latest.platforms['darwin-aarch64'] = { signature: 'arm-sig', url: `${BASE}/o8_arm64.app.tar.gz` };
    const next = withLinuxPlatform({ latest, version: VERSION, signature: 'linux-sig' });
    expect(next.platforms['darwin-x86_64']).toEqual(latest.platforms['darwin-x86_64']);
    expect(next.platforms['darwin-aarch64']).toEqual(latest.platforms['darwin-aarch64']);
    expect(next.platforms['linux-x86_64']?.url).toBe(`${BASE}/${ASSET}`);
  });

  it('fails closed when the release is missing, a draft, or has no AppImage', async () => {
    const missing = harness({ fetchRelease: () => null });
    await expect(signLinuxAppImage({ tag: TAG, repos: ['o/r'], workDir: '/work', deps: missing.deps }))
      .rejects.toThrow(/was not found in o\/r/);

    const draft = harness({ fetchRelease: () => ({ isDraft: true, assets: [ASSET] }) });
    await expect(signLinuxAppImage({ tag: TAG, repos: ['o/r'], workDir: '/work', deps: draft.deps }))
      .rejects.toThrow(/is a draft/);

    const wrongVersion = harness({
      fetchRelease: () => ({ isDraft: false, assets: [publishedLinuxAssetName('0.1.723')] }),
    });
    await expect(signLinuxAppImage({ tag: TAG, repos: ['o/r'], workDir: '/work', deps: wrongVersion.deps }))
      .rejects.toThrow(/has no o8-0\.1\.724-x86_64\.AppImage asset/);

    expect(missing.calls.some((call) => call.name === 'downloadAsset')).toBe(false);
    expect(draft.calls.some((call) => call.name === 'signAppImage')).toBe(false);
    expect(wrongVersion.calls.some((call) => call.name === 'uploadAssets')).toBe(false);
  });

  it('fails closed on a malformed tag, an empty signature, and a mismatched manifest version', async () => {
    expect(() => versionFromTag('0.1.724')).toThrow(/must look like/);

    const empty = harness({ readSignature: () => '  \n' });
    await expect(signLinuxAppImage({ tag: TAG, repos: ['o/r'], workDir: '/work', deps: empty.deps }))
      .rejects.toThrow(/produced no signature/);
    expect(empty.calls.some((call) => call.name === 'uploadAssets')).toBe(false);

    const stale = harness({ fetchLatestJson: () => ({ ...publishedLatest(), version: '0.1.723' }) });
    await expect(signLinuxAppImage({ tag: TAG, repos: ['o/r'], workDir: '/work', deps: stale.deps }))
      .rejects.toThrow(/is version 0\.1\.723, not 0\.1\.724/);
    expect(stale.calls.some((call) => call.name === 'uploadAssets')).toBe(false);
  });

  it('fails closed when the signing key is absent from the env and the ship machine', () => {
    expect(() => resolveSigningKey({ env: { HOME: '/home/nobody' }, fileExists: () => false }))
      .toThrow(/signing key unavailable/);
    expect(resolveSigningKey({ env: { [SIGNING_KEY_ENV]: ' env-key ' }, fileExists: () => false }))
      .toBe('env-key');
    expect(resolveSigningKey({
      env: { HOME: '/home/ship' },
      fileExists: (path) => path === '/home/ship/.tauri/cortex-ide.key',
      readFile: () => 'file-key\n',
    })).toBe('file-key');
  });

  it('builds the download, signer, and upload argv the operator expects', () => {
    const invocations: Array<{ command: string; args: string[]; env?: Record<string, string | undefined> }> = [];
    const deps = createLinuxSignatureDeps({
      env: { PATH: '/usr/bin' },
      readFile: () => '{"version":"0.1.724"}',
      run: (command, args, options) => {
        invocations.push({ command, args, env: options?.env });
        return '{"isDraft":false,"assets":[{"name":"a"}]}';
      },
    });

    deps.fetchRelease({ repo: 'o/r', tag: TAG });
    deps.downloadAsset({ repo: 'o/r', tag: TAG, assetName: ASSET, destDir: '/work' });
    deps.signAppImage({ filePath: `/work/${ASSET}`, signingKey: 'operator-key' });
    deps.uploadAssets({ repo: 'o/r', tag: TAG, files: [`/work/${ASSET}.sig`, `/work/${LATEST_JSON_ASSET}`] });

    expect(invocations[0]).toMatchObject({
      command: GH_COMMAND,
      args: ['release', 'view', TAG, '--repo', 'o/r', '--json', 'isDraft,assets'],
    });
    expect(invocations[1]).toMatchObject({
      command: GH_COMMAND,
      args: ['release', 'download', TAG, '--repo', 'o/r', '--pattern', ASSET, '--dir', '/work', '--clobber'],
    });
    expect(invocations[2].command).toBe(SIGNER_COMMAND);
    expect(invocations[2].args).toEqual([...SIGNER_ARGS, `/work/${ASSET}`]);
    expect(invocations[2].env?.[SIGNING_KEY_ENV]).toBe('operator-key');
    expect(invocations[2].env?.[SIGNING_KEY_PASSWORD_ENV]).toBe('');
    expect(invocations[3]).toMatchObject({
      command: GH_COMMAND,
      args: [
        'release', 'upload', TAG,
        `/work/${ASSET}.sig`, `/work/${LATEST_JSON_ASSET}`,
        '--clobber', '--repo', 'o/r',
      ],
    });
  });
});
