import { childEnvironment } from '@/lib/providers/spawn-environment';
import 'server-only';
import { spawnSync } from '@/lib/providers/child-process';

export interface HandoffFileReceipt {
  content: string;
  device: number;
  inode: number;
}

export interface HandoffDirectoryIdentity {
  canonicalPath: string;
  device: number;
  inode: number;
}

// Like portable bundle publication, every operation receives an OS-captured cwd
// and an inherited descriptor. macOS has no directory traversal through /dev/fd.
// All file mutations and readback use relative leaf names, never lexical parents.
const HANDOFF_IO = String.raw`
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const identity = input.identity;
function directory() {
  const cwd = fs.lstatSync('.'), pinned = fs.fstatSync(3);
  const named = fs.lstatSync(identity.canonicalPath);
  for (const entry of [cwd, pinned, named]) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.dev !== identity.device
      || entry.ino !== identity.inode || (process.platform !== 'win32' && (entry.mode & 0o077) !== 0)
      || (process.getuid && entry.uid !== process.getuid())) throw new Error('Completion handoff directory changed before publication.');
  }
  if (fs.realpathSync('.') !== identity.canonicalPath
    || fs.realpathSync(identity.canonicalPath) !== identity.canonicalPath) throw new Error('Completion handoff namespace changed.');
}
function leaf(value) {
  if (!/^[a-f0-9]{64}\.json(?:\.[a-f0-9-]+\.tmp)?$/.test(value)) throw new Error('Unsafe completion handoff leaf.');
  return value;
}
function same(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode
    && a.uid === b.uid && a.nlink === b.nlink && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function read(name) {
  let fd;
  try { fd = fs.openSync(leaf(name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > input.maxBytes
      || (process.platform !== 'win32' && (before.mode & 0o077) !== 0) || (process.getuid && before.uid !== process.getuid())) throw new Error('Completion handoff file has unsafe ownership or exceeds its bound.');
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.length) {
      const count = fs.readSync(fd, content, offset, content.length - offset, offset);
      if (!count) throw new Error('Completion handoff was truncated during readback.');
      offset += count;
    }
    if (!same(before, fs.fstatSync(fd)) || !same(before, fs.lstatSync(name))) throw new Error('Completion handoff changed during readback.');
    return { content: content.toString('utf8'), device: before.dev, inode: before.ino };
  } finally { fs.closeSync(fd); }
}
directory();
let result;
if (input.operation === 'read') result = read(input.name);
else if (input.operation === 'prepare') {
  const content = Buffer.from(input.content);
  if (!content.length || content.length > input.maxBytes) throw new Error('Completion handoff exceeds its compact bound.');
  const fd = fs.openSync(leaf(input.name), fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
    | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  result = read(input.name);
  if (result.content !== input.content) throw new Error('Completion preparation failed readback.');
} else if (input.operation === 'publish') {
  const prepared = read(input.name), previous = read(input.destination);
  if (!prepared || prepared.device !== input.prepared.device || prepared.inode !== input.prepared.inode
    || prepared.content !== input.content || JSON.stringify(previous) !== JSON.stringify(input.previous)) {
    throw new Error('Completion handoff publication lost its exact file owner.');
  }
  directory();
  fs.renameSync(leaf(input.name), leaf(input.destination));
  fs.fsyncSync(3);
  directory();
  result = read(input.destination);
  if (!result || result.device !== prepared.device || result.inode !== prepared.inode
    || result.content !== input.content) throw new Error('Completion handoff failed durable readback.');
} else throw new Error('Unknown completion handoff operation.');
directory();
process.stdout.write(JSON.stringify(result));
`;

export function completionHandoffFileIo(
  identity: HandoffDirectoryIdentity,
  descriptor: number,
  request: { operation: 'read' | 'prepare' | 'publish'; name: string; maxBytes: number;
    content?: string; destination?: string; previous?: HandoffFileReceipt | null; prepared?: HandoffFileReceipt },
): HandoffFileReceipt | null {
  const result = spawnSync(process.execPath, ['-e', HANDOFF_IO], {
    cwd: identity.canonicalPath, stdio: ['pipe', 'pipe', 'pipe', descriptor],
    input: JSON.stringify({ ...request, identity }),
    env: childEnvironment({ env: { NODE_OPTIONS: '' } }), timeout: 5_000, maxBuffer: 128 * 1024,
    encoding: 'utf8', windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.error?.message || 'Captured completion handoff I/O refused.');
  }
  return JSON.parse(result.stdout) as HandoffFileReceipt | null;
}
