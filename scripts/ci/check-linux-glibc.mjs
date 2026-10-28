#!/usr/bin/env node
// Fail a Linux package whose shipped binaries need a newer glibc than the
// supported baseline. The deb, rpm and AppImage all carry the same /usr/bin/o8
// and sidecars, and glibc is never bundled (not even in the AppImage), so the
// highest GLIBC_x.y version reference across every ELF file is the oldest
// distro the package can start on. Built on ubuntu-latest (24.04) the shell
// needed GLIBC_2.39, which locks out Ubuntu 22.04, Debian 12 and their
// derivatives before any o8 code runs.
//
// usage: node scripts/ci/check-linux-glibc.mjs [--max 2.35] <dir|.deb|.AppImage>...
import { spawnSync } from 'node:child_process';
import { closeSync, lstatSync, mkdtempSync, openSync, readdirSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MAX_GLIBC = '2.35';

export function compareGlibcVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Highest GLIBC_x.y version reference in `objdump -p` output, or null. */
export function highestGlibcRequirement(objdumpPrivateHeaders) {
  let highest = null;
  for (const match of objdumpPrivateHeaders.matchAll(/\bGLIBC_(\d+(?:\.\d+)+)\b/g)) {
    if (!highest || compareGlibcVersions(match[1], highest) > 0) highest = match[1];
  }
  return highest;
}

export function isElfFile(filePath) {
  const header = Buffer.alloc(4);
  let fd;
  try {
    fd = openSync(filePath, 'r');
    return readSync(fd, header, 0, 4, 0) === 4 && header.readUInt32BE(0) === 0x7f454c46;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function findElfFiles(root) {
  const found = [];
  const walk = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) walk(join(path, entry));
    } else if (stat.isFile() && isElfFile(path)) {
      found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Unpack a package into a scratch directory; directories are scanned in place. */
function unpack(target, scratch) {
  const absolute = resolve(target);
  if (lstatSync(absolute).isDirectory()) return absolute;
  const destination = mkdtempSync(join(scratch, `${basename(absolute)}-`));
  if (absolute.endsWith('.deb')) {
    run('dpkg-deb', ['-x', absolute, destination]);
    return destination;
  }
  if (absolute.endsWith('.AppImage')) {
    run(absolute, ['--appimage-extract'], { cwd: destination });
    return join(destination, 'squashfs-root');
  }
  return absolute;
}

export function checkLinuxGlibc(targets, { max = DEFAULT_MAX_GLIBC, log = console.log } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'o8-glibc-check-'));
  const failures = [];
  let scanned = 0;
  try {
    for (const target of targets) {
      const root = unpack(target, scratch);
      const files = lstatSync(root).isDirectory() ? findElfFiles(root) : [root];
      if (files.length === 0) throw new Error(`no ELF files found in ${target}`);
      let packageHighest = null;
      for (const file of files) {
        const required = highestGlibcRequirement(run('objdump', ['-p', file]));
        scanned += 1;
        if (!required) continue;
        const label = `${basename(target)}:${relative(root, file) || basename(file)}`;
        if (!packageHighest || compareGlibcVersions(required, packageHighest) > 0) packageHighest = required;
        if (compareGlibcVersions(required, max) > 0) failures.push(`${label} needs GLIBC_${required}`);
      }
      log(`[glibc] ${target}: ${files.length} ELF files, highest GLIBC_${packageHighest ?? 'none'} (max ${max})`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { scanned, failures };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let max = DEFAULT_MAX_GLIBC;
  const maxIndex = args.indexOf('--max');
  if (maxIndex !== -1) {
    max = args[maxIndex + 1];
    args.splice(maxIndex, 2);
  }
  if (!max || !/^\d+\.\d+$/.test(max) || args.length === 0) {
    console.error('usage: node scripts/ci/check-linux-glibc.mjs [--max 2.35] <dir|.deb|.AppImage>...');
    process.exit(2);
  }
  try {
    const { failures } = checkLinuxGlibc(args, { max });
    if (failures.length > 0) {
      for (const failure of failures) console.error(`[glibc] FAILED ${failure} (baseline GLIBC_${max})`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`[glibc] ${error.message}`);
    process.exit(1);
  }
}
