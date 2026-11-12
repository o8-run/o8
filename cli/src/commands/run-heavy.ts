import os from 'node:os';
import { spawn } from 'node:child_process';
import { withMachineLease } from '../../../src/lib/leases/machine-heavy';

// This supervisor owns the lease. If the CLI crashes, a running command keeps
// its live owner until it exits; an unstarted queued supervisor exits on EOF.
const supervisor = `
const { spawn } = require('node:child_process');
let child;
const control = require('node:fs').createReadStream(null, { fd: 3 });
control.once('data', () => {
  child = spawn(process.argv[1], process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, O8_RUN_HEAVY_ACTIVE: '1' } });
  child.once('error', () => process.exit(1));
  child.once('close', (code, signal) => process.exit(signal ? 128 + require('node:os').constants.signals[signal] : code ?? 1));
});
control.once('end', () => { if (!child) process.exit(1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (child) { if (process.platform === 'win32') child.kill(signal); } else process.exit(128 + require('node:os').constants.signals[signal]);
});
`;

export async function runHeavy(args: string[]): Promise<number> {
  const separator = args.indexOf('--');
  const options = args.slice(0, separator);
  const command = args.slice(separator + 1);
  const resource = options.length === 0 ? 'heavy-steps'
    : options.length === 2 && options[0] === '--resource' && options[1] === 'verify-ci' ? 'verify-ci' : null;
  if (separator < 0 || !command.length || !resource) throw new Error('Usage: o8 run-heavy -- <command> [args...]');
  if (process.env.O8_RUN_HEAVY_ACTIVE === '1') {
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
    throw error;
  } finally {
    (child.stdio[3] as import('node:stream').Writable).end();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    await done;
  }
}
