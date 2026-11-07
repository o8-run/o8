import { spawn, execFile, execFileReadOnly, type ChildProcess, type ExecFileOptions } from '@/lib/providers/child-process';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { resolveGitBinary } from '@/lib/git/binary';
import { EMBEDDED_CHILD_POLICY_SCRIPT } from '@/lib/providers/embedded-child-policy';

import { probeMetadataLockProcessIdentity, type MetadataLockProcessIdentity } from './metadata-lock-process-identity';

import type { WorktreeMaterializationIdentity } from './materialization-identity';
import { WORKSPACE_IDENTITY_CHECK } from './materialization-guard-script';
import { tryPinnedWorkspaceGitRead } from './materialization-read-session';

const materializationContext = new AsyncLocalStorage<ReadonlyMap<string, WorktreeMaterializationIdentity>>();

const WORKSPACE_EXEC_GUARD = EMBEDDED_CHILD_POLICY_SCRIPT + String.raw`
const fs = require('node:fs');
const path = require('node:path');
const expected = JSON.parse(process.argv[1]);
let command = process.argv[2];
const args = process.argv.slice(3);
${WORKSPACE_IDENTITY_CHECK}
if (!command.includes(path.sep)) {
  const match = (process.env.PATH || '').split(path.delimiter)
    .map((entry) => path.join(entry, command))
    .find((entry) => { try { fs.accessSync(entry, fs.constants.X_OK); return true; } catch { return false; } });
  if (!match) throw new Error('Managed workspace command could not be resolved.');
  command = match;
}
process.env.PWD = canonicalPath;
withO8ChildPolicy(env => process.execve(command, [command, ...args], env), { preserveStamp: expected.preserveCredentialPolicy });
`;

const MATERIALIZATION_REFUSAL_EXIT_CODE = 78;

export function isMaterializationExecutionRefusal(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && Number((error as NodeJS.ErrnoException).code) === MATERIALIZATION_REFUSAL_EXIT_CODE;
}

export function guardedWorkspaceInvocation(
  command: string,
  args: string[],
  identity: WorktreeMaterializationIdentity | null,
): { command: string; args: string[] } {
  if (command === 'git') command = resolveGitBinary();
  if (!identity) return { command, args };
  return {
    command: process.execPath,
    args: ['-e', WORKSPACE_EXEC_GUARD, JSON.stringify({ ...identity, preserveCredentialPolicy: true }), command, ...args],
  };
}

/** Run a controlled script after the captured-cwd guard, without another Node startup. */
export function guardedWorkspaceScriptInvocation(
  script: string,
  args: string[],
  identity: WorktreeMaterializationIdentity,
): { command: string; args: string[] } {
  const guardedScript = String.raw`
{
  const fs = require('node:fs');
  const expected = JSON.parse(process.argv[1]);
  ${WORKSPACE_IDENTITY_CHECK}
  process.env.PWD = canonicalPath;
  process.argv.splice(1, 1);
}
${script}
`;
  return {
    command: process.execPath,
    args: ['-e', guardedScript, JSON.stringify(identity), ...args],
  };
}

export const guardedWorkspaceReadScriptInvocation = guardedWorkspaceScriptInvocation;

export function withWorktreeMaterializationExecution<T>(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  operation: () => Promise<T>,
): Promise<T> {
  const next = new Map(materializationContext.getStore() ?? []);
  next.set(path.resolve(workspacePath), identity);
  return materializationContext.run(next, operation);
}

/** The invocation that refuses a replaced workspace at `cwd`, when one is being materialized there. */
export function materializationAwareInvocation(
  command: string,
  args: readonly string[],
  cwd: string | URL | undefined,
): { command: string; args: string[] } {
  const resolved = typeof cwd === 'string' ? path.resolve(cwd) : null;
  const identity = resolved ? materializationContext.getStore()?.get(resolved) ?? null : null;
  return guardedWorkspaceInvocation(command, [...args], identity);
}

/** Execute against the OS-captured cwd, refusing a replacement before exec. */
export function materializationAwareExecFile(
  command: string,
  args: readonly string[],
  options: ExecFileOptions & { cwd?: string | URL; readOnly?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
  // `readOnly` opts a credential-less git read (worktree list, status/diff --name-only) onto the
  // read-only boundary so it never takes .provider-keys.lock. It is defaulted off and stripped
  // before the options reach execFile or tryPinnedWorkspaceGitRead (which rejects unknown keys).
  const { readOnly = false, ...fileOptions } = options;
  const resolved = typeof fileOptions.cwd === 'string' ? path.resolve(fileOptions.cwd) : null;
  const identity = resolved ? materializationContext.getStore()?.get(resolved) : null;
  if (command === 'git' && identity && resolved) {
    const pending = tryPinnedWorkspaceGitRead(resolved, identity, args, fileOptions);
    if (pending) return pending;
  }
  const invocation = materializationAwareInvocation(command, args, fileOptions.cwd);
  const runExecFile = readOnly ? execFileReadOnly : execFile;
  return new Promise((resolve, reject) => {
    const { signal, ...execOptions } = fileOptions;
    let child: ChildProcess | null = null;
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const abort = () => {
      if (settled) return;
      child?.kill();
      settled = true;
      cleanup();
      const error = new Error('The operation was aborted.', { cause: signal?.reason });
      error.name = 'AbortError';
      Object.assign(error, { code: 'ABORT_ERR' });
      reject(error);
    };
    child = runExecFile(invocation.command, invocation.args, execOptions, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stdoutText = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout;
      const stderrText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr;
      if (error) {
        Object.assign(error, { stdout: stdoutText, stderr: stderrText });
        reject(error);
      } else {
        resolve({ stdout: stdoutText, stderr: stderrText });
      }
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

export interface MaterializationWriterClose {
  pid: number;
  processIdentity: MetadataLockProcessIdentity | null;
  role: 'wrapper' | 'nested';
  observedClose: boolean;
  code: number | null;
  signal: string | null;
}

export interface MaterializationExecutionSettlement {
  stdout: string;
  stderr: string;
  writers: MaterializationWriterClose[];
  stopRequested: boolean;
  /** Includes the wrapper's completed child inventory, not just its exit. */
  settled: boolean;
  ok: boolean;
  reason: string | null;
}

// The same ready/identity/ack discipline as generated-output-bank-io. This
// opt-in runner is only for controlled preservation scripts. Child stdout is
// data, never a receipt. IPC gates each nested exec before it can do work.
const NESTED_EXEC_GATE = EMBEDDED_CHILD_POLICY_SCRIPT + String.raw`
const input = JSON.parse(process.argv[1]);
process.once('message', async message => {
  if (message.phase !== 'run') return;
  process.disconnect();
  try {
    if (input.identity) {
      const fs = require('node:fs');
      const actual = fs.lstatSync('.');
      if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== input.identity.device
        || actual.ino !== input.identity.inode || fs.realpathSync('.') !== input.identity.canonicalPath) {
        throw new Error('Managed workspace ownership changed before nested execution.');
      }
      process.env.PWD = input.identity.canonicalPath;
    }
    if (input.nodeScript) {
      process.argv[1] = JSON.stringify(input.payload);
      await new (Object.getPrototypeOf(async function() {}).constructor)('require', input.nodeScript)(require);
    } else withO8ChildPolicy(env => process.execve(input.command, [input.command, ...input.args], env), { preserveStamp: input.preserveCredentialPolicy });
  } catch (error) { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; }
});
process.send({ phase: 'ready' });
`;

const SETTLED_NODE_RUNNER = EMBEDDED_CHILD_POLICY_SCRIPT + String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const input = JSON.parse(process.argv[1]);
const nested = new Map();
function send(value) { if (process.connected) process.send(value); }
process.on('message', message => {
  if (message.phase === 'nested-run') nested.get(message.pid)?.send({ phase: 'run' });
});
const gate = ${JSON.stringify(NESTED_EXEC_GATE)};
async function runChild(command, args, options = {}) {
  if (!require('node:path').isAbsolute(command)) {
    command = (process.env.PATH || '').split(require('node:path').delimiter)
      .map(entry => require('node:path').join(entry, command))
      .find(entry => { try { fs.accessSync(entry, fs.constants.X_OK); return true; } catch { return false; } });
    if (!command) throw new Error('Preservation child command could not be resolved.');
  }
  // All preservation commands are resolved by the existing caller; the gate
  // must preserve the process identity recorded before execve.
  const child = withO8ChildPolicy(env => spawn(process.execPath, ['-e', gate, JSON.stringify({ command, args, nodeScript: options.nodeScript, payload: options.payload, identity: options.identity, preserveCredentialPolicy: true })], {
    cwd: options.cwd || process.cwd(), env,
    stdio: ['ignore', 'pipe', 'pipe', ...(options.fd === undefined ? [] : [options.fd]), 'ipc'], windowsHide: true,
  }), { preserveStamp: true });
  nested.set(child.pid, child);
  let error;
  const closed = new Promise(resolve => {
    child.once('error', value => { error = value; });
    child.once('close', (code, signal) => {
      send({ phase: 'nested-close', pid: child.pid, code, signal });
      nested.delete(child.pid);
      resolve({ code, signal, error });
    });
  });
  child.on('message', message => {
    if (message.phase === 'ready') send({ phase: 'nested-ready', pid: child.pid });
  });
  child.stdout.on('data', chunk => {
    if (error) return;
    try { if (options.stdout) options.stdout(chunk); else process.stdout.write(chunk); }
    catch (value) { error = value; child.kill('SIGTERM'); }
  });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  const result = await closed;
  if (result.error || result.code !== 0 || result.signal) {
    throw new Error('Preservation child failed: ' + (result.signal || result.code || result.error?.message));
  }
}
const stop = () => { for (const child of nested.values()) child.kill('SIGTERM'); };
process.on('SIGTERM', stop);
process.on('disconnect', stop);
process.once('message', async message => {
  if (message.phase !== 'run') return;
  let failure;
  try {
    const actual = fs.lstatSync('.');
    if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== input.identity.device
      || actual.ino !== input.identity.inode || fs.realpathSync('.') !== input.identity.canonicalPath) {
      throw new Error('Managed workspace ownership changed before settled execution.');
    }
    const execute = new (Object.getPrototypeOf(async function() {}).constructor)('require', 'runChild', input.script);
    process.argv[1] = JSON.stringify(input.payload);
    await execute(require, runChild);
  } catch (error) { failure = error; process.stderr.write(String(error.message) + '\n'); }
  // A returned script alone is insufficient if it left a child outstanding.
  if (nested.size === 0) send({ phase: 'chain-complete', ok: !failure });
  process.exitCode = failure ? 1 : 0;
  if (nested.size === 0) {
    process.removeListener('SIGTERM', stop);
    process.removeListener('disconnect', stop);
    if (process.connected) process.disconnect();
  }
});
send({ phase: 'ready', pid: process.pid });
`;

/** Bounded same-attempt settlement. A stop request never substitutes for close.
 * This does not infer closure after restart or promise arbitrary descendant
 * cleanup. Interrupted nested commands keep the whole chain unproved. */
export async function materializationAwareNodeSettlement(input: {
  script: string;
  payload?: unknown;
  identity: WorktreeMaterializationIdentity;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  closeWaitMs?: number;
  signal?: AbortSignal;
  maxBuffer?: number;
  /** Called before the corresponding writer is acknowledged. */
  onWriter?: (writer: MaterializationWriterClose) => Promise<void>;
}): Promise<MaterializationExecutionSettlement> {
  const child = spawn(process.execPath, ['-e', SETTLED_NODE_RUNNER, JSON.stringify({ script: input.script, payload: input.payload, identity: input.identity })], {
    cwd: input.identity.canonicalPath, env: input.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const writers: MaterializationWriterClose[] = child.pid ? [{ pid: child.pid, processIdentity: null,
    role: 'wrapper', observedClose: false, code: null, signal: null }] : [];
  let stdout = ''; let stderr = ''; let reason: string | null = null;
  let stopRequested = false; let chainComplete = false; let chainOk = false;
  let ended = false; let returned = false; let messages = Promise.resolve();
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  let grace: ReturnType<typeof setTimeout> | undefined;
  const stop = (detail: string) => {
    reason ??= detail;
    if (stopRequested || ended) return;
    stopRequested = true;
    child.kill('SIGTERM');
    grace = setTimeout(finish, input.closeWaitMs ?? 2_000);
  };
  const abort = () => stop('Preservation execution cancellation requested.');
  const timeout = setTimeout(() => stop('Preservation execution deadline exceeded.'), input.timeoutMs ?? 125_000);
  const append = (chunk: Buffer, target: 'stdout' | 'stderr') => {
    const limit = input.maxBuffer ?? 1024 * 1024;
    if (Buffer.byteLength(target === 'stdout' ? stdout : stderr) + chunk.length > limit) {
      stop('Preservation child output exceeded its bound.'); return;
    }
    if (target === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
  };
  child.stdout!.on('data', chunk => append(chunk, 'stdout'));
  child.stderr!.on('data', chunk => append(chunk, 'stderr'));
  child.on('error', error => { reason ??= error.message; });
  child.on('message', value => {
    messages = messages.then(async () => {
      if (ended || returned) return;
      const message = value as { phase?: string; pid?: number; code?: number | null; signal?: string | null; ok?: boolean };
      if (message.phase === 'ready' || message.phase === 'nested-ready') {
        const pid = message.pid;
        if (!Number.isSafeInteger(pid) || !pid || writers.some(writer => writer.pid === pid && (writer.role !== 'wrapper' || writer.processIdentity !== null))
          || writers.length >= 8 || (message.phase === 'ready' && pid !== child.pid)) {
          throw new Error('Preservation writer identity sequence is invalid.');
        }
        const writer: MaterializationWriterClose = writers.find(entry => entry.pid === pid) ?? {
          pid, processIdentity: null, role: 'nested', observedClose: false, code: null, signal: null,
        };
        if (!writers.includes(writer)) writers.push(writer);
        if (stopRequested) return;
        const probe = await probeMetadataLockProcessIdentity(pid);
        if (probe.state !== 'live') throw new Error('Preservation writer process identity is unproved.');
        if (returned) return;
        writer.processIdentity = probe.identity;
        await input.onWriter?.({ ...writer });
        if (!ended && !stopRequested && child.connected) child.send({ phase: writer.role === 'wrapper' ? 'run' : 'nested-run', pid });
      } else if (message.phase === 'nested-close') {
        const writer = writers.find(entry => entry.pid === message.pid && entry.role === 'nested');
        if (!writer || writer.observedClose || !(message.code === null || Number.isInteger(message.code))
          || !(message.signal === null || typeof message.signal === 'string')) throw new Error('Preservation nested close is unproved.');
        writer.observedClose = true; writer.code = message.code!; writer.signal = message.signal!;
      } else if (message.phase === 'chain-complete') {
        if (chainComplete || typeof message.ok !== 'boolean') throw new Error('Preservation completion sequence is invalid.');
        chainComplete = true; chainOk = message.ok;
      } else throw new Error('Preservation child receipt is invalid.');
    }).catch(error => stop(error.message));
  });
  child.once('close', (code, signal) => {
    messages = messages.then(() => {
      const writer = writers.find(entry => entry.role === 'wrapper');
      if (writer) { writer.observedClose = true; writer.code = code; writer.signal = signal; }
      ended = true;
      finish();
    });
  });
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  await done;
  returned = true;
  clearTimeout(timeout); if (grace) clearTimeout(grace);
  input.signal?.removeEventListener('abort', abort);
  const settled = ended && chainComplete && writers.length > 0
    && writers.every(writer => writer.processIdentity !== null && writer.observedClose && writer.signal === null);
  if (!settled) reason ??= 'Preservation writer closure or completed child inventory is unproved.';
  else if (!chainOk || writers.some(writer => writer.code !== 0)) reason ??= 'Preservation execution failed after observed writer closure.';
  // Return immutable facts at this deadline, never mutate a receipt after handoff.
  return { stdout, stderr, writers: writers.map(writer => ({ ...writer })), stopRequested,
    settled, ok: settled && chainOk && !reason, reason };
}
