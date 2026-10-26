import { execFile } from '@/lib/providers/child-process';
import { childEnvironment } from '@/lib/providers/spawn-environment';
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { pathWithNodeRuntime } from '@/lib/util/node-on-path';
import { getDataDir } from '@/lib/data-dir-migration';
import { ensureWorkerCliDirectory, pinWorkerCliFiles } from './worker-o8-cli-integrity';
import type { OwnedSessionRecord } from './types';
import packageJson from '../../../../../package.json';

const execFileAsync = promisify(execFile);
const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

async function sourceCheckoutRoot(): Promise<string> {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      await access(path.join(directory, 'cli', 'esbuild.config.mjs'));
      await access(path.join(directory, 'src', 'lib', 'runtimes', 'shared', 'owned-session', 'run-controller.ts'));
      return directory;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) throw new WorkerO8CliUnavailableError('The running application source checkout could not be located. Start the service from a supported checkout.');
      directory = parent;
    }
  }
}

export class WorkerO8CliUnavailableError extends Error {
  constructor(reason: string) {
    super(`o8_cli_unavailable: ${reason} Worker launch is held before packet work.`);
    this.name = 'WorkerO8CliUnavailableError';
  }
}

export interface PreparedWorkerO8Cli {
  binDir: string; readPaths: string[]; immutablePaths: string[]; immutableAncestorPaths: string[]; assertCurrent(): void;
}

/** Build from the running source checkout into protected application storage. */
export async function prepareWorkerO8Cli(session: OwnedSessionRecord, runId: string): Promise<PreparedWorkerO8Cli | null> {
  if (!session.packetId || session.executionPolicy !== undefined) return null;
  const cliRoot = path.join(path.resolve(getDataDir({ ...process.env })), 'worker-cli');
  const binDir = path.join(cliRoot, runId);
  const env = childEnvironment({ env: { PATH: pathWithNodeRuntime() } });
  const bundle = path.join(binDir, 'o8.mjs');
  let source: 'source' | 'packaged';
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid CLI run identity.');
    ensureWorkerCliDirectory(cliRoot);
    await mkdir(binDir, { mode: 0o700 });
    ensureWorkerCliDirectory(binDir);
    if (process.env.O8_PACKAGED_APP) {
      source = 'packaged';
      const serverDir = process.env.O8_BUNDLED_MCP_DIR
        || (process.env.O8_BUNDLED_MCP_PATH ? path.dirname(process.env.O8_BUNDLED_MCP_PATH) : path.dirname(fileURLToPath(import.meta.url)));
      await copyFile(path.join(serverDir, 'bin', 'o8.mjs'), bundle, constants.COPYFILE_EXCL);
    } else {
      source = 'source';
      const sourceRoot = await sourceCheckoutRoot();
      await execFileAsync(process.execPath, [path.join(sourceRoot, 'cli', 'esbuild.config.mjs'), '--worker-output', bundle], {
        cwd: sourceRoot, env, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true,
      });
    }
    const entry = path.join(binDir, process.platform === 'win32' ? 'o8.cmd' : 'o8');
    const cmdQuote = (value: string) => `"${value.replace(/%/g, '%%')}"`;
    const wrapper = process.platform === 'win32'
      ? `@echo off\r\n${cmdQuote(process.execPath)} ${cmdQuote(bundle)} %*\r\n`
      : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(bundle)} "$@"\n`;
    await writeFile(entry, wrapper, { mode: 0o700, flag: 'wx' });
    const code = pinWorkerCliFiles([bundle, entry]);
    const invocation = cliInvocation(entry, ['--help']);
    const { stdout } = await execFileAsync(invocation.command, invocation.args, {
      cwd: session.repoPath, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 512 * 1024, windowsHide: true,
    });
    code.assertCurrent();
    if (!stdout.includes('packet info') || !stdout.includes('packet commit')) {
      throw new WorkerO8CliUnavailableError('The selected CLI lacks supported packet info and packet commit commands. Rebuild the current application CLI.');
    }
    const versionInvocation = cliInvocation(entry, ['version', '--offline']);
    const version = JSON.parse((await execFileAsync(versionInvocation.command, versionInvocation.args, {
      cwd: session.repoPath, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true,
    })).stdout) as { schema?: unknown; cliVersion?: unknown };
    code.assertCurrent();
    if (version.schema !== 'o8/cli/version/v1' || version.cliVersion !== packageJson.version) {
      throw new WorkerO8CliUnavailableError('The selected CLI does not match the running application version. Rebuild or repair the current application CLI.');
    }
    const receipt = path.join(binDir, 'verification.json');
    await writeFile(receipt, JSON.stringify({ source, verified: true,
      version: version.cliVersion,
      sha256: code.sha256[0] }) + '\n', { mode: 0o600, flag: 'wx' });
    code.assertCurrent();
    const evidence = pinWorkerCliFiles([receipt]);
    return { binDir, readPaths: [binDir, entry, bundle, process.execPath], immutablePaths: [cliRoot],
      immutableAncestorPaths: code.ancestorPaths,
      assertCurrent() {
        try { code.assertCurrent(); evidence.assertCurrent(); }
        catch { throw new WorkerO8CliUnavailableError('The verified CLI files or storage path changed during launch. Retry with protected, non-symlink application storage.'); }
      } };
  } catch (error) {
    if (error instanceof WorkerO8CliUnavailableError) throw error;
    throw new WorkerO8CliUnavailableError('The current application CLI could not be built or verified. Use protected, non-symlink application storage; run npm run build:cli in the application checkout, or repair the packaged CLI, then retry.');
  }
}
