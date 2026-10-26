import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, type Stats } from 'node:fs';
import path from 'node:path';

function directories(file: string): string[] {
  const result: string[] = [];
  for (let current = path.dirname(file); ; current = path.dirname(current)) {
    result.unshift(current);
    if (path.dirname(current) === current) return result;
  }
}

function directoryIdentity(directory: string): Stats {
  const entry = lstatSync(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Redirected CLI directory.');
  return entry;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid;
}

/** Create one component at a time: recursive mkdir would follow an existing alias. */
export function ensureWorkerCliDirectory(directory: string): void {
  const observed = new Map<string, Stats>();
  for (const current of [...directories(directory), directory]) {
    try { directoryIdentity(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { mkdirSync(current, { mode: 0o700 }); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
    }
    observed.set(current, directoryIdentity(current));
  }
  for (const [current, expected] of observed) {
    if (!sameIdentity(expected, directoryIdentity(current))) throw new Error('CLI directory changed.');
  }
}

function readRegularFile(file: string): { identity: Stats; sha256: string } {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (process.getuid && before.uid !== process.getuid())) {
      throw new Error('CLI file is not a private regular file.');
    }
    const sha256 = createHash('sha256').update(readFileSync(fd)).digest('hex');
    for (const after of [fstatSync(fd), lstatSync(file)]) {
      if (after.isSymbolicLink() || after.nlink !== 1 || !sameIdentity(before, after)
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error('CLI file changed while reading.');
      }
    }
    return { identity: before, sha256 };
  } finally { closeSync(fd); }
}

/** Retain authority in memory, never in the on-disk verification receipt. */
export function pinWorkerCliFiles(files: string[]): { assertCurrent(): void; sha256: string[]; ancestorPaths: string[] } {
  const ancestors = new Map(files.flatMap(file => directories(file)).map(directory => [directory, directoryIdentity(directory)]));
  const pinned = files.map(file => ({ file, ...readRegularFile(file) }));
  const checkAncestors = () => {
    for (const [directory, expected] of ancestors) {
      if (!sameIdentity(expected, directoryIdentity(directory))) throw new Error('CLI ancestor changed.');
    }
  };
  const assertCurrent = () => {
    checkAncestors();
    for (const expected of pinned) {
      const actual = readRegularFile(expected.file);
      if (!sameIdentity(expected.identity, actual.identity) || expected.sha256 !== actual.sha256) {
        throw new Error('Verified CLI bytes or identity changed.');
      }
    }
    checkAncestors();
  };
  assertCurrent();
  return { assertCurrent, sha256: pinned.map(file => file.sha256), ancestorPaths: [...ancestors.keys()] };
}
