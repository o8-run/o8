import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import { readFileSync, lstatSync } from 'node:fs';
import { platform, userInfo } from 'node:os';
import { observeCloseProcess } from './close-process-observation';
import { missingLinuxLsof, readProcOpenFiles } from './proc-open-files-snapshot';

const run = promisify(execFile);
export interface OpenFileRow { pid: number; commandName: string; descriptor: string; file: string; owner?: string; unreadable?: true }

/** lsof puts failed readlink diagnostics in the name field, not stderr. */
export function isUnreadableCwdName(name: string, fileType: string): boolean {
  return (!fileType || fileType === 'unknown')
    && /^\/proc\/[1-9]\d*\/cwd \(readlink: .+\)$/.test(name);
}

/** /proc metadata needed to attest a denied-cwd process, behind a test seam. */
export interface ProcExemptProbe {
  /** `/proc/<pid>/status` real uid, comm name and PPid, or null when unreadable. */
  status(pid: number): { uid: number; name?: string; ppid?: number } | null;
  /** Owner uid of the `/proc/<pid>/cwd` magic link (lstat works under readlink denial). */
  cwdLinkUid(pid: number): number | null;
}

const realProcProbe: ProcExemptProbe = {
  status(pid) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const uidField = /^Uid:[ \t]+(\d+)[ \t]+\d+[ \t]+\d+[ \t]+\d+[ \t]*$/m.exec(status);
      if (!uidField) return null;
      const uid = Number(uidField[1]);
      if (!Number.isSafeInteger(uid)) return null;
      // Name and PPid are only needed for the session-manager lineage check;
      // the non-dumpable branch attests on uid alone, so keep them optional.
      const nameField = /^Name:[ \t]+(.+?)[ \t]*$/m.exec(status);
      const ppidField = /^PPid:[ \t]+(\d+)[ \t]*$/m.exec(status);
      const ppid = ppidField && Number.isSafeInteger(Number(ppidField[1])) ? Number(ppidField[1]) : undefined;
      return { uid, ...(nameField ? { name: nameField[1]! } : {}), ...(ppid === undefined ? {} : { ppid }) };
    } catch {
      return null;
    }
  },
  cwdLinkUid(pid) {
    try {
      return lstatSync(`/proc/${pid}/cwd`).uid;
    } catch {
      return null;
    }
  },
};

/**
 * A same-uid process whose cwd readlink is denied is exempt from refusal ONLY
 * when it provably cannot hold a worktree. Everything else — an unknown owner
 * or any other same-uid process — still refuses, so the live-worker guard
 * (#1585) stays strict.
 *
 * Exempt cases:
 *  - Non-dumpable: `/proc/<pid>/cwd` is no longer owned by the process uid
 *    (root-owned /proc). An o8 worker is always dumpable, so this is never one.
 *    If o8 ever spawned a worker through setuid/sandbox/prctl that drops
 *    dumpability, this would fail open for that worker.
 */
function sameUidCwdHolderExempt(pid: number, uid: number, probe: ProcExemptProbe): boolean {
  if (platform() !== 'linux') return false;
  const status = probe.status(pid);
  // An ownership change since lsof's observation cannot attest this process.
  if (!status || status.uid !== uid) return false;
  // Caveat: in a user namespace where root maps to our uid, this can misread.
  const cwdLinkUid = probe.cwdLinkUid(pid);
  if (cwdLinkUid !== null && cwdLinkUid !== uid) return true;
  // Session manager by LINEAGE, not name alone (#5423): on ptrace_scope=1 hosts
  // the runner cannot readlink the cwd of its own `systemd --user`, which is not
  // its descendant, yet that process (PPid 1) and its `(sd-pam)` child always
  // have cwd `/` and are never o8 workers. Requiring PPid 1 for systemd, and an
  // exempt systemd parent for sd-pam, keeps a worker that merely names itself
  // `systemd` from slipping through.
  if (status.name === 'systemd' && status.ppid === 1) return true;
  if (status.name === '(sd-pam)') {
    const parent = probe.status(status.ppid);
    if (parent && parent.uid === uid && parent.name === 'systemd' && parent.ppid === 1) return true;
  }
  return false;
}

export function unreadableCwdReason(
  rows: readonly { pid: number; owner?: string; unreadable?: true }[],
  probe: ProcExemptProbe = realProcProbe,
): string | null {
  const unreadable = rows.filter(row => row.unreadable);
  if (unreadable.length === 0) return null;
  const { username: login, uid } = userInfo();
  const row = unreadable.find(row => !row.owner
    || (row.owner === login && !sameUidCwdHolderExempt(row.pid, uid, probe)));
  return row ? `cwd unreadable for uid-owned/unknown process pid ${row.pid}` : null;
}
function processName(value: string): string {
  const name = value.trim().split(/\s+/)[0]?.split('/').pop() ?? 'process';
  return /^[A-Za-z0-9._-]{1,60}$/.test(name) ? name : 'process';
}

/** Strict native protocol, shared by descriptor and cwd projections. */
export function parseOpenFileSnapshot(files: string): OpenFileRow[] {
  let pid: number | null = null;
  let name = 'process';
  let owner: string | undefined;
  let descriptor = '';
  const entries: OpenFileRow[] = [];
  let hasCommand = false;
  let hasFile = false;
  let namedFile = false;
  let fileType = '';
  const pathlessKernelTypes = new Set(['PIPE', 'NPOLICY', 'NEXUS']);
  const checkComplete = () => {
    if (pid !== null && (!hasCommand || !hasFile || !namedFile)) {
      throw new Error('lsof returned incomplete open-file protocol');
    }
  };
  for (const line of files.split('\n')) {
    if (!line) continue;
    if (line.startsWith('p')) {
      checkComplete();
      hasCommand = hasFile = namedFile = false;
      pid = Number(line.slice(1));
      name = 'process';
      owner = undefined;
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('lsof returned malformed process identity');
    } else if (line.startsWith('c')) {
      if (pid === null || hasCommand || hasFile || !line.slice(1)) throw new Error('lsof returned malformed command coverage');
      hasCommand = true;
      name = processName(line.slice(1));
    } else if (line.startsWith('L')) {
      if (pid === null || owner !== undefined || hasFile || !line.slice(1)) throw new Error('lsof returned malformed owner coverage');
      owner = line.slice(1);
    } else if (line.startsWith('f')) {
      if (!hasCommand || !line.slice(1) || (hasFile && !namedFile)) throw new Error('lsof returned incomplete file coverage');
      hasFile = true;
      descriptor = line.slice(1);
      namedFile = false;
      fileType = '';
    } else if (line.startsWith('t')) {
      if (!hasFile || namedFile || fileType || !line.slice(1)) throw new Error('lsof returned malformed file type coverage');
      fileType = line.slice(1);
    } else if (line.startsWith('n')) {
      if (pid === null || !hasFile || namedFile || (!line.slice(1) && !pathlessKernelTypes.has(fileType))) throw new Error('lsof returned an unbound open file');
      namedFile = true;
      // These native kernel objects have no filesystem namespace. An empty
      // regular/unknown file name still refuses rather than hiding a holder.
      const file = line.slice(1).replace(/ \(deleted\)$/, '');
      const unreadable = descriptor === 'cwd' && isUnreadableCwdName(file, fileType);
      entries.push({ pid, commandName: name, descriptor, file: unreadable ? '' : file,
        ...(owner === undefined ? {} : { owner }), ...(unreadable ? { unreadable: true } : {}) });
    } else {
      throw new Error('lsof returned unexpected open-file protocol');
    }
  }
  checkComplete();
  if (pid === null) throw new Error('lsof open-file coverage is uncertain');
  return entries;
}

export function readCloseOpenFiles(): Promise<string> {
  return observeCloseProcess('open-files', async () => {
    try {
      const { stdout, stderr } = await run('lsof', ['-nP', '-FpcLftn'], {
        encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      });
      if (stderr.trim() || !stdout.trim()) throw new Error('Native open-file snapshot is incomplete.');
      return stdout;
    } catch (error) {
      if (!missingLinuxLsof(error)) throw error;
      return readProcOpenFiles();
    }
  });
}

export function readCloseOpenFileRows(): Promise<OpenFileRow[]> {
  return observeCloseProcess('open-file-rows', async () => {
    const rows = parseOpenFileSnapshot(await readCloseOpenFiles());
    const reason = unreadableCwdReason(rows);
    if (reason) throw new Error(reason);
    for (const row of rows) Object.freeze(row);
    return Object.freeze(rows) as unknown as OpenFileRow[];
  });
}
