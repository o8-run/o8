import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MACOS_RELEASE_TARGET = 'universal-apple-darwin';
export const MACOS_RELEASE_ARCHITECTURES = Object.freeze(['x86_64', 'arm64']);

const CPU_ARCH_ABI64 = 0x01000000;
const CPU_TYPE_X86 = 7;
const CPU_TYPE_ARM = 12;
const CPU_TYPE_X86_64 = CPU_ARCH_ABI64 | CPU_TYPE_X86;
const CPU_TYPE_ARM64 = CPU_ARCH_ABI64 | CPU_TYPE_ARM;
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;
const FAT_MAGIC_64 = 0xcafebabf;
const FAT_CIGAM_64 = 0xbfbafeca;
const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;

export const MACOS_REQUIRED_BINARIES = Object.freeze([
  'Contents/MacOS/o8',
  'Contents/MacOS/speech_recognizer',
  'Contents/MacOS/speech-local',
  'Contents/MacOS/o8-pi-write',
  'Contents/MacOS/o8-next',
]);

function architectureForCpuType(cpuType) {
  if (cpuType === CPU_TYPE_X86_64) return 'x86_64';
  if (cpuType === CPU_TYPE_ARM64) return 'arm64';
  throw new Error(`unsupported Mach-O CPU type 0x${cpuType.toString(16)}`);
}

function assertReadableRange(buffer, offset, bytes, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(bytes)
    || offset < 0 || bytes < 0 || offset + bytes > buffer.length) {
    throw new Error(`${label} exceeds file bounds`);
  }
}

function readUInt32(buffer, offset, littleEndian) {
  assertReadableRange(buffer, offset, 4, 'Mach-O header');
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function readUInt64(buffer, offset, littleEndian) {
  assertReadableRange(buffer, offset, 8, 'Mach-O header');
  const value = littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Mach-O slice offset exceeds safe integer range');
  return Number(value);
}

function thinCpuType(buffer, offset = 0) {
  assertReadableRange(buffer, offset, 8, 'thin Mach-O header');
  const littleMagic = buffer.readUInt32LE(offset);
  if (littleMagic === MH_MAGIC || littleMagic === MH_MAGIC_64) {
    return buffer.readUInt32LE(offset + 4);
  }
  const bigMagic = buffer.readUInt32BE(offset);
  if (bigMagic === MH_MAGIC || bigMagic === MH_MAGIC_64) {
    return buffer.readUInt32BE(offset + 4);
  }
  throw new Error('file is not a thin Mach-O binary');
}

function fatArchitectures(buffer, littleEndian, is64Bit) {
  const count = readUInt32(buffer, 4, littleEndian);
  if (count < 1 || count > 64) throw new Error(`invalid fat Mach-O architecture count ${count}`);
  const entryBytes = is64Bit ? 32 : 20;
  assertReadableRange(buffer, 8, count * entryBytes, 'fat Mach-O architecture table');
  const architectures = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = 8 + index * entryBytes;
    const declaredCpuType = readUInt32(buffer, entryOffset, littleEndian);
    const sliceOffset = is64Bit
      ? readUInt64(buffer, entryOffset + 8, littleEndian)
      : readUInt32(buffer, entryOffset + 8, littleEndian);
    const sliceBytes = is64Bit
      ? readUInt64(buffer, entryOffset + 16, littleEndian)
      : readUInt32(buffer, entryOffset + 12, littleEndian);
    assertReadableRange(buffer, sliceOffset, sliceBytes, 'fat Mach-O slice');
    if (sliceBytes < 8) throw new Error('fat Mach-O slice is too short');
    const embeddedCpuType = thinCpuType(buffer, sliceOffset);
    if (embeddedCpuType !== declaredCpuType) throw new Error('fat Mach-O slice CPU type mismatch');
    architectures.push(architectureForCpuType(declaredCpuType));
  }
  return [...new Set(architectures)];
}

export function readMachOArchitectures(path) {
  const binary = readFileSync(path);
  assertReadableRange(binary, 0, 8, 'Mach-O header');
  const magic = binary.readUInt32BE(0);
  let architectures;
  if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
    architectures = fatArchitectures(binary, false, magic === FAT_MAGIC_64);
  } else if (magic === FAT_CIGAM || magic === FAT_CIGAM_64) {
    architectures = fatArchitectures(binary, true, magic === FAT_CIGAM_64);
  } else {
    architectures = [architectureForCpuType(thinCpuType(binary))];
  }
  return MACOS_RELEASE_ARCHITECTURES.filter((architecture) => architectures.includes(architecture));
}

// Compare executable payloads across thinning/re-signing. Code signatures and
// their two load-command size fields may change; executable bytes may not.
export function macosExecutablePayloadSha256(path, architecture) {
  return executablePayloadIdentity(path, architecture).sha256;
}

// A build receipt must also survive the first signature on an unsigned slice.
// Record the original payload length to distinguish its bytes from alignment
// padding added before the signature; never discard executable content.
export function macosBuildPayloadIdentity(path, architecture, payloadBytes) {
  return executablePayloadIdentity(path, architecture, true, payloadBytes);
}

function executablePayloadIdentity(path, architecture, normalizeFirstSignature = false, expectedBytes) {
  assertMacosArchitecture(architecture);
  if (!readMachOArchitectures(path).includes(architecture)) throw new Error(`missing ${architecture} slice`);
  let bytes = readFileSync(path);
  const magic = bytes.readUInt32BE(0);
  const fat = [FAT_MAGIC, FAT_CIGAM, FAT_MAGIC_64, FAT_CIGAM_64].includes(magic);
  if (fat) {
    const little = magic === FAT_CIGAM || magic === FAT_CIGAM_64;
    const is64 = magic === FAT_MAGIC_64 || magic === FAT_CIGAM_64;
    const count = readUInt32(bytes, 4, little);
    for (let index = 0; index < count; index += 1) {
      const entry = 8 + index * (is64 ? 32 : 20);
      if (architectureForCpuType(readUInt32(bytes, entry, little)) !== architecture) continue;
      const offset = is64 ? readUInt64(bytes, entry + 8, little) : readUInt32(bytes, entry + 8, little);
      const size = is64 ? readUInt64(bytes, entry + 16, little) : readUInt32(bytes, entry + 12, little);
      bytes = bytes.subarray(offset, offset + size);
      break;
    }
  }
  bytes = Buffer.from(bytes);
  const little = bytes.readUInt32LE(0) === MH_MAGIC_64;
  if (!little && bytes.readUInt32BE(0) !== MH_MAGIC_64) throw new Error('expected 64-bit Mach-O executable');
  const count = readUInt32(bytes, 16, little);
  const commandBytes = readUInt32(bytes, 20, little);
  assertReadableRange(bytes, 32, commandBytes, 'Mach-O load commands');
  let offset = 32;
  let payloadEnd = bytes.length;
  let signatureCommand;
  for (let index = 0; index < count; index += 1) {
    const command = readUInt32(bytes, offset, little);
    const size = readUInt32(bytes, offset + 4, little);
    if (size < 8 || offset + size > 32 + commandBytes) throw new Error('invalid Mach-O load command');
    if (command === 0x1d) {
      if (signatureCommand !== undefined) throw new Error('duplicate Mach-O signature command');
      signatureCommand = offset;
      if (size !== 16) throw new Error('invalid Mach-O signature command');
      payloadEnd = readUInt32(bytes, offset + 8, little);
      const signatureBytes = readUInt32(bytes, offset + 12, little);
      assertReadableRange(bytes, payloadEnd, signatureBytes, 'Mach-O code signature');
      if (payloadEnd < 32 + commandBytes || payloadEnd + signatureBytes !== bytes.length) {
        throw new Error('Mach-O code signature must follow the executable payload');
      }
      bytes.fill(0, offset + 8, offset + 16);
    }
    if (command === 0x19 && size >= 72 && bytes.subarray(offset + 8, offset + 24).toString('ascii').replace(/\0/g, '') === '__LINKEDIT') {
      bytes.fill(0, offset + 32, offset + 40); // signature changes virtual size
      bytes.fill(0, offset + 48, offset + 56); // signature changes file size
    }
    offset += size;
  }
  if (offset !== 32 + commandBytes) throw new Error('Mach-O load-command count mismatch');
  if (normalizeFirstSignature && signatureCommand !== undefined) {
    bytes.copy(bytes, signatureCommand, signatureCommand + 16, 32 + commandBytes);
    bytes.fill(0, 32 + commandBytes - 16, 32 + commandBytes);
    const write = (value, at) => little ? bytes.writeUInt32LE(value, at) : bytes.writeUInt32BE(value, at);
    write(count - 1, 16);
    write(commandBytes - 16, 20);
  }
  if (expectedBytes !== undefined) {
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 32 + commandBytes
      || expectedBytes > payloadEnd || payloadEnd - expectedBytes > 15
      || bytes.subarray(expectedBytes, payloadEnd).some(byte => byte !== 0)) {
      throw new Error('Mach-O payload length does not match the current build');
    }
    payloadEnd = expectedBytes;
  }
  return { sha256: createHash('sha256').update(bytes.subarray(0, payloadEnd)).digest('hex'), payloadBytes: payloadEnd };
}

export function resolveMacosReleaseArtifacts(root, version) {
  const bundleDir = join(root, 'src-tauri', 'target', MACOS_RELEASE_TARGET, 'release', 'bundle');
  const macosDir = join(bundleDir, 'macos');
  return {
    target: MACOS_RELEASE_TARGET,
    bundleDir,
    app: join(macosDir, 'o8.app'),
    updaterArchive: join(macosDir, 'o8.app.tar.gz'),
    updaterSignature: join(macosDir, 'o8.app.tar.gz.sig'),
    dmg: join(bundleDir, 'dmg', `o8_${version}_universal.dmg`),
  };
}

export function assertMacosArchitecture(architecture) {
  if (!MACOS_RELEASE_ARCHITECTURES.includes(architecture)) {
    throw new Error(`unsupported macOS architecture ${JSON.stringify(architecture)}`);
  }
  return architecture;
}

export function resolveMacosCpuArtifacts(root, version, architecture) {
  assertMacosArchitecture(architecture);
  const universal = resolveMacosReleaseArtifacts(root, version);
  const bundleDir = join(universal.bundleDir, 'cpu', architecture);
  const archive = join(bundleDir, 'macos', `o8_${architecture}.app.tar.gz`);
  return {
    target: MACOS_RELEASE_TARGET,
    architecture,
    bundleDir,
    app: join(bundleDir, 'macos', 'o8.app'),
    updaterArchive: archive,
    updaterSignature: `${archive}.sig`,
    dmg: join(bundleDir, 'dmg', `o8_${version}_${architecture}.dmg`),
  };
}

export function stageMacosDmgApp(appPath, stagingPath) {
  // Preserve signed bundle modes and relative symlinks regardless of the
  // process umask; fs.cpSync can strip permission bits during staging.
  execFileSync('/usr/bin/ditto', [appPath, join(stagingPath, 'o8.app')], { stdio: 'pipe' });
}

function verifyMacApp(appPath, architecture) {
  const required = architecture ? [assertMacosArchitecture(architecture)] : MACOS_RELEASE_ARCHITECTURES;
  if (!lstatSync(appPath).isDirectory()) throw new Error('macOS app bundle must be a directory, not a link');
  const binaries = MACOS_REQUIRED_BINARIES.map((relativePath) => {
    const path = join(appPath, ...relativePath.split('/'));
    if (!existsSync(path)) throw new Error(`${relativePath} is missing from the macOS app bundle`);
    if (!lstatSync(path).isFile()) throw new Error(`${relativePath} must be a regular executable file`);
    let architectures;
    try {
      architectures = readMachOArchitectures(path);
    } catch (error) {
      throw new Error(`${relativePath} failed Mach-O inspection: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (architecture && (architectures.length !== 1 || architectures[0] !== architecture)) {
      throw new Error(`${relativePath} must contain exactly the ${architecture} Mach-O slice`);
    }
    for (const requiredArchitecture of required) {
      if (!architectures.includes(requiredArchitecture)) {
        throw new Error(`${relativePath} is missing required Mach-O architecture ${requiredArchitecture}`);
      }
    }
    return {
      relativePath,
      architectures,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    };
  });
  return {
    kind: architecture ? 'macos-cpu-app' : 'macos-universal-app',
    architectures: [...required],
    binaries,
  };
}

export function verifyUniversalMacApp(appPath) {
  return verifyMacApp(appPath);
}

export function verifyMacCpuApp(appPath, architecture) {
  assertMacosArchitecture(architecture);
  return verifyMacApp(appPath, architecture);
}

export function bundleContentSha256(appPath, excludedPaths = []) {
  const digest = createHash('sha256');
  const excluded = new Set(excludedPaths.map((path) => `o8.app/${path}`));

  function visit(path, relativePath) {
    const stat = lstatSync(path);
    const normalizedPath = relativePath.split(sep).join('/');
    if (excluded.has(normalizedPath)) return;
    const mode = (stat.mode & 0o7777).toString(8);
    if (stat.isDirectory()) {
      digest.update(`directory\0${normalizedPath}\0${mode}\0`);
      for (const name of readdirSync(path).sort()) visit(join(path, name), join(relativePath, name));
      return;
    }
    if (stat.isFile()) {
      digest.update(`file\0${normalizedPath}\0${mode}\0${stat.size}\0`);
      digest.update(readFileSync(path));
      digest.update('\0');
      return;
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      const resolvedTarget = resolve(dirname(path), target);
      const targetRelative = relative(appPath, resolvedTarget);
      if (isAbsolute(target) || targetRelative === '..' || targetRelative.startsWith(`..${sep}`)) {
        throw new Error(`${normalizedPath} has an unsafe symlink target outside o8.app`);
      }
      digest.update(`symlink\0${normalizedPath}\0${target}\0`);
      return;
    }
    throw new Error(`${normalizedPath} has an unsupported filesystem entry type`);
  }

  visit(appPath, 'o8.app');
  return digest.digest('hex');
}

// Only the required native slices and the outer signature/notarization metadata
// may differ. All runtime resources, modes and internal links stay identical.
export function macosSharedResourcesSha256(appPath) {
  return bundleContentSha256(appPath, [
    ...MACOS_REQUIRED_BINARIES,
    'Contents/_CodeSignature',
    'Contents/CodeResources',
  ]);
}

function validateUpdaterArchiveMembers(archivePath) {
  const listing = execFileSync('tar', ['tzf', archivePath], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const members = listing.split('\n').filter(Boolean);
  if (members.length === 0) throw new Error('updater archive is empty');
  for (const member of members) {
    const normalized = member.replace(/\/+$/, '');
    const parts = normalized.split('/');
    if (isAbsolute(member) || parts.includes('..') || parts.includes('.') || parts[0] !== 'o8.app') {
      throw new Error(`updater archive contains unsafe member ${JSON.stringify(member)}`);
    }
  }
}

function verifyMacUpdaterArchive(appPath, archivePath, verifyApp) {
  if (!existsSync(archivePath)) throw new Error('macOS updater archive is missing');
  verifyApp(appPath);
  // Validate links in the loose app before running an archive extractor.
  const bundleSha256 = bundleContentSha256(appPath);
  validateUpdaterArchiveMembers(archivePath);
  const extractionRoot = mkdtempSync(join(tmpdir(), 'o8-updater-inspection-'));
  try {
    // Preserve archived modes so the caller's umask cannot change bundle identity.
    execFileSync('tar', ['xzpf', archivePath, '-C', extractionRoot], { stdio: 'pipe' });
    const entries = readdirSync(extractionRoot).sort();
    if (entries.length !== 1 || entries[0] !== 'o8.app') {
      throw new Error('updater archive must contain exactly one top-level o8.app bundle');
    }
    const archivedApp = join(extractionRoot, 'o8.app');
    let archivedIdentity;
    try {
      archivedIdentity = verifyApp(archivedApp);
    } catch (error) {
      throw new Error(`archived ${error instanceof Error ? error.message : String(error)}`);
    }
    const archivedBundleSha256 = bundleContentSha256(archivedApp);
    if (archivedBundleSha256 !== bundleSha256) {
      throw new Error('updater archive contents do not match the inspected macOS app bundle');
    }
    return {
      ...archivedIdentity,
      bundleSha256,
      updaterArchiveSha256: createHash('sha256').update(readFileSync(archivePath)).digest('hex'),
    };
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

export function verifyUniversalMacUpdaterArchive(appPath, archivePath) {
  return verifyMacUpdaterArchive(appPath, archivePath, verifyUniversalMacApp);
}

export function verifyMacCpuUpdaterArchive(appPath, archivePath, architecture) {
  assertMacosArchitecture(architecture);
  return verifyMacUpdaterArchive(appPath, archivePath, (app) => verifyMacCpuApp(app, architecture));
}

export function verifyMacosDmgMatchesApp(appPath, dmgPath, version, architecture) {
  if (architecture !== undefined) assertMacosArchitecture(architecture);
  const verifyApp = architecture === undefined
    ? verifyUniversalMacApp : (app) => verifyMacCpuApp(app, architecture);
  execFileSync('/usr/bin/hdiutil', ['verify', dmgPath], { stdio: 'pipe' });
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', dmgPath], { stdio: 'pipe' });

  const inspectionRoot = mkdtempSync(join(tmpdir(), 'o8-dmg-inspection-'));
  const mountPath = join(inspectionRoot, 'mount');
  mkdirSync(mountPath);
  let mounted = false;
  let detachTarget = mountPath;
  let identity;
  let verificationError;
  try {
    const attached = execFileSync('/usr/bin/hdiutil', [
      'attach',
      '-plist',
      '-readonly',
      '-nobrowse',
      '-mountpoint', mountPath,
      dmgPath,
    ], { stdio: 'pipe' });
    mounted = true;
    const attachment = JSON.parse(execFileSync('/usr/bin/plutil', [
      '-convert', 'json', '-o', '-', '--', '-',
    ], { input: attached, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
    const device = attachment['system-entities']?.find((entity) => (
      typeof entity['dev-entry'] === 'string' && /^\/dev\/disk\d+$/.test(entity['dev-entry'])
    ))?.['dev-entry'];
    if (!device) throw new Error('DMG attachment did not identify its backing device');
    // A failed detach can already have unmounted the volume. Its mount path
    // then stops identifying the image, but the owned backing device survives.
    detachTarget = device;
    const dmgApp = join(mountPath, 'o8.app');
    if (!existsSync(dmgApp)) throw new Error('DMG is missing its top-level o8.app bundle');
    execFileSync('/usr/bin/codesign', [
      '--verify',
      '--deep',
      '--strict',
      dmgApp,
    ], { stdio: 'pipe' });
    let dmgAppIdentity;
    try {
      dmgAppIdentity = verifyApp(dmgApp);
    } catch (error) {
      throw new Error(`DMG ${error instanceof Error ? error.message : String(error)}`);
    }
    const bundleVersion = execFileSync('/usr/bin/plutil', [
      '-extract',
      'CFBundleShortVersionString',
      'raw',
      '-o', '-',
      join(dmgApp, 'Contents', 'Info.plist'),
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (bundleVersion !== version) {
      throw new Error(`DMG app version ${JSON.stringify(bundleVersion)} does not match release version ${JSON.stringify(version)}`);
    }
    const bundleSha256 = bundleContentSha256(appPath);
    const dmgBundleSha256 = bundleContentSha256(dmgApp);
    if (dmgBundleSha256 !== bundleSha256) {
      throw new Error('DMG app contents do not match the inspected macOS app bundle');
    }
    identity = {
      ...dmgAppIdentity,
      bundleVersion,
      bundleSha256,
      dmgSha256: createHash('sha256').update(readFileSync(dmgPath)).digest('hex'),
    };
  } catch (error) {
    verificationError = error;
  }

  let cleanupError;
  if (mounted) {
    try {
      execFileSync('/usr/bin/hdiutil', ['detach', detachTarget], { stdio: 'pipe' });
    } catch {
      try {
        execFileSync('/usr/bin/hdiutil', ['detach', detachTarget, '-force'], { stdio: 'pipe' });
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (!cleanupError) rmSync(inspectionRoot, { recursive: true, force: true });
  if (verificationError) {
    if (cleanupError) {
      throw new Error(
        `${verificationError instanceof Error ? verificationError.message : String(verificationError)}; DMG cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw verificationError;
  }
  if (cleanupError) {
    throw new Error(`DMG verification passed but cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
  }
  return identity;
}
