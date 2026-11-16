import { hostname } from 'node:os';
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

let cached: string | undefined;

/** Read once per process: the name changes rarely and the thread list is hot. */
export function localMachineName(): string {
  cached ??= readMachineName();
  return cached;
}
