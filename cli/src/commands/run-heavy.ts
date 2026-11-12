import { spawn } from 'node:child_process';
import { withMachineLease } from '../../../src/lib/leases/machine-heavy';

// This supervisor owns the lease. If the CLI crashes, a running command keeps
// its live owner until it exits; an unstarted queued supervisor exits on EOF.
const supervisor = `
const { spawn } = require('node:child_process');
let child;
process.stdin.once('data', () => {
  child = spawn(process.argv[1], process.argv.slice(2), { stdio: 'inherit' });
  child.once('error', () => process.exit(1));
  child.once('close', (code, signal) => process.exit(signal ? 128 : code ?? 1));
});
process.stdin.once('end', () => { if (!child) process.exit(1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (child) child.kill(signal); else process.exit(128);
});
`;

export async function runHeavy(args: string[]): Promise<number> {
  const separator = args.indexOf('--');
  const options = args.slice(0, separator);
  const command = args.slice(separator + 1);
  const resource = options.length === 0 ? 'heavy-steps'
    : options.length === 2 && options[0] === '--resource' && options[1] === 'verify-ci' ? 'verify-ci' : null;
  if (separator < 0 || !command.length || !resource) throw new Error('Usage: o8 run-heavy -- <command> [args...]');
  const child = spawn(process.execPath, ['-e', supervisor, ...command], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
  if (!child.pid) return done;
  const cancellation = new AbortController();
  const interrupt = () => { cancellation.abort(); child.kill('SIGINT'); };
  const terminate = () => { cancellation.abort(); child.kill('SIGTERM'); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    return await withMachineLease(resource, async () => {
      child.stdin!.end('start');
      return done;
    }, true, child.pid, cancellation.signal);
  } finally {
    child.stdin!.end();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    await done;
  }
}
