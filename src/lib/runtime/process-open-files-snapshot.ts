import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import { readFileSync, lstatSync } from 'node:fs';
import { platform, userInfo } from 'node:os';
import { observeCloseProcess } from './close-process-observation';

const run = promisify(execFile);
export interface OpenFileRow { pid: number; commandName: string; descriptor: string; file: string; owner?: string; unreadable?: true }

/** lsof puts failed readlink diagnostics in the name field, not stderr. */
export function isUnreadableCwdName(name: string, fileType: string): boolean {
  return (!fileType || fileType === 'unknown')
    && /^\/proc\/[1-9]\d*\/cwd \(readlink: .+\)$/.test(name);
}

function isNonDumpableSameUid(pid: number, uid: number): boolean {
  // Non-Linux hosts (including macOS) have no /proc; keep the denied-cwd refusal there.
  if (platform() !== 'linux') return false;
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const fields = /^Uid:[ \t]+(\d+)[ \t]+\d+[ \t]+\d+[ \t]+\d+[ \t]*$/m.exec(status);
    if (!fields) return false;
    const realUid = Number(fields[1]);
    // An ownership change since lsof's observation cannot attest this process.
    if (!Number.isSafeInteger(realUid) || realUid !== uid) return false;
    // Inspect the link itself: lstat works even when readlink is denied.
    const cwdOwnerUid = lstatSync(`/proc/${pid}/cwd`).uid;
    // o8 workers are always dumpable; a non-dumpable same-uid process is never a worker.
    // If o8 ever spawns a worker through setuid, a sandbox or prctl that drops dumpability,
    // this becomes a fail-open for that worker.
    // Caveat: in a user namespace where root maps to our uid, the /proc owner comparison can misread.
    return cwdOwnerUid !== realUid;
  } catch {
    // Missing or unreadable /proc metadata never exempts a process from coverage.
    return false;
  }
}

export function unreadableCwdReason(rows: readonly { pid: number; owner?: string; unreadable?: true }[]): string | null {
  const unreadable = rows.filter(row => row.unreadable);
  if (unreadable.length === 0) return null;
  const { username: login, uid } = userInfo();
  const row = unreadable.find(row => !row.owner
    || (row.owner === login && !isNonDumpableSameUid(row.pid, uid)));
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
    const { stdout, stderr } = await run('lsof', ['-nP', '-FpcLftn'], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    if (stderr.trim() || !stdout.trim()) throw new Error('Native open-file snapshot is incomplete.');
    return stdout;
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
