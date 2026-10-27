import 'server-only';

import { readlink } from 'node:fs/promises';
import { execFile } from '@/lib/providers/child-process';
import { normalizeInstallPlatform, type InstallInfo } from './install-target';

async function query(file: string, args: string[]): Promise<string | null> {
  return new Promise(resolve => {
    try {
      execFile(file, args, { encoding: 'utf8', timeout: 1_500, maxBuffer: 16_384, windowsHide: true },
        (error, stdout) => resolve(error ? null : stdout.trim()));
    } catch { resolve(null); }
  });
}

/** Check the actual parent shell, not APPIMAGE, PATH, or directory permissions. */
async function linuxPackageManager(): Promise<'deb' | 'rpm' | null> {
  let executable: string;
  // After apt/dnf replaces a running binary, procfs appends this suffix.
  // Its original path is still the package manager's owned install target.
  try { executable = (await readlink(`/proc/${process.ppid}/exe`)).replace(/ \(deleted\)$/, ''); }
  catch { return null; }
  const deb = await query('/usr/bin/dpkg-query', ['--search', executable]);
  // dpkg --search accepts globs. An exact returned path prevents a wildcard
  // in a tarball's filename from claiming ownership of an unrelated binary.
  if (deb?.split('\n').some(line => {
    const owner = /^o8(?::[a-z0-9-]+)?: (.*)$/.exec(line);
    return owner?.[1] === executable;
  })) return 'deb';
  const rpm = await query('/usr/bin/rpm', ['--query', '--file', executable, '--queryformat', '%{NAME}']);
  return rpm === 'o8' ? 'rpm' : null;
}

export async function getRunningInstallInfo(): Promise<InstallInfo> {
  const platform = normalizeInstallPlatform(process.platform);
  return {
    platform,
    arch: process.arch || null,
    appImagePath: process.env.APPIMAGE?.trim() || null,
    updaterSelfUpdatable: null,
    ...(platform === 'linux' ? { packageManager: await linuxPackageManager() } : {}),
  };
}
