'use strict';
// One fixed native creation operation in a pinned parent. Return its receipt,
// rather than making the calling compiler discover custody from a later scan.
const fs = require('node:fs');
const path = require('node:path');
process.on('uncaughtException', error => {
  fs.writeSync(1, JSON.stringify({ error: { message: error.message, code: error.code } }));
  process.exitCode = 1;
});
const input = JSON.parse(process.argv[2]);
const parent = fs.lstatSync('.');
if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== input.parent.device
  || parent.ino !== input.parent.inode || fs.realpathSync('.') !== input.parentPath
  || path.basename(input.name) !== input.name || input.name === '.' || input.name === '..') {
  throw new Error('Build entry creation parent changed; preserve output.');
}
let descriptor;
if (input.kind === 'directory') {
  fs.mkdirSync(input.name, { mode: input.mode });
  descriptor = fs.openSync(input.name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
} else if (input.kind === 'symlink') {
  fs.symlinkSync(input.target, input.name, input.type);
  // Linux O_PATH and the native link-open flag let the creator hold the link
  // itself; opening its target would not prove ownership of this entry.
  const flags = process.platform === 'linux' ? 0x200000 | fs.constants.O_NOFOLLOW : fs.constants.O_SYMLINK;
  if (flags === undefined) throw new Error('Native link custody is unsupported; preserve output.');
  descriptor = fs.openSync(input.name, flags);
} else throw new Error('Unsupported build entry creation.');
try {
  const stat = fs.fstatSync(descriptor); const actual = fs.lstatSync(input.name);
  if (stat.dev !== actual.dev || stat.ino !== actual.ino
    || (input.kind === 'directory' ? !stat.isDirectory() : !stat.isSymbolicLink() || fs.readlinkSync(input.name) !== input.target)) {
    throw new Error('Build entry changed before its creation receipt; preserve output.');
  }
  process.stdout.write(JSON.stringify({ device: stat.dev, inode: stat.ino, kind: input.kind,
    mode: stat.mode, linkCount: stat.nlink, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    ...(input.kind === 'symlink' ? { symlinkTarget: input.target } : {}) }));
} finally { fs.closeSync(descriptor); }
