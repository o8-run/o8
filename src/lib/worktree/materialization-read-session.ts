import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, type ExecFileOptions } from '@/lib/providers/child-process';
import path from 'node:path';

import type { WorktreeMaterializationIdentity } from './materialization-identity';
import { WORKSPACE_IDENTITY_CHECK } from './materialization-guard-script';
import { PINNED_WORKSPACE_PATH_SCRIPT, PINNED_WORKSPACE_READ_SCRIPT } from './materialization-read-script';

// Only these exact read commands may share the captured-cwd reader. Writes,
// arbitrary scripts, custom environments, and cancellation retain their runner.
const GIT_READ_ARGUMENTS = [
  ['rev-parse', '--git-common-dir'],
  ['rev-parse', '--absolute-git-dir'],
  ['rev-parse', '--show-toplevel'],
  ['rev-parse', '--verify', 'HEAD^{commit}'],
  ['branch', '--show-current'],
  ['symbolic-ref', '--quiet', '--short', 'HEAD'],
];
const gitReads = new Set(GIT_READ_ARGUMENTS.map(args => JSON.stringify(args)));
const READ_SERVER = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
${PINNED_WORKSPACE_PATH_SCRIPT}
${PINNED_WORKSPACE_READ_SCRIPT}
const gitReads = new Set(${JSON.stringify([...gitReads])});
process.on('disconnect', () => process.exit(0));
process.on('message', async (request) => {
  const { id, workspacePath, identity: expected, operation, args, timeout, maxBuffer } = request;
  try {
    // Re-enter through the supplied namespace for EVERY request. Never retain
    // authority from an earlier read, including reads of another workspace.
    process.chdir(workspacePath);
    ${WORKSPACE_IDENTITY_CHECK}
    process.env.PWD = canonicalPath;
    let receipt;
    if (operation === 'git-read' && gitReads.has(JSON.stringify(args))) {
      const result = cp.spawnSync('git', args, { encoding: 'utf8', timeout, maxBuffer,
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      receipt = { code: result.status ?? result.error?.code,
        stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
      if (result.error || result.status !== 0) {
        receipt.error = result.error?.message || 'Pinned workspace Git read failed.';
        receipt.signal = result.signal;
      }
    } else if (operation === 'read' || operation === 'inspect-entry') {
      receipt = await readPinnedEntry(operation, ...args);
    } else throw new Error('Pinned workspace read operation is unsupported.');
    process.send({ id, ...receipt });
  } catch (error) {
    process.send({ id, error: error.message });
  }
});
`;

interface ReadReceipt { code: number; stdout: string; stderr?: string }
interface Session {
  reader?: ReturnType<typeof createReader>;
  closed: boolean;
}
const sessions = new AsyncLocalStorage<Session>();

function createReader(workspacePath: string) {
  const child = spawn(process.execPath, ['-e', READ_SERVER, 'pinned-read-session'], {
    cwd: workspacePath, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
  let stderr = '';
  let failure: Error | undefined;
  let rejectPending: ((error: Error) => void) | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let sequence = 0;
  child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-65_536); });
  const fail = (error: Error) => { failure = error; rejectPending?.(error); };
  // Node 22 may omit ChildProcess.close after a parent-initiated IPC
  // disconnect. Observe the process exit AND the drained stderr pipe instead.
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', resolve);
    child.once('error', (error) => {
      fail(error);
      if (!child.pid) resolve(null);
    });
  });
  const drained = new Promise<void>((resolve) => child.stderr!.once('close', resolve));
  const closed = Promise.all([exited, drained]).then(([code]) => {
    fail(Object.assign(new Error(stderr.trim() || 'Pinned workspace reader closed before its receipt.'), { code }));
  });
  return {
    request(input: Record<string, unknown>): Promise<ReadReceipt> {
      const pending = tail.then(() => new Promise<ReadReceipt>((resolve, reject) => {
        if (failure) { reject(failure); return; }
        const id = ++sequence;
        const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); rejectPending = undefined; };
        const refuse = (error: Error) => { cleanup(); reject(error); };
        const onMessage = (message: unknown) => {
          const receipt = message as ReadReceipt & { id?: number; error?: string };
          if (receipt.id !== id) return;
          cleanup();
          if (receipt.error) reject(Object.assign(new Error(receipt.error), receipt));
          else resolve(receipt);
        };
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          refuse(new Error('Pinned workspace read deadline exceeded.'));
        }, Math.max(10_000, Number(input.timeout ?? 0) + 5_000));
        rejectPending = refuse;
        child.on('message', onMessage);
        child.send({ id, ...input }, (error) => { if (error) refuse(error); });
      }));
      tail = pending.catch(() => undefined);
      return pending;
    },
    async close() {
      await tail;
      if (child.connected) child.disconnect();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      try { await closed; } finally { clearTimeout(timer); }
    },
  };
}

/** One lazy reader per launch, settled before binding; no cached read results. */
export async function withPinnedWorkspaceReadSession<T>(operation: () => Promise<T>): Promise<T> {
  if (sessions.getStore()?.closed === false) return operation();
  const session: Session = { closed: false };
  try { return await sessions.run(session, operation); }
  finally {
    session.closed = true;
    await session.reader?.close();
  }
}

/** Settle this launch's exact reader before requiring a quiescent workspace. */
export async function settlePinnedWorkspaceReadSession(): Promise<void> {
  const session = sessions.getStore();
  if (!session || session.closed) return;
  session.closed = true;
  await session.reader?.close();
}

export function tryPinnedWorkspaceRead(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  operation: 'read' | 'inspect-entry' | 'git-read',
  args: readonly string[],
  options: { timeout?: number; maxBuffer?: number } = {},
): Promise<ReadReceipt> | null {
  const session = sessions.getStore();
  // Background publication can inherit the async context after launch returns.
  // It must fall back to a fresh runner rather than reuse a closed reader.
  if (!session || session.closed) return null;
  session.reader ??= createReader(workspacePath);
  return session.reader.request({ workspacePath: path.resolve(workspacePath), identity, operation, args, ...options });
}

export function tryPinnedWorkspaceGitRead(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> | null {
  if (!gitReads.has(JSON.stringify(args))
    || Object.keys(options).some(key => !['cwd', 'timeout', 'maxBuffer', 'windowsHide'].includes(key))) return null;
  const pending = tryPinnedWorkspaceRead(workspacePath, identity, 'git-read', args, {
    timeout: options.timeout ?? 0, maxBuffer: options.maxBuffer ?? 1024 * 1024,
  });
  return pending?.then(receipt => ({ stdout: receipt.stdout, stderr: receipt.stderr ?? '' })) ?? null;
}
