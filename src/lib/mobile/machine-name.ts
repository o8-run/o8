import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { execFileSync } from '@/lib/providers/child-process';

type Run = (file: string, args: string[]) => string;

const runCommand: Run = (file, args) =>
  execFileSync(file, args, { windowsHide: true, encoding: 'utf-8', timeout: 2000 });

/**
 * The name a person gave this computer, for a phone that is paired with more
 * than one. macOS keeps it in Sharing settings; elsewhere the host name stands in.
 */
export function readMachineName(platform: string = process.platform, run: Run = runCommand, host: () => string = hostname): string {
  if (platform === 'darwin') {
    try {
      const name = run('scutil', ['--get', 'ComputerName']).trim();
      if (name) return name;
    } catch {
      // Unset or unavailable: fall through to the host name.
    }
  }
  return host().replace(/\.(local|lan|home)$/i, '').trim() || 'This computer';
}

/**
 * A name the owner chose for this computer: the first line of `computer-name`
 * in the data directory. It wins over the system name, which is the only way
 * to name a computer that has no Sharing settings.
 */
export function readChosenMachineName(read: () => string = () => readFileSync(path.join(getDataDir(), 'computer-name'), 'utf8')): string | null {
  try {
    const name = read().split(/\r?\n/)[0]?.trim().slice(0, 80);
    return name || null;
  } catch {
    return null;
  }
}

let cached: string | undefined;

/** Read once per process: the name changes rarely and the thread list is hot. */
export function localMachineName(): string {
  cached ??= readChosenMachineName() ?? readMachineName();
  return cached;
}
