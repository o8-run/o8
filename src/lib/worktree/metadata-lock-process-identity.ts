import { childEnvironment } from '@/lib/providers/spawn-environment';
import { spawn, spawnSync } from '@/lib/providers/child-process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export interface MetadataLockProcessIdentity {
  version: 1;
  platform: 'darwin' | 'linux' | 'win32';
  bootId: string;
  startId: string;
}

export type MetadataLockProcessProbe =
  | { state: 'live'; identity: MetadataLockProcessIdentity }
  | { state: 'absent' }
  | { state: 'unknown'; detail: string };

interface CommandReceipt {
  code: number;
  stdout: string;
  stderr: string;
}

const COMMAND_OUTPUT_LIMIT = 64 * 1024;
// On Windows the identity probe shells out to powershell.exe with two
// Get-CimInstance queries; a cold CIM session on a busy host regularly
// exceeds 2 s (the same failure shape as #3564), which turns every probe
// "unknown" and holds all worktree metadata mutation. macOS/Linux helpers
// stay far inside 2 s.
const COMMAND_TIMEOUT_MS = process.platform === 'win32' ? 15_000 : 2_000;

/**
 * The time limit only stops a command that is still running, and the receipt
 * always waits for the command's own close. `execFile`'s limit discards the
 * output instead, so on a loop held past the limit a command that had already
 * succeeded came back empty and the probe reported `unknown` (#3565).
 */
function runCommand(command: string, args: string[]): Promise<CommandReceipt> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { env: childEnvironment({ env: { LANG: 'C', LC_ALL: 'C' } }), windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: 127, stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let overflow = false;
    const collect = (append: (chunk: string) => void) => (chunk: string) => {
      if (overflow) return;
      if (stdout.length + stderr.length + chunk.length > COMMAND_OUTPUT_LIMIT) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      append(chunk);
    };
    child.stdout?.setEncoding('utf8').on('data', collect((chunk) => { stdout += chunk; }));
    child.stderr?.setEncoding('utf8').on('data', collect((chunk) => { stderr += chunk; }));
    const timer = setTimeout(() => child.kill('SIGKILL'), COMMAND_TIMEOUT_MS);
    child.once('error', () => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: overflow || typeof code !== 'number' ? 127 : code, stdout, stderr });
    });
  });
}

function processPresence(pid: number): 'live' | 'absent' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'live';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'absent';
    if (code === 'EPERM') return 'live';
    return 'unknown';
  }
}

function cleanIdentityPart(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 160 || /[^\x20-\x7e]/.test(normalized)) return null;
  return normalized;
}

async function probeLinux(pid: number): Promise<MetadataLockProcessProbe> {
  let bootId: string;
  let stat: string;
  try {
    [bootId, stat] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ]);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && processPresence(pid) === 'absent') return { state: 'absent' };
    return { state: 'unknown', detail: `Linux process identity could not be read (${code ?? 'unknown error'}).` };
  }
  const commandEnd = stat.lastIndexOf(') ');
  const fields = commandEnd >= 0 ? stat.slice(commandEnd + 2).trim().split(/\s+/) : [];
  const normalizedBootId = cleanIdentityPart(bootId);
  const startId = fields[19];
  if (!normalizedBootId || !startId || !/^\d+$/.test(startId)) {
    return { state: 'unknown', detail: 'Linux process identity had an unsupported shape.' };
  }
  return {
    state: 'live',
    identity: { version: 1, platform: 'linux', bootId: normalizedBootId, startId },
  };
}

async function probeDarwin(pid: number): Promise<MetadataLockProcessProbe> {
  const [boot, started] = await Promise.all([
    runCommand('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']),
    runCommand('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]),
  ]);
  if (started.code !== 0 || !started.stdout.trim()) {
    if (processPresence(pid) === 'absent') return { state: 'absent' };
    return { state: 'unknown', detail: `macOS process start time could not be read (exit ${started.code}).` };
  }
  if (boot.code !== 0) {
    return { state: 'unknown', detail: `macOS boot-session identity could not be read (exit ${boot.code}).` };
  }
  const bootId = cleanIdentityPart(boot.stdout);
  const startId = cleanIdentityPart(started.stdout);
  if (!bootId || !startId) {
    return { state: 'unknown', detail: 'macOS process identity had an unsupported shape.' };
  }
  return {
    state: 'live',
    identity: { version: 1, platform: 'darwin', bootId, startId },
  };
}

async function probeWindows(pid: number): Promise<MetadataLockProcessProbe> {
  const script = [
    `$process = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction Stop`,
    'if ($null -eq $process) { exit 3 }',
    '$boot = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().Ticks',
    '$started = $process.CreationDate.ToUniversalTime().Ticks',
    '[Console]::Out.Write("$boot`n$started")',
  ].join('; ');
  const receipt = await runCommand('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ]);
  if (receipt.code === 3 && processPresence(pid) === 'absent') return { state: 'absent' };
  if (receipt.code !== 0) {
    return { state: 'unknown', detail: `Windows process identity could not be read (exit ${receipt.code}).` };
  }
  const [rawBootId, rawStartId, ...extra] = receipt.stdout.trim().split(/\r?\n/);
  const bootId = cleanIdentityPart(rawBootId ?? '');
  const startId = cleanIdentityPart(rawStartId ?? '');
  if (!bootId || !startId || extra.length > 0 || !/^\d+$/.test(bootId) || !/^\d+$/.test(startId)) {
    return { state: 'unknown', detail: 'Windows process identity had an unsupported shape.' };
  }
  return {
    state: 'live',
    identity: { version: 1, platform: 'win32', bootId, startId },
  };
}

export function isMetadataLockProcessIdentity(value: unknown): value is MetadataLockProcessIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Partial<MetadataLockProcessIdentity>;
  return Object.keys(value).sort().join(',') === 'bootId,platform,startId,version'
    && identity.version === 1
    && (identity.platform === 'darwin' || identity.platform === 'linux' || identity.platform === 'win32')
    && typeof identity.bootId === 'string'
    && cleanIdentityPart(identity.bootId) === identity.bootId
    && typeof identity.startId === 'string'
    && cleanIdentityPart(identity.startId) === identity.startId;
}

export function sameMetadataLockProcessIdentity(
  first: MetadataLockProcessIdentity,
  second: MetadataLockProcessIdentity,
): boolean {
  return first.version === second.version
    && first.platform === second.platform
    && first.bootId === second.bootId
    && first.startId === second.startId;
}

export async function probeMetadataLockProcessIdentity(
  pid: number,
): Promise<MetadataLockProcessProbe> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { state: 'unknown', detail: 'The metadata-lock PID is invalid.' };
  }
  if (pid === process.pid) return probeOwnProcess();
  const presence = processPresence(pid);
  if (presence === 'absent') return { state: 'absent' };
  if (presence === 'unknown') {
    return { state: 'unknown', detail: 'The metadata-lock PID could not be probed.' };
  }
  if (process.platform === 'linux') return probeLinux(pid);
  if (process.platform === 'darwin') return probeDarwin(pid);
  if (process.platform === 'win32') return probeWindows(pid);
  return { state: 'unknown', detail: `Process identity is unsupported on ${process.platform}.` };
}

function runCommandSync(command: string, args: string[]): CommandReceipt {
  const receipt = spawnSync(command, args, {
    encoding: 'utf8',
    env: childEnvironment({ env: { LANG: 'C', LC_ALL: 'C' } }),
    maxBuffer: 64 * 1024,
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  return {
    code: typeof receipt.status === 'number' ? receipt.status : receipt.error ? 127 : 0,
    stdout: receipt.stdout ?? '',
    stderr: receipt.stderr ?? '',
  };
}

/** Synchronous form for SQLite boot recovery, where the schema hook cannot await. */
export function probeMetadataLockProcessIdentitySync(pid: number): MetadataLockProcessProbe {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { state: 'unknown', detail: 'The metadata-lock PID is invalid.' };
  }
  if (pid === process.pid) return probeOwnProcess();
  return probeProcessIdentitySync(pid);
}

let ownProcessIdentity: MetadataLockProcessIdentity | null = null;

/**
 * This process's boot session and start time cannot change while it runs, so its first live
 * identity stands for its lifetime. It is read synchronously: on a busy event loop the async
 * execFile timer can fire before the child's exit is handled, which drops output from a
 * command that already succeeded and refused every managed worktree launch (#3564).
 */
function probeOwnProcess(): MetadataLockProcessProbe {
  if (!ownProcessIdentity) {
    const probe = probeProcessIdentitySync(process.pid);
    if (probe.state !== 'live') return probe;
    ownProcessIdentity = probe.identity;
  }
  return { state: 'live', identity: { ...ownProcessIdentity } };
}

function probeProcessIdentitySync(pid: number): MetadataLockProcessProbe {
  const presence = processPresence(pid);
  if (presence === 'absent') return { state: 'absent' };
  if (presence === 'unknown') return { state: 'unknown', detail: 'The metadata-lock PID could not be probed.' };
  if (process.platform === 'linux') {
    try {
      const bootId = cleanIdentityPart(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'));
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const commandEnd = stat.lastIndexOf(') ');
      const fields = commandEnd >= 0 ? stat.slice(commandEnd + 2).trim().split(/\s+/) : [];
      const startId = fields[19];
      if (!bootId || !startId || !/^\d+$/.test(startId)) {
        return { state: 'unknown', detail: 'Linux process identity had an unsupported shape.' };
      }
      return { state: 'live', identity: { version: 1, platform: 'linux', bootId, startId } };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' && processPresence(pid) === 'absent') return { state: 'absent' };
      return { state: 'unknown', detail: `Linux process identity could not be read (${code ?? 'unknown error'}).` };
    }
  }
  if (process.platform === 'darwin') {
    const boot = runCommandSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']);
    const started = runCommandSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]);
    if (started.code !== 0 || !started.stdout.trim()) {
      return processPresence(pid) === 'absent'
        ? { state: 'absent' }
        : { state: 'unknown', detail: `macOS process start time could not be read (exit ${started.code}).` };
    }
    const bootId = boot.code === 0 ? cleanIdentityPart(boot.stdout) : null;
    const startId = cleanIdentityPart(started.stdout);
    return bootId && startId
      ? { state: 'live', identity: { version: 1, platform: 'darwin', bootId, startId } }
      : { state: 'unknown', detail: 'macOS process identity had an unsupported shape.' };
  }
  if (process.platform === 'win32') {
    const script = [
      `$process = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction Stop`,
      'if ($null -eq $process) { exit 3 }',
      '$boot = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().Ticks',
      '$started = $process.CreationDate.ToUniversalTime().Ticks',
      '[Console]::Out.Write("$boot`n$started")',
    ].join('; ');
    const receipt = runCommandSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (receipt.code === 3 && processPresence(pid) === 'absent') return { state: 'absent' };
    const [rawBootId, rawStartId, ...extra] = receipt.stdout.trim().split(/\r?\n/);
    const bootId = cleanIdentityPart(rawBootId ?? '');
    const startId = cleanIdentityPart(rawStartId ?? '');
    return receipt.code === 0 && bootId && startId && extra.length === 0
      ? { state: 'live', identity: { version: 1, platform: 'win32', bootId, startId } }
      : { state: 'unknown', detail: `Windows process identity could not be read (exit ${receipt.code}).` };
  }
  return { state: 'unknown', detail: `Process identity is unsupported on ${process.platform}.` };
}

/** Wall-clock boot instant for proving an identity-less legacy owner predates this boot. */
export function probeSystemBootTimeMsSync(): number | null {
  if (process.platform === 'linux') {
    try {
      const match = readFileSync('/proc/stat', 'utf8').match(/^btime\s+(\d+)$/m);
      return match ? Number(match[1]) * 1_000 : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    const receipt = runCommandSync('/usr/sbin/sysctl', ['-n', 'kern.boottime']);
    const match = receipt.code === 0 ? receipt.stdout.match(/sec\s*=\s*(\d+)/) : null;
    return match ? Number(match[1]) * 1_000 : null;
  }
  if (process.platform === 'win32') {
    const receipt = runCommandSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '[Console]::Out.Write(([DateTimeOffset](Get-CimInstance Win32_OperatingSystem).LastBootUpTime).ToUnixTimeMilliseconds())',
    ]);
    const value = Number(receipt.stdout.trim());
    return receipt.code === 0 && Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  return null;
}
