import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifyEd25519,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function decodeStandardPacket(encodedFile, label) {
  const standard = Buffer.from(encodedFile.trim(), 'base64').toString('utf8');
  const encodedPacket = standard.trim().split('\n')[1];
  if (!encodedPacket) throw new Error(`${label} has no minisign packet`);
  return Buffer.from(encodedPacket, 'base64');
}

export function loadUpdaterPublicKey(root) {
  const config = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const wrapped = config?.plugins?.updater?.pubkey;
  if (typeof wrapped !== 'string' || wrapped.trim() === '') {
    throw new Error('src-tauri/tauri.conf.json has no configured updater public key');
  }
  const packet = decodeStandardPacket(wrapped, 'configured updater public key');
  if (packet.length !== 42) throw new Error('configured updater public key packet has an invalid length');
  return {
    keyId: packet.subarray(2, 10),
    publicKey: packet.subarray(10, 42),
  };
}

export function verifyUpdaterSignature(root, artifactPath, signaturePath) {
  let verified = false;
  let algorithm;
  try {
    const configured = loadUpdaterPublicKey(root);
    const signaturePacket = decodeStandardPacket(
      readFileSync(signaturePath, 'utf8'),
      'updater signature',
    );
    if (signaturePacket.length < 74) throw new Error('updater signature packet has an invalid length');
    algorithm = signaturePacket.subarray(0, 2).toString('latin1');
    if (algorithm !== 'ED' && algorithm !== 'Ed') {
      throw new Error(`updater signature uses unsupported algorithm ${JSON.stringify(algorithm)}`);
    }
    const signatureKeyId = signaturePacket.subarray(2, 10);
    if (!timingSafeEqual(configured.keyId, signatureKeyId)) {
      throw new Error('updater signature key id does not match the configured updater public key');
    }
    const keyDer = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      configured.publicKey,
    ]);
    const key = createPublicKey({ key: keyDer, format: 'der', type: 'spki' });
    const artifact = readFileSync(artifactPath);
    const message = algorithm === 'ED'
      ? createHash('blake2b512').update(artifact).digest()
      : artifact;
    verified = verifyEd25519(null, message, key, signaturePacket.subarray(10, 74));
    const fields = Buffer.from(readFileSync(signaturePath, 'utf8').trim(), 'base64').toString('utf8').replace(/\n$/, '').split('\n');
    if (fields.length !== 4 || !fields[2].startsWith('trusted comment: ')
      || !/^[A-Za-z0-9+/]{86}==$/.test(fields[3])) throw new Error('Invalid minisign global signature or trusted comment');
    const globalSignature = Buffer.from(fields[3], 'base64');
    if (globalSignature.length !== 64 || globalSignature.toString('base64') !== fields[3]) throw new Error('Invalid minisign global signature encoding');
    // Minisign src/minisign.c verify(): signature bytes || trusted comment,
    // excluding the packet header, comment prefix, and terminating newline.
    // https://github.com/jedisct1/minisign/blob/b6de4fe31b4c519887cef8b080eb1816b18795ae/src/minisign.c#L507-L513
    const commentMessage = Buffer.concat([signaturePacket.subarray(10, 74), Buffer.from(fields[2].slice('trusted comment: '.length))]);
    if (!verifyEd25519(null, commentMessage, key, globalSignature)) throw new Error('Minisign global signature does not authenticate the trusted comment');
  } catch (error) {
    throw new Error(
      `updater signature does not verify against the configured public key: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!verified) {
    throw new Error('updater signature does not verify against the configured public key');
  }
  return {
    algorithm,
    artifactSha256: createHash('sha256').update(readFileSync(artifactPath)).digest('hex'),
    signatureSha256: createHash('sha256').update(readFileSync(signaturePath)).digest('hex'),
  };
}
