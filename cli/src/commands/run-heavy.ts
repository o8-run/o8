import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { withMachineLease } from '../../../src/lib/leases/machine-heavy';

// This supervisor owns the lease. If the CLI crashes, a running command keeps
// its live owner until it exits; an unstarted queued supervisor exits on EOF.
const supervisor = `// o8-heavy-supervisor
const { spawn } = require('node:child_process');
let child;
const control = require('node:fs').createReadStream(null, { fd: 3 });
control.once('data', () => {
  child = spawn(process.argv[1], process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, O8_RUN_HEAVY_ACTIVE: String(process.pid) } });
  child.once('error', () => process.exit(1));
  child.once('close', (code, signal) => process.exit(signal ? 128 + require('node:os').constants.signals[signal] : code ?? 1));
});
control.once('end', () => { if (!child) process.exit(1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (child) { if (process.platform === 'win32') child.kill(signal); } else process.exit(128 + require('node:os').constants.signals[signal]);
});
`;

/** Only a live supervisor ancestor can lend its admission to this process. */
function hasSupervisorAdmission(): boolean {
  const raw = process.env.O8_RUN_HEAVY_ACTIVE ?? '';
  if (!/^[1-9]\d*$/.test(raw)) return false;
  const supervisorPid = Number(raw);
  try {
    process.kill(supervisorPid, 0);
    let command: string;
    let parents: Map<number, number>;
    if (process.platform === 'win32') {
      const rows = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', timeout: 2000 })) as { ProcessId: number; ParentProcessId: number; CommandLine: string }[];
      command = rows.find(row => row.ProcessId === supervisorPid)?.CommandLine ?? '';
      parents = new Map(rows.map(row => [row.ProcessId, row.ParentProcessId]));
    } else {
      command = execFileSync('ps', ['-p', raw, '-o', 'command='], { encoding: 'utf8', timeout: 2000 });
      const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 });
      parents = new Map(rows.trim().split('\n').map(row => row.trim().split(/\s+/).map(Number) as [number, number]));
    }
    if (!command.includes('// o8-heavy-supervisor')) return false;
    for (let pid = process.ppid, depth = 0; pid > 1 && depth < 128; depth++) {
      if (pid === supervisorPid) return true;
      pid = parents.get(pid) ?? 0;
    }
  } catch { /* Missing or unknown ancestry must queue normally. */ }
  return false;
}

export async function runHeavy(args: string[]): Promise<number> {
  const separator = args.indexOf('--');
  const options = args.slice(0, separator);
  const command = args.slice(separator + 1);
  const resource = options.length === 0 ? 'heavy-steps'
    : options.length === 2 && options[0] === '--resource' && options[1] === 'verify-ci' ? 'verify-ci' : null;
  if (separator < 0 || !command.length || !resource) throw new Error('Usage: o8 run-heavy -- <command> [args...]');
  if (hasSupervisorAdmission()) {
    return new Promise<number>((resolve, reject) => {
      const inner = spawn(command[0], command.slice(1), { stdio: 'inherit' });
      inner.once('error', reject);
      inner.once('close', (code, signal) => resolve(signal ? 128 + os.constants.signals[signal] : code ?? 1));
    });
  }
  const child = spawn(process.execPath, ['-e', supervisor, ...command], { detached: process.platform !== 'win32', stdio: ['inherit', 'inherit', 'inherit', 'pipe'] });
  const done = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
  if (!child.pid) return done;
  const cancellation = new AbortController();
  let interrupted: NodeJS.Signals | undefined;
  const forward = (signal: NodeJS.Signals) => {
    interrupted = signal;
    cancellation.abort();
    if (process.platform === 'win32') child.kill(signal);
    else { try { process.kill(-child.pid!, signal); } catch { /* already exited */ } }
  };
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    return await withMachineLease(resource, async () => {
      (child.stdio[3] as import('node:stream').Writable).end('start');
      const code = await done;
      return interrupted ? 128 + os.constants.signals[interrupted] : code;
    }, true, child.pid, cancellation.signal);
  } catch (error) {
    if (interrupted) return 128 + os.constants.signals[interrupted];
    const code = (error as NodeJS.ErrnoException)?.code ?? '';
    const message = error instanceof Error ? error.message : String(error);
    if (['EACCES', 'EPERM', 'SQLITE_CANTOPEN', 'SQLITE_READONLY', 'SQLITE_PERM'].includes(code) || /permission denied|readonly|unable to open database|EACCES|EPERM/i.test(message)) {
      console.error('Heavy-step queue is inaccessible (#6009: host brokering required). Command was not run.');
      return 1;
    }
    throw error;
  } finally {
    (child.stdio[3] as import('node:stream').Writable).end();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    await done;
  }
}
