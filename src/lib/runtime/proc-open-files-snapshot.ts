import { opendir, readFile, readdir, readlink } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

/** Linux fallback for the same complete, machine-wide evidence required of lsof. */
export async function readProcOpenFiles(): Promise<string> {
  const deadline = performance.now() + 5_000;
  const lines: string[] = [];
  let bytes = 0;
  const append = (line: string) => {
    if (line.includes('\n') || line.includes('\r') || line.includes('\0')) {
      throw new Error('Proc open-file protocol cannot represent this evidence.');
    }
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > 16 * 1024 * 1024 || performance.now() > deadline) {
      throw new Error('Proc open-file snapshot exceeded its evidence bound.');
    }
    lines.push(line);
  };
  const ids = async (directory: string) => {
    const entries = (await readdir(directory)).filter(value => /^\d+$/.test(value)).sort();
    if (!entries.length || entries.some(value => !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) {
      throw new Error('Proc process enumeration is incomplete.');
    }
    return entries;
  };
  const mounts = (await readFile('/proc/mounts', 'utf8')).trim().split('\n')
    .map(line => line.split(/\s+/)).filter(fields => fields[1] === '/proc');
  if (mounts.length !== 1 || mounts[0]![2] !== 'proc'
    || mounts[0]![3]!.split(',').some(option => option.startsWith('hidepid=') && option !== 'hidepid=0')) {
    throw new Error('Proc process visibility is uncertain.');
  }
  const namespace = await readlink('/proc/self/ns/mnt');
  const processes = await ids('/proc');
  if (!processes.includes(String(process.pid))) throw new Error('Proc process coverage is incomplete.');
  for (const pid of processes) {
    const tasksPath = `/proc/${pid}/task`;
    const tasks = await ids(tasksPath);
    for (const tid of tasks) {
      const task = `${tasksPath}/${tid}`;
      const before = await readFile(`${task}/stat`, 'utf8');
      const identity = /^([0-9]+) \(([\s\S]*)\) ([\s\S]+)$/.exec(before.trim());
      const fields = identity?.[3]?.split(/\s+/);
      if (!identity || identity[1] !== tid || !fields || fields.length < 20
        || !/^[RSDZTWtXxKWPIN]$/.test(fields[0]!)
        || !fields.slice(1, 20).every(value => /^-?\d+$/.test(value))
        || !/^\d+$/.test(fields[19]!)) throw new Error('Proc task identity is incomplete.');
      // Zombies and kernel threads have no userspace filesystem holders.
      if (fields[0] === 'Z' || fields[0] === 'X' || (Number(fields[6]) & 0x200000) !== 0) continue;
      if (await readlink(`${task}/ns/mnt`) !== namespace || await readlink(`${task}/root`) !== '/') {
        throw new Error('Proc task filesystem namespace is uncertain.');
      }
      append(`p${pid}`);
      append(`c${identity[2]}`);
      const file = (descriptor: string, target: string) => {
        if (!target) throw new Error('Proc file coverage is incomplete.');
        append(`f${descriptor}`);
        append(`n${target}`);
      };
      const cwd = await readlink(`${task}/cwd`);
      if (!cwd.startsWith('/')) throw new Error('Proc cwd namespace is incomplete.');
      file('cwd', cwd);
      file('rtd', await readlink(`${task}/root`));
      file('txt', await readlink(`${task}/exe`));
      // Keep the directory open through the scan: when inspecting our own fd
      // table, closing readdir's handle first would create a missing fd row.
      for await (const entry of await opendir(`${task}/fd`)) {
        const descriptor = entry.name;
        if (!/^\d+$/.test(descriptor)) throw new Error('Proc descriptor identity is malformed.');
        file(descriptor, await readlink(`${task}/fd/${descriptor}`));
      }
      const mappings = await readFile(`${task}/maps`, 'utf8');
      if (!mappings.trim()) throw new Error('Proc mapped-file coverage is incomplete.');
      for (const mapping of mappings.split('\n')) {
        if (!mapping) continue;
        const match = /^[a-f0-9]+-[a-f0-9]+ [rwxps-]{4} [a-f0-9]+ [a-f0-9]+:[a-f0-9]+\s+(\d+)(?:\s+(.*))?$/.exec(mapping);
        if (!match) throw new Error('Proc mapped-file coverage is malformed.');
        const target = match[2] ?? '';
        if (target.startsWith('/')) {
          // The maps format cannot distinguish an escaped newline from a
          // literal octal escape in a name. Neither is absence evidence.
          if (/\\[0-7]{3}/.test(target)) throw new Error('Proc mapped-file namespace is ambiguous.');
          file('mem', target);
        } else if (match[1] !== '0') {
          throw new Error('Proc mapped-file namespace is incomplete.');
        }
      }
      const after = await readFile(`${task}/stat`, 'utf8');
      const afterFields = after.slice(after.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (afterFields[19] !== fields[19] || !after.startsWith(`${tid} (`)) {
        throw new Error('Proc task identity changed during observation.');
      }
    }
    if ((await ids(tasksPath)).join(',') !== tasks.join(',')) {
      throw new Error('Proc task coverage changed during observation.');
    }
  }
  if ((await ids('/proc')).join(',') !== processes.join(',') || !lines.length) {
    throw new Error('Proc process coverage changed during observation.');
  }
  append('');
  return lines.join('\n');
}

export function missingLinuxLsof(error: unknown): boolean {
  return process.platform === 'linux' && (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}
