import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { verifyUpdaterSignature } from './updater-signature.mjs';

const CHANNEL_PATH = 'usr/lib/o8/server/o8-build-channel.json';
const CHANNELS = ['stable', 'beta', 'preview'];

function range(bytes, offset, size, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size)
    || offset < 0 || size < 0 || offset + size > bytes.length) {
    throw new Error(`${label} exceeds AppImage bounds`);
  }
  return offset + size;
}

// Derive a lower bound from the ELF's actual file-backed segments, sections,
// and header tables. A magic string inside the runtime is not a filesystem.
function elfEnd(bytes) {
  range(bytes, 0, 16, 'ELF header');
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    || ![1, 2].includes(bytes[4]) || ![1, 2].includes(bytes[5]) || bytes[6] !== 1
    || bytes.subarray(8, 11).toString('latin1') !== 'AI\x02') {
    throw new Error('Linux channel inspection requires a type 2 ELF AppImage');
  }
  const wide = bytes[4] === 2;
  const little = bytes[5] === 1;
  const headerSize = wide ? 64 : 52;
  range(bytes, 0, headerSize, 'ELF header');
  const uint = (offset, size) => {
    range(bytes, offset, size, 'ELF field');
    if (size === 2) return little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
    if (size === 4) return little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
    const value = little ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ELF offset exceeds safe integer range');
    return Number(value);
  };
  if (uint(wide ? 52 : 40, 2) !== headerSize || uint(20, 4) !== 1) throw new Error('Invalid ELF header');
  let end = headerSize;
  for (const program of [true, false]) {
    const table = uint(program ? (wide ? 32 : 28) : (wide ? 40 : 32), wide ? 8 : 4);
    const entrySize = uint(program ? (wide ? 54 : 42) : (wide ? 58 : 46), 2);
    const count = uint(program ? (wide ? 56 : 44) : (wide ? 60 : 48), 2);
    if (count === 0 && table === 0) continue;
    const expectedSize = program ? (wide ? 56 : 32) : (wide ? 64 : 40);
    if (count === 0 || count === 0xffff || entrySize !== expectedSize || table < headerSize) {
      throw new Error('Invalid or unsupported ELF table');
    }
    end = Math.max(end, range(bytes, table, entrySize * count, 'ELF table'));
    for (let index = 0; index < count; index += 1) {
      const entry = table + index * entrySize;
      if (!program && uint(entry + 4, 4) === 8) continue; // SHT_NOBITS occupies no file bytes.
      const offset = uint(entry + (program ? (wide ? 8 : 4) : (wide ? 24 : 16)), wide ? 8 : 4);
      const size = uint(entry + (program ? (wide ? 32 : 16) : (wide ? 32 : 20)), wide ? 8 : 4);
      end = Math.max(end, range(bytes, offset, size, 'ELF payload'));
    }
  }
  return end;
}

function squashfsOffset(bytes) {
  const start = elfEnd(bytes);
  const candidates = [];
  for (let offset = bytes.indexOf('hsqs', start); offset !== -1; offset = bytes.indexOf('hsqs', offset + 4)) {
    if (offset + 96 > bytes.length) continue;
    const blockSize = bytes.readUInt32LE(offset + 12);
    const blockLog = bytes.readUInt16LE(offset + 22);
    const used = bytes.readBigUInt64LE(offset + 40);
    if (bytes.readUInt32LE(offset + 4) === 0
      || bytes.readUInt16LE(offset + 28) !== 4 || bytes.readUInt16LE(offset + 30) !== 0
      || blockLog < 12 || blockLog > 20 || blockSize !== 2 ** blockLog
      || ![1, 2, 3, 4, 5, 6].includes(bytes.readUInt16LE(offset + 20))
      || used < 96n || used > BigInt(bytes.length - offset)) continue;
    const inodeTable = bytes.readBigUInt64LE(offset + 64);
    const directoryTable = bytes.readBigUInt64LE(offset + 72);
    if (inodeTable < 96n || inodeTable >= used || directoryTable < 96n || directoryTable >= used) continue;
    candidates.push(offset);
  }
  if (candidates.length !== 1) throw new Error('AppImage must contain exactly one valid Squashfs filesystem after its ELF runtime');
  return candidates[0];
}

/** Authenticate the entire AppImage before reading its signed filesystem. Never execute its ELF runtime. */
export function readLinuxBuildChannel(root, artifactPath, signaturePath, version, expectedChannel) {
  verifyUpdaterSignature(root, artifactPath, signaturePath);
  const offset = squashfsOffset(readFileSync(artifactPath));
  const json = execFileSync('unsquashfs', ['-cat', '-o', String(offset), artifactPath, CHANNEL_PATH], {
    encoding: 'utf8', maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let identity;
  try { identity = JSON.parse(json); } catch { throw new Error('Invalid signed Linux build channel identity'); }
  if (!identity || identity.schema !== 'o8/build-channel/v1' || identity.version !== version
    || !CHANNELS.includes(identity.channel)
    || (expectedChannel !== undefined && identity.channel !== expectedChannel)) {
    throw new Error('Signed Linux build channel identity does not match this publisher or version');
  }
  return identity;
}

export function assertLinuxArtifactChannels(root, version, expected, uploadArgs) {
  if (uploadArgs.some(path => /\.(?:deb|rpm)(?:#.*)?$/i.test(path))) {
    throw new Error('Linux .deb/.rpm installers require an authenticated build channel identity; publication is not supported');
  }
  return uploadArgs.filter(path => path.endsWith('.AppImage')).map(artifactPath => {
    const signaturePath = `${artifactPath}.sig`;
    if (!uploadArgs.includes(signaturePath)) throw new Error(`Linux AppImage ${artifactPath} has no published updater signature`);
    return readLinuxBuildChannel(root, artifactPath, signaturePath, version, expected);
  });
}
