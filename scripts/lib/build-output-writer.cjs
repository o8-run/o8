'use strict';

// This preload is deliberately a writer, not an observer. Only descriptors
// created exclusively (or reopened against an earlier receipt) grant custody.
const fs = require('node:fs');
const raw = { ...fs };
const rawPromises = { ...fs.promises };
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const rawSpawn = childProcess.spawn;
const rawFork = childProcess.fork;
const rawExecFileSync = childProcess.execFileSync;
const rawSpawnSync = childProcess.spawnSync;
const { fileURLToPath } = require('node:url');
const ENV = 'O8_BUILD_WRITE_RECEIPT';

function birth(pid) {
  if (process.platform === 'linux') {
    const stat = raw.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
    return { version: 1, platform: 'linux', bootId: raw.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), startId: fields[19] };
  }
  if (process.platform === 'darwin') {
    const options = { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' } };
    return { version: 1, platform: 'darwin',
      bootId: rawExecFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], options).trim(),
      startId: rawExecFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], options).trim().replace(/\s+/g, ' ') };
  }
  throw new Error('Build writer receipts require a supported native process identity.');
}
const writerKey = (pid, identity) => JSON.stringify([pid, identity.platform, identity.bootId, identity.startId]);
const kind = stat => stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'other';
function receipt(relative, stat) {
  return { relative, device: stat.dev, inode: stat.ino, kind: kind(stat), mode: stat.mode,
    linkCount: stat.nlink, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
function matches(actual, expected) {
  return expected && actual.device === expected.device && actual.inode === expected.inode
    && actual.kind === expected.kind && actual.mode === expected.mode
    && (actual.kind === 'directory' || actual.linkCount === expected.linkCount && actual.size === expected.size
      && actual.mtimeMs === expected.mtimeMs && actual.ctimeMs === expected.ctimeMs);
}
function refuse(name) { throw new Error(`Preserved unowned or changed build output: ${name}; writer ownership proof is missing.`); }
function writing(flags) {
  return typeof flags === 'number'
    ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
    : /[wa+]/.test(flags);
}

let captureExecutable;
function captureNoReplace(source, destination, parent, holder) {
  if (!captureExecutable) {
    const directory = raw.mkdtempSync(path.join(require('node:os').tmpdir(), 'o8-build-capture-'));
    const executable = path.join(directory, 'capture');
    const compiled = rawSpawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror',
      path.join(__dirname, 'build-output-capture.c'), '-o', executable], {
      env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' }, encoding: 'utf8', timeout: 30_000,
    });
    if (compiled.status !== 0) throw new Error('Build output capture requires the native C toolchain; preserve output.');
    captureExecutable = executable;
  }
  const result = rawSpawnSync(captureExecutable, [source, destination, String(parent.dev), String(parent.ino),
    String(holder.dev), String(holder.ino)], { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) {
    const error = new Error(result.stderr?.trim() || 'Build output capture failed; preserve output.');
    error.code = result.status === 73 ? 'EEXIST' : 'EIO';
    throw error;
  }
}

// Unlinking a shared pathname after lstat can delete a new writer's inode.
// First atomically capture that name in a private directory. Only the captured
// entry can be removed, after comparison with the original writer receipt.
function removeCapturedEntry(file, expected, validateParents) {
  const parent = path.dirname(file);
  validateParents();
  const parentStat = raw.lstatSync(parent);
  const linkFlags = process.platform === 'linux' ? 0x200000 | fs.constants.O_NOFOLLOW : fs.constants.O_SYMLINK;
  const flags = expected.kind === 'symlink' ? linkFlags : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    | fs.constants.O_NONBLOCK | (expected.kind === 'directory' ? fs.constants.O_DIRECTORY : 0);
  if (flags === undefined || expected.kind === 'other') refuse(expected.relative);
  const originalFd = raw.openSync(file, flags);
  if (!matches(receipt(expected.relative, raw.fstatSync(originalFd)), expected)) {
    raw.closeSync(originalFd); refuse(expected.relative);
  }
  const directory = raw.mkdtempSync(path.join(parent, '.o8-remove-'));
  const held = path.join(directory, 'entry');
  const directoryFd = raw.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const privateIdentity = raw.fstatSync(directoryFd);
  let captured = false;
  function verifyPrivate() {
    validateParents();
    const currentParent = raw.lstatSync(parent);
    const named = raw.lstatSync(directory);
    if (currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino
      || !named.isDirectory() || named.isSymbolicLink() || (named.mode & 0o777) !== 0o700
      || named.dev !== privateIdentity.dev || named.ino !== privateIdentity.ino
      || raw.realpathSync(directory) !== directory) refuse(expected.relative);
  }
  try {
    verifyPrivate();
    captureNoReplace(file, held, parentStat, privateIdentity);
    captured = true;
    verifyPrivate();
    const stat = raw.lstatSync(held);
    // rename changes ctime. It cannot change the captured inode, kind, bytes,
    // permissions, mtime or link count into the earlier writer's receipt.
    const moved = receipt(expected.relative, stat);
    if (!matches({ ...moved, ctimeMs: expected.ctimeMs }, expected)) {
      // link is exclusive: a new occupant at the original name is never
      // overwritten. Keep the captured inode as well, even if restoration wins.
      if (stat.isFile() || stat.isSymbolicLink()) {
        try { raw.linkSync(held, file); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      throw new Error(`Preserved changed build output: ${expected.relative}; ownership changed during removal. Captured entry kept at ${path.join(path.dirname(expected.relative), path.basename(directory), 'entry')}.`);
    }
    verifyPrivate();
    const pinned = receipt(expected.relative, raw.fstatSync(originalFd));
    if (!matches(pinned, moved) || !matches(receipt(expected.relative, raw.lstatSync(held)), pinned)) refuse(expected.relative);
    // The unlink now addresses our private captured name, never the compiler's
    // shared filename. A replacement at the original filename remains intact.
    if (expected.kind === 'directory') raw.rmdirSync(held);
    else raw.unlinkSync(held);
    captured = false;
  } finally {
    raw.closeSync(directoryFd);
    raw.closeSync(originalFd);
    if (!captured) { verifyPrivate(); if (!raw.readdirSync(directory).length) raw.rmdirSync(directory); }
  }
  if (raw.lstatSync(file, { throwIfNoEntry: false })) refuse(expected.relative);
}

function createEntry(file, parent, options) {
  const parentPath = path.dirname(file);
  const result = rawSpawnSync(process.execPath, [path.join(__dirname, 'build-output-entry-create.cjs'),
    JSON.stringify({ ...options, parent, parentPath, name: path.basename(file) })], {
    cwd: parentPath, env: { PATH: process.env.PATH, NODE_ENV: 'production' }, encoding: 'utf8', timeout: 30_000,
  });
  if (result.status !== 0) {
    let failure; try { failure = JSON.parse(result.stdout).error; } catch { /* A spawn failure has no helper receipt. */ }
    const error = new Error(failure?.message || result.stderr?.trim() || 'Build entry creation failed; preserve output.');
    error.code = failure?.code || result.error?.code;
    throw error;
  }
  const created = JSON.parse(result.stdout);
  if (!matches(receipt('.', raw.lstatSync(file)), { ...created, relative: '.' })) refuse(path.basename(file));
  return created;
}

/** Exclusive destination creation never overwrites a name that appeared during
 * a move. Every source deletion still checks its original receipt immediately. */
function transferOwnedEntry(source, destination, inventory, sourceParent, destinationParent) {
  const original = new Map(inventory.map(entry => [entry.relative, entry]));
  const output = new Map();
  function parentIdentity(file, expected) {
    const stat = raw.lstatSync(file);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expected.device || stat.ino !== expected.inode
      || raw.realpathSync(file) !== file) refuse('move parent');
  }
  function sourceEntry(relative) {
    const file = relative === '.' ? source : path.join(source, relative);
    const expected = original.get(relative);
    if (!matches(receipt(relative, raw.lstatSync(file)), expected)) refuse(relative);
    return expected;
  }
  function parents(relative) {
    const parent = path.dirname(relative);
    parentIdentity(path.dirname(source), sourceParent);
    parentIdentity(path.dirname(destination), destinationParent);
    if (relative !== '.') {
      sourceEntry('.'); parentIdentity(destination, output.get('.'));
      if (parent !== '.') {
        let directory = '';
        for (const part of parent.split(path.sep)) {
          directory = directory ? path.join(directory, part) : part;
          sourceEntry(directory); parentIdentity(path.join(destination, directory), output.get(directory));
        }
      }
    }
  }
  function move(relative) {
    parents(relative);
    const expected = sourceEntry(relative);
    const from = relative === '.' ? source : path.join(source, relative);
    const to = relative === '.' ? destination : path.join(destination, relative);
    if (expected.kind === 'directory') {
      const parent = relative === '.' ? destinationParent : output.get(path.dirname(relative));
      output.set(relative, { relative, ...createEntry(to, parent, { kind: 'directory', mode: expected.mode & 0o777 }) });
      for (const name of raw.readdirSync(from)) move(relative === '.' ? name : path.join(relative, name));
      parents(relative); sourceEntry(relative);
      removeCapturedEntry(from, expected, () => parents(relative));
      return;
    }
    if (expected.kind !== 'file' && expected.kind !== 'symlink') refuse(relative);
    if (expected.kind === 'symlink') {
      if (typeof expected.symlinkTarget !== 'string') refuse(relative);
      const parent = relative === '.' ? destinationParent : output.get(path.dirname(relative));
      const created = createEntry(to, parent, { kind: 'symlink', target: expected.symlinkTarget });
      parents(relative); sourceEntry(relative);
      removeCapturedEntry(from, expected, () => parents(relative));
      output.set(relative, { relative, ...created });
      return;
    }
    let descriptor;
    try {
      if (expected.kind === 'file') {
        descriptor = raw.openSync(from, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        if (!matches(receipt(relative, raw.fstatSync(descriptor)), expected)) refuse(relative);
      }
      // link is exclusive for regular files. A new destination
      // between an occupancy check and this syscall survives as EEXIST.
      raw.linkSync(from, to);
      const linked = receipt(relative, descriptor === undefined ? raw.lstatSync(to) : raw.fstatSync(descriptor));
      if (linked.device !== expected.device || linked.inode !== expected.inode || linked.kind !== expected.kind
        || linked.linkCount !== expected.linkCount + 1 || linked.size !== expected.size || linked.mtimeMs !== expected.mtimeMs
        || !matches(receipt(relative, raw.lstatSync(to)), linked)) refuse(relative);
      parents(relative);
      if (!matches(receipt(relative, raw.lstatSync(from)), linked)) refuse(relative);
      removeCapturedEntry(from, linked, () => parents(relative));
      const moved = receipt(relative, descriptor === undefined ? raw.lstatSync(to) : raw.fstatSync(descriptor));
      if (moved.device !== expected.device || moved.inode !== expected.inode || moved.linkCount !== expected.linkCount
        || moved.size !== expected.size || moved.mtimeMs !== expected.mtimeMs
        || !matches(receipt(relative, raw.lstatSync(to)), moved)) refuse(relative);
      if (expected.kind === 'symlink') moved.symlinkTarget = expected.symlinkTarget;
      output.set(relative, moved);
    } finally { if (descriptor !== undefined) raw.closeSync(descriptor); }
  }
  move('.');
  return [...output.values()];
}

function connect(config, initialRoot) {
  const fd = raw.openSync(config.journal, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
  const journal = raw.fstatSync(fd);
  if (!journal.isFile() || journal.dev !== config.device || journal.ino !== config.inode || journal.nlink !== 1) {
    raw.closeSync(fd); throw new Error('Build writer journal identity changed; preserve output.');
  }
  const ownIdentity = birth(process.pid);
  const ownKey = writerKey(process.pid, ownIdentity);
  const entries = new Map(); const grants = new Set(); const grantors = new Map();
  const closedWriters = new Set(); const pending = [];
  let offset = 0; let partial = ''; let closed = false;
  function apply(event) {
    if (event.kind === 'grant') {
      if (!grants.has(event.author)) { pending.push(event); return; }
      const key = writerKey(event.pid, event.identity);
      grants.add(key); grantors.set(key, event.author);
    } else if (event.kind === 'seed') {
      if (event.secret !== config.seed) throw new Error('Invalid build writer seed receipt.');
      grants.add(event.writer);
      for (const entry of event.entries) entries.set(entry.relative, entry);
    } else {
      if (!grants.has(event.author)) { pending.push(event); return; }
      if (event.kind === 'put') entries.set(event.entry.relative, event.entry);
      else if (event.kind === 'drop') entries.delete(event.relative);
      else if (event.kind === 'closed') {
        const key = writerKey(event.pid, event.identity);
        if (grantors.get(key) !== event.author) throw new Error('Build writer close lacks original parent authority.');
        closedWriters.add(key);
      }
      else throw new Error('Invalid build writer operation receipt.');
    }
  }
  function refresh() {
    if (closed) throw new Error('Build writer journal is closed.');
    const size = raw.fstatSync(fd).size;
    if (size < offset || size > 256 * 1024 ** 2) throw new Error('Build writer journal changed or exceeded its bound.');
    if (size === offset) return;
    const buffer = Buffer.alloc(size - offset);
    let count = 0;
    while (count < buffer.length) count += raw.readSync(fd, buffer, count, buffer.length - count, offset + count);
    offset = size;
    const lines = (partial + buffer.toString('utf8')).split('\n'); partial = lines.pop();
    for (const line of lines) {
      const [signature, payload] = JSON.parse(line);
      if (crypto.createHmac('sha256', config.key).update(payload).digest('hex') !== signature) {
        throw new Error('Build writer journal authentication failed; preserve output.');
      }
      apply(JSON.parse(payload));
    }
    // Parent admission may arrive after the child's first receipt. Resolve the
    // authenticated graph only from its original, native-birth-bound root.
    let progress = true;
    while (progress && pending.length) {
      progress = false;
      for (let index = 0; index < pending.length;) {
        if (!grants.has(pending[index].author)) { index++; continue; }
        const [event] = pending.splice(index, 1); apply(event); progress = true;
      }
    }
  }
  function append(event) {
    const payload = JSON.stringify(event);
    const line = JSON.stringify([crypto.createHmac('sha256', config.key).update(payload).digest('hex'), payload]) + '\n';
    if (Buffer.byteLength(line) > 64 * 1024) throw new Error('Build writer receipt exceeded its bound.');
    raw.writeSync(fd, line); refresh();
  }
  function putReceipt(entry) { append({ kind: 'put', author: ownKey, entry }); }
  function put(relative, stat) { putReceipt(receipt(relative, stat)); }
  function drop(relative) { append({ kind: 'drop', author: ownKey, relative }); }
  function relative(file) {
    if (typeof file === 'number') return null;
    const value = path.resolve(file instanceof URL ? fileURLToPath(file) : String(file));
    if (value === config.scope) return '.';
    return value.startsWith(config.scope + path.sep) ? path.relative(config.scope, value).split(path.sep).join('/') : null;
  }
  function absolute(name) { return name === '.' ? config.scope : path.join(config.scope, name); }
  function admitted() {
    refresh();
    // A worker can load its preload before its parent has finished the native
    // birth probe. It must wait for that grant, never mint one for itself.
    const deadline = Date.now() + 10_000;
    while (!grants.has(ownKey) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); refresh();
    }
    if (!grants.has(ownKey)) refuse('unadmitted compiler process');
  }
  function check(name, stat = raw.lstatSync(absolute(name))) {
    admitted(); const actual = receipt(name, stat);
    if (!matches(actual, entries.get(name))) refuse(name);
    return actual;
  }
  function waitForDirectoryReceipt(name) {
    const deadline = Date.now() + 3000;
    refresh();
    while (!entries.has(name) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); refresh();
    }
    if (check(name).kind !== 'directory') refuse(name);
  }
  function parents(name) {
    const parts = name === '.' ? [] : name.split('/');
    check('.');
    let parent = '';
    for (const part of parts.slice(0, -1)) {
      parent = parent ? parent + '/' + part : part;
      if (check(parent).kind !== 'directory') refuse(parent);
    }
  }
  const handles = new Map();
  function openSync(file, flags, mode) {
    const name = relative(file);
    if (name === null || !writing(flags)) return raw.openSync(file, flags, mode);
    parents(name); admitted();
    let descriptor;
    const existing = raw.lstatSync(file, { throwIfNoEntry: false });
    const exclusive = typeof flags === 'number' ? Boolean(flags & fs.constants.O_EXCL) : flags.includes('x');
    if (existing && exclusive && (typeof flags === 'string' || flags & fs.constants.O_CREAT)) return raw.openSync(file, flags, mode);
    if (existing) {
      check(name, existing);
      if (!existing.isFile()) refuse(name);
      // Never truncate by pathname. Validate the captured descriptor first.
      descriptor = raw.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW
        | ((typeof flags === 'string' && flags.startsWith('a') || typeof flags === 'number' && flags & fs.constants.O_APPEND) ? fs.constants.O_APPEND : 0));
      try {
        check(name, raw.fstatSync(descriptor));
        if (typeof flags === 'string' ? flags.startsWith('w') : flags & fs.constants.O_TRUNC) raw.ftruncateSync(descriptor, 0);
      } catch (error) { raw.closeSync(descriptor); throw error; }
    } else {
      // r/r+ must retain the native missing-file behavior.
      if (typeof flags === 'string' ? flags.startsWith('r') : !(flags & fs.constants.O_CREAT)) return raw.openSync(file, flags, mode);
      descriptor = raw.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW
        | ((typeof flags === 'string' && flags.startsWith('a') || typeof flags === 'number' && flags & fs.constants.O_APPEND) ? fs.constants.O_APPEND : 0), mode);
    }
    const stat = raw.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) { raw.closeSync(descriptor); refuse(name); }
    handles.set(descriptor, name); put(name, stat); return descriptor;
  }
  function mutateFd(descriptor, operation) {
    const name = handles.get(descriptor);
    if (name !== undefined) check(name, raw.fstatSync(descriptor));
    const result = operation();
    if (name !== undefined) put(name, raw.fstatSync(descriptor));
    return result;
  }
  function writeFileSync(file, data, options) {
    if (typeof file === 'number') return mutateFd(file, () => raw.writeFileSync(file, data, options));
    if (relative(file) === null) return raw.writeFileSync(file, data, options);
    const opts = typeof options === 'string' ? { encoding: options } : options || {};
    const descriptor = openSync(file, opts.flag || 'w', opts.mode);
    try { return mutateFd(descriptor, () => raw.writeFileSync(descriptor, data, opts)); }
    finally { raw.closeSync(descriptor); handles.delete(descriptor); }
  }
  function mkdirSync(file, options) {
    const name = relative(file);
    if (name === null) return raw.mkdirSync(file, options);
    const opts = typeof options === 'number' ? { mode: options } : options || {};
    if (opts.recursive) {
      const names = name === '.' ? ['.'] : name.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'));
      let first;
      for (const child of names) {
        const target = absolute(child);
        if (raw.lstatSync(target, { throwIfNoEntry: false })) { waitForDirectoryReceipt(child); continue; }
        try { mkdirSync(target, { mode: opts.mode }); first ??= target; }
        catch (error) { if (error.code !== 'EEXIST') throw error; waitForDirectoryReceipt(child); }
      }
      return first;
    }
    if (name === '.') {
      check('.'); const error = new Error('Build reservation directory already exists.'); error.code = 'EEXIST'; throw error;
    }
    parents(name);
    const parent = entries.get(path.dirname(name));
    putReceipt({ relative: name, ...createEntry(absolute(name), parent, { kind: 'directory', mode: opts.mode }) });
  }
  function remove(file, options = {}, directoryOnly = false) {
    const name = relative(file);
    if (name === null) return directoryOnly ? raw.rmdirSync(file, options) : raw.rmSync(file, options);
    if (name === '.') refuse('removal of the compiler reservation');
    parents(name);
    const stat = raw.lstatSync(file, { throwIfNoEntry: false });
    if (!stat && options.force) return;
    check(name, stat);
    if (stat.isDirectory()) {
      if (options.recursive) for (const child of raw.readdirSync(file)) remove(path.join(file, child), options);
      const expected = check(name); removeCapturedEntry(absolute(name), expected, () => parents(name));
    } else { const expected = check(name); removeCapturedEntry(absolute(name), expected, () => parents(name)); }
    drop(name);
  }
  function copyFileSync(source, destination, flags = 0) {
    if (relative(destination) === null) return raw.copyFileSync(source, destination, flags);
    const input = raw.openSync(source, fs.constants.O_RDONLY);
    let output;
    try {
      output = openSync(destination, flags & fs.constants.COPYFILE_EXCL ? 'wx' : 'w');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let count;
      while ((count = raw.readSync(input, buffer, 0, buffer.length, null))) {
        let written = 0;
        while (written < count) written += mutateFd(output, () => raw.writeSync(output, buffer, written, count - written));
      }
      // copyFile preserves executable permission bits; standalone helpers must
      // retain those bits even though their destination is descriptor-owned.
      mutateFd(output, () => raw.fchmodSync(output, raw.fstatSync(input).mode & 0o777));
    } finally { raw.closeSync(input); if (output !== undefined) { raw.closeSync(output); handles.delete(output); } }
  }
  function renameSync(source, destination) {
    const from = relative(source); const to = relative(destination);
    if (from === null && to === null) return raw.renameSync(source, destination);
    if (from === null || to === null) refuse('rename across compiler custody');
    parents(from); parents(to); const original = check(from);
    if (from === to) return;
    if (from === '.') refuse('rename of the compiler reservation');
    const destinationEntry = raw.lstatSync(destination, { throwIfNoEntry: false });
    if (destinationEntry) {
      // Compiler cache rotation may replace a prior owned file. A foreign or
      // directory destination is never an overwrite allowance.
      check(to, destinationEntry);
      if (!destinationEntry.isFile() || original.kind !== 'file') refuse(to);
      remove(destination);
    }
    const moved = [...entries.values()].filter(entry => entry.relative === from || entry.relative.startsWith(from + '/'));
    for (const entry of moved) check(entry.relative);
    const transferred = transferOwnedEntry(absolute(from), absolute(to), moved.map(entry => ({ ...entry,
      relative: entry.relative === from ? '.' : entry.relative.slice(from.length + 1) })),
    entries.get(path.dirname(from)), entries.get(path.dirname(to)));
    for (const entry of moved) drop(entry.relative);
    for (const entry of transferred) putReceipt({ ...entry, relative: entry.relative === '.' ? to : to + '/' + entry.relative });
  }
  const api = { ...raw, openSync, writeFileSync, mkdirSync, copyFileSync, renameSync,
    symlinkSync: (target, file, type) => {
      const name = relative(file);
      if (name === null) return raw.symlinkSync(target, file, type);
      parents(name);
      putReceipt({ relative: name, ...createEntry(absolute(name), entries.get(path.dirname(name)), { kind: 'symlink', target, type }) });
    },
    appendFileSync: (file, data, options) => writeFileSync(file, data, { ...(typeof options === 'string' ? { encoding: options } : options), flag: 'a' }),
    writeSync: (descriptor, ...args) => mutateFd(descriptor, () => raw.writeSync(descriptor, ...args)),
    writevSync: (descriptor, ...args) => mutateFd(descriptor, () => raw.writevSync(descriptor, ...args)),
    ftruncateSync: (descriptor, ...args) => mutateFd(descriptor, () => raw.ftruncateSync(descriptor, ...args)),
    fchmodSync: (descriptor, ...args) => mutateFd(descriptor, () => raw.fchmodSync(descriptor, ...args)),
    futimesSync: (descriptor, ...args) => mutateFd(descriptor, () => raw.futimesSync(descriptor, ...args)),
    closeSync: descriptor => { handles.delete(descriptor); return raw.closeSync(descriptor); },
    unlinkSync: file => remove(file), rmSync: (file, options) => remove(file, options),
    rmdirSync: (file, options) => remove(file, options, true),
  };
  for (const method of ['chmod', 'utimes']) api[method + 'Sync'] = (file, ...args) => {
    const name = relative(file);
    if (name === null) return raw[method + 'Sync'](file, ...args);
    parents(name); check(name);
    const descriptor = raw.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      check(name, raw.fstatSync(descriptor));
      const result = raw['f' + method + 'Sync'](descriptor, ...args);
      put(name, raw.fstatSync(descriptor)); return result;
    } finally { raw.closeSync(descriptor); }
  };
  const promises = { ...rawPromises };
  for (const method of ['writeFile', 'appendFile', 'mkdir', 'copyFile', 'rename', 'unlink', 'rm', 'rmdir', 'chmod', 'utimes', 'symlink']) {
    api[method] = (...args) => {
      const callback = args.pop();
      queueMicrotask(() => { try { callback(null, api[method + 'Sync'](...args)); } catch (error) { callback(error); } });
    };
    promises[method] = async (...args) => api[method + 'Sync'](...args);
  }
  api.open = (...args) => { const callback = args.pop(); queueMicrotask(() => {
    try { callback(null, openSync(...args)); } catch (error) { callback(error); }
  }); };
  for (const method of ['write', 'writev', 'ftruncate', 'fchmod', 'futimes', 'close']) api[method] = (...args) => {
    const callback = args.pop(); queueMicrotask(() => {
      try { const result = api[method + 'Sync'](...args); callback(null, result, args[1]); } catch (error) { callback(error); }
    });
  };
  promises.open = async (file, flags, mode) => {
    if (relative(file) === null || !writing(flags)) {
      return rawPromises.open(file, flags, mode);
    }
    const descriptor = openSync(file, flags, mode);
    return { fd: descriptor,
      writeFile: async (data, options) => writeFileSync(descriptor, data, options),
      appendFile: async (data, options) => api.appendFileSync(descriptor, data, options),
      write: async (...args) => ({ bytesWritten: api.writeSync(descriptor, ...args), buffer: args[0] }),
      writev: async (...args) => ({ bytesWritten: api.writevSync(descriptor, ...args), buffers: args[0] }),
      truncate: async length => api.ftruncateSync(descriptor, length),
      chmod: async mode => api.fchmodSync(descriptor, mode),
      utimes: async (...args) => api.futimesSync(descriptor, ...args),
      stat: async () => raw.fstatSync(descriptor), sync: async () => raw.fsyncSync(descriptor),
      close: async () => api.closeSync(descriptor),
      [Symbol.asyncDispose]: async () => api.closeSync(descriptor),
    };
  };
  api.createWriteStream = (file, options) => raw.createWriteStream(file, { ...options, fs: {
    open: api.open, write: api.write, writev: api.writev, close: api.close,
  } });
  function admit(pid, identity) { append({ kind: 'grant', author: ownKey, pid, identity }); }
  if (initialRoot) append({ kind: 'seed', secret: config.seed, writer: ownKey, entries: [initialRoot] });
  return { api, promises, admit,
    observedClose(pid, identity) { append({ kind: 'closed', author: ownKey, pid, identity }); },
    environment(env) { return { ...env, [ENV]: JSON.stringify(config),
      NODE_OPTIONS: `${env.NODE_OPTIONS || ''} --require=${JSON.stringify(__filename)}`.trim() }; },
    prove(inventory) {
      refresh(); if (partial || pending.length) throw new Error('Build writer receipts are incomplete; preserve output.');
      for (const writer of grants) if (writer !== ownKey && !closedWriters.has(writer)) {
        throw new Error('Build writer has no observed close receipt; preserve output.');
      }
      for (const entry of inventory) if (!matches(entry, entries.get(entry.relative))) refuse(entry.relative);
    },
    promote(destination, inventory) {
      if (destination.canonicalPath !== path.dirname(config.scope)) refuse('build publication parent');
      const rootFd = raw.openSync(destination.canonicalPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        const stat = raw.fstatSync(rootFd);
        if (stat.dev !== destination.device || stat.ino !== destination.inode) refuse('build publication root');
        const result = [receipt('.', stat)];
        for (const entry of inventory.filter(entry => entry.relative !== '.' && !entry.relative.includes('/'))) {
          if (entry.kind !== 'directory' && entry.kind !== 'file') refuse(entry.relative);
          const children = inventory.filter(child => child.relative === entry.relative || child.relative.startsWith(entry.relative + '/'));
          const transferred = transferOwnedEntry(absolute(entry.relative), path.join(destination.canonicalPath, entry.relative),
            children.map(child => ({ ...child, ...(child.kind === 'symlink' ? { symlinkTarget: entries.get(child.relative)?.symlinkTarget } : {}),
              relative: child.relative === entry.relative ? '.' : child.relative.slice(entry.relative.length + 1) })),
            entries.get('.'), destination);
          result.push(...transferred.map(child => ({ ...child,
            relative: child.relative === '.' ? entry.relative : entry.relative + '/' + child.relative })));
        }
        if (raw.readdirSync(config.scope).length) refuse('changed compiler namespace');
        check('.');
        result.push(receipt(path.basename(config.scope), raw.lstatSync(config.scope)));
        // Verify only receipts produced by the transfer, never grant custody to
        // a new output discovered after the move.
        const owned = new Map(result.map(entry => [entry.relative, entry]));
        for (const entry of result) {
          const file = path.join(destination.canonicalPath, entry.relative);
          if (!matches(receipt(entry.relative, raw.lstatSync(file)), entry)) refuse(entry.relative);
          if (entry.kind === 'directory' && entry.relative !== '.') for (const name of raw.readdirSync(file)) {
            const child = entry.relative + '/' + name; if (!owned.has(child)) refuse(child);
          }
        }
        return result;
      } finally { raw.closeSync(rootFd); }
    },
    close() { if (!closed) { closed = true; raw.closeSync(fd); } },
  };
}

function createBuildOutputWriter(scope, expected) {
  const rootFd = raw.openSync(scope, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let root;
  try {
    root = raw.fstatSync(rootFd);
    if (!expected || !root.isDirectory() || root.dev !== expected.device || root.ino !== expected.inode
      || raw.realpathSync(scope) !== scope) refuse('reserved compiler root');
  } finally { raw.closeSync(rootFd); }
  const directory = raw.mkdtempSync(path.join(require('node:os').tmpdir(), 'o8-build-writer-'));
  raw.chmodSync(directory, 0o700);
  const journal = path.join(directory, 'receipts');
  const fd = raw.openSync(journal, 'wx', 0o600); const stat = raw.fstatSync(fd); raw.closeSync(fd);
  const config = { scope, journal, device: stat.dev, inode: stat.ino,
    key: crypto.randomBytes(32).toString('hex'), seed: crypto.randomBytes(32).toString('hex') };
  return connect(config, receipt('.', root));
}

module.exports = { createBuildOutputWriter };
if (process.env[ENV]) {
  const session = connect(JSON.parse(process.env[ENV]));
  for (const [name, value] of Object.entries(session.api)) if (typeof value === 'function' && value !== raw[name]) fs[name] = value;
  for (const [name, value] of Object.entries(session.promises)) if (value !== rawPromises[name]) fs.promises[name] = value;
  // A spawned writer's native birth is granted by its already-admitted parent;
  // a PID supplied by the worker itself never creates authority.
  for (const [method, original] of [['spawn', rawSpawn], ['fork', rawFork]]) childProcess[method] = function (...args) {
    const child = original.apply(this, args);
    if (child.pid && (method === 'fork' || args[0] === process.execPath || args[0] === 'node')) {
      const identity = birth(child.pid);
      session.admit(child.pid, identity);
      child.once('close', () => session.observedClose(child.pid, identity));
    }
    return child;
  };
  // An empty plugin list otherwise initializes an uninstrumented native disk
  // cache despite having no plugins. Omit that empty option; compilation is
  // unchanged and every output writer remains accountable. Nonempty native
  // plugin output has no descriptor receipts and therefore remains held.
  const Module = require('node:module'); const load = Module._load;
  Module._load = function (request, parent, ...args) {
    const result = load.call(this, request, parent, ...args);
    if (!/options(?:\.js)?$/.test(request)) return result;
    const resolved = Module._resolveFilename(request, parent);
    if (!resolved.split(path.sep).join('/').endsWith('/next/dist/build/swc/options.js')) return result;
    const wrapped = { ...result };
    for (const name of ['getLoaderSWCOptions', 'getJestSWCOptions']) if (typeof result[name] === 'function') {
      wrapped[name] = (...options) => {
        const value = result[name](...options); const experimental = value.jsc?.experimental;
        if (Array.isArray(experimental?.plugins) && experimental.plugins.length === 0) delete experimental.plugins;
        return value;
      };
    }
    return wrapped;
  };
  require('node:module').syncBuiltinESMExports();
  process.once('exit', () => session.close());
}
