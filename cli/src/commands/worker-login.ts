import { ambientChildEnvironment } from '../../../src/lib/providers/ambient-environment.js';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CliError, EXIT } from '../api.js';
import { printJson, type OutputMode } from '../output.js';

/** The companion helper owns the private PTY; raw provider output never reaches this process. */
export async function runWorkerLogin(mode: OutputMode, rest: string[]): Promise<number> {
  if (rest.length) throw new CliError('invalid_args', 'Worker login takes no arguments or token values.', EXIT.INVALID_ARGS);
  if (process.env.O8_WORKER_TOKEN || process.env.O8_WORKER_PACKET_ID || process.env.O8_SPECTATOR_TOKEN) {
    throw new CliError('operator_required', 'Dedicated worker login requires an operator terminal.', EXIT.UNAUTHORIZED);
  }
  if (process.platform !== 'darwin') {
    throw new CliError('unsupported_platform', 'Dedicated worker login is currently available on macOS.', EXIT.CONFLICT);
  }
  const helper = join(dirname(realpathSync(process.argv[1]!)), 'worker-login.mjs');
  if (!existsSync(helper)) {
    throw new CliError('worker_login_unavailable', 'This CLI installation is missing its worker login helper.', EXIT.NOT_FOUND,
      'Update the installed app and use its bundled o8 command.');
  }
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [helper], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...ambientChildEnvironment(), NODE_OPTIONS: '',
        // Only this trusted key-storage broker gets the master key. Its provider
        // PTY has a separate allowlist and never receives broker credentials.
        O8_MASTER_KEY: process.env.O8_MASTER_KEY,
        O8_CLAUDE_CODE_BIN: process.env.O8_CLAUDE_CODE_BIN },
    });
    // Only the helper's fixed progress and bounded diagnostic messages are forwarded.
    child.stdout.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    child.once('error', () => resolve(EXIT.CONFLICT));
    child.once('close', (exitCode) => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
      resolve(exitCode === 0 ? EXIT.OK : EXIT.CONFLICT);
    });
  });
  if (code !== EXIT.OK) {
    throw new CliError('worker_login_incomplete', 'Dedicated worker login stopped without a saved-token receipt.', EXIT.CONFLICT);
  }
  if (mode.human) process.stdout.write('Worker token encrypted and saved. Run a worker to verify authentication.\n');
  else printJson({ schema: 'o8/cli/worker-login/v1', saved: true, authenticationVerified: false });
  return EXIT.OK;
}
