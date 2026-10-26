import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { macosBuildPayloadIdentity, readMachOArchitectures } from '../lib/macos-release-artifacts.mjs';

export const NEXT_BUILD_RECEIPT = 'o8-next-build.json';

export function nextBuildIdentity(binary, commit) {
  const payloads = readMachOArchitectures(binary).map(architecture => [architecture, macosBuildPayloadIdentity(binary, architecture)]);
  return {
    schema: 'o8/next-build/v1',
    commit,
    payloadSha256: Object.fromEntries(payloads.map(([architecture, payload]) => [architecture, payload.sha256])),
    payloadBytes: Object.fromEntries(payloads.map(([architecture, payload]) => [architecture, payload.payloadBytes])),
  };
}

export function nextBuildCommit(root) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('o8 next current build commit is unavailable');
  return commit;
}

export function verifyNextBuildIdentity(app, architectures, root = process.cwd()) {
  const readReceipt = path => {
    try {
      if (!lstatSync(path).isFile()) throw new Error('not a regular file');
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      if (receipt.schema !== 'o8/next-build/v1') throw new Error('invalid schema');
      return receipt;
    } catch { throw new Error('o8 next receipt is missing or invalid for the current build'); }
  };
  const expected = readReceipt(join(root, 'src-tauri/helpers', NEXT_BUILD_RECEIPT));
  const packaged = readReceipt(join(app, 'Contents/Resources', NEXT_BUILD_RECEIPT));
  const commit = nextBuildCommit(root);
  if (expected.commit !== commit || packaged.commit !== commit) {
    throw new Error('o8 next sidecar commit does not match the current build');
  }
  for (const architecture of architectures) {
    const hash = expected.payloadSha256?.[architecture];
    const length = expected.payloadBytes?.[architecture];
    if (!/^[a-f0-9]{64}$/.test(hash ?? '') || packaged.payloadSha256?.[architecture] !== hash
      || !Number.isSafeInteger(length) || packaged.payloadBytes?.[architecture] !== length
      || macosBuildPayloadIdentity(join(app, 'Contents/MacOS/o8-next'), architecture, length).sha256 !== hash) {
      throw new Error('o8 next sidecar content hash does not match the current build');
    }
  }
  return { commit, payloadSha256: expected.payloadSha256 };
}
