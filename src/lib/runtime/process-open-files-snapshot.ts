import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import { observeCloseProcess } from './close-process-observation';
import { missingLinuxLsof, readProcOpenFiles } from './proc-open-files-snapshot';

const run = promisify(execFile);
export interface OpenFileRow { pid: number; commandName: string; descriptor: string; file: string }
function processName(value: string): string {
  const name = value.trim().split(/\s+/)[0]?.split('/').pop() ?? 'process';
  return /^[A-Za-z0-9._-]{1,60}$/.test(name) ? name : 'process';
}

/** Strict native protocol, shared by descriptor and cwd projections. */
export function parseOpenFileSnapshot(files: string): OpenFileRow[] {
  let pid: number | null = null;
  let name = 'process';
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
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('lsof returned malformed process identity');
    } else if (line.startsWith('c')) {
      if (pid === null || hasCommand || hasFile || !line.slice(1)) throw new Error('lsof returned malformed command coverage');
      hasCommand = true;
      name = processName(line.slice(1));
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
      entries.push({ pid, commandName: name, descriptor, file });
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
      const { stdout, stderr } = await run('lsof', ['-nP', '-Fpcftn'], {
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
    for (const row of rows) Object.freeze(row);
    return Object.freeze(rows) as unknown as OpenFileRow[];
  });
}
