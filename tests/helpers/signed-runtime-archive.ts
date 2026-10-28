import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageRuntimeInputs } from './packaged-runtime-inputs';

// Sign synthetic fixture bytes only. No product signing key or tool is used.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const keyId = Buffer.alloc(8, 1);
const wrap = (packet: Buffer) => Buffer.from(`untrusted comment: fixture\n${packet.toString('base64')}\n`).toString('base64');
export const runtimeFixtureUpdaterKey = wrap(Buffer.concat([Buffer.from('Ed'), keyId,
  publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)]));

export function copyRuntimeArchive(source: string, archive: string, signature: string, missingRuntime?: string) {
  const root = mkdtempSync(join(tmpdir(), 'o8-runtime-archive-'));
  try {
    execFileSync('tar', ['xzf', source, '-C', root]);
    const server = join(root, 'o8.app/Contents/Resources/server');
    stageRuntimeInputs(server);
    if (missingRuntime) rmSync(join(server, missingRuntime), { recursive: true });
    execFileSync('tar', ['czf', archive, '-C', root, 'o8.app']);
    writeFileSync(signature, wrap(Buffer.concat([Buffer.from('Ed'), keyId,
      sign(null, readFileSync(archive), privateKey)])));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
