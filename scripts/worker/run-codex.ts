import { unprivilegedChildEnvironment } from '../../src/lib/providers/ambient-environment';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolveCodexReasoningEffort } from '../../src/lib/codex/reasoning-effort';
import type { ThinkingEffort } from '../../src/lib/orchestrator/thinking-effort';
import { assertRuntimeEffortPin } from '../../src/lib/orchestrator/effort-pin';
import { codexModelArgs } from '../../src/lib/codex/local-model';

export interface RunCodexOptions { cwd: string; prompt: string; model?: string; effort?: ThinkingEffort; onChunk: (text: string) => Promise<void>; }
export interface RunCodexResult { exitCode: number; stderrTail: string; aborted: boolean; }
export interface RunningCodex { result: Promise<RunCodexResult>; abort: () => void; }

const STDERR_TAIL_LIMIT = 4_000;

function readableEvent(line: string): string | null {
  try {
    const event = JSON.parse(line) as {
      type?: string;
      item?: { type?: string; text?: string; aggregated_output?: string };
      message?: string;
    };
    if (event.type === 'item.completed'
      && event.item?.type === 'agent_message' && typeof event.item.text === 'string') return event.item.text;
    if (event.type === 'item.completed' && event.item?.type === 'command_execution'
      && typeof event.item.aggregated_output === 'string') return event.item.aggregated_output;
    if (event.type === 'error' && typeof event.message === 'string') return event.message;
    return null;
  } catch { return line; }
}

function stopProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === 'win32') { if (child.exitCode === null) child.kill(signal); return; }
  try { process.kill(-child.pid, signal); }
  catch { if (child.exitCode === null) child.kill(signal); }
}

export async function startCodex(opts: RunCodexOptions): Promise<RunningCodex> {
  assertRuntimeEffortPin('cloud', opts.model, opts.effort);
  const codexArgs = ['exec', '--dangerously-bypass-approvals-and-sandbox', '--json'];
  codexArgs.push(...codexModelArgs(opts.model));
  if (opts.effort && opts.effort !== 'adaptive') {
    codexArgs.push('-c', `model_reasoning_effort=${resolveCodexReasoningEffort(opts.effort, opts.model)}`);
  }
  codexArgs.push('-');

  // Codex API billing is unavailable (#4334). The standalone worker uses
  // the shared no-provider policy without depending on the server's SQLite.
  const childEnv = unprivilegedChildEnvironment();
  delete childEnv.O8_CLOUD_WORKER_KEY;
  const child = spawn('codex', codexArgs, { cwd: opts.cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  child.stdin.on('error', () => { /* The child exit/error handler reports a failed invocation. */ });
  child.stdin.end(opts.prompt);
  let aborted = false;
  let stdoutBuffer = '';
  let stderrTail = '';
  let chunkFailure: Error | null = null;
  let sendChain = Promise.resolve();
  let forceKill: ReturnType<typeof setTimeout> | null = null;
  const abort = () => {
    if (aborted) return;
    aborted = true;
    stopProcessTree(child, 'SIGTERM');
    forceKill = setTimeout(() => stopProcessTree(child, 'SIGKILL'), 5_000);
  };
  const emit = (text: string) => {
    if (aborted) return;
    sendChain = sendChain.then(() => opts.onChunk(text)).catch((error: unknown) => {
      chunkFailure = error instanceof Error ? error : new Error(String(error));
      abort();
    });
  };

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf-8');
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      const readable = trimmed ? readableEvent(trimmed) : null;
      if (readable) emit(readable);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail += chunk.toString('utf-8');
    if (stderrTail.length > STDERR_TAIL_LIMIT) stderrTail = stderrTail.slice(-STDERR_TAIL_LIMIT);
  });

  const result = new Promise<RunCodexResult>((resolve, reject) => {
    child.once('error', (error) => reject(error));
    child.once('close', async (code) => {
      if (aborted) stopProcessTree(child, 'SIGKILL');
      if (forceKill) clearTimeout(forceKill);
      try {
        if (!aborted && stdoutBuffer.trim()) {
          const readable = readableEvent(stdoutBuffer.trim());
          if (readable) emit(readable);
        }
        await sendChain;
        if (chunkFailure) throw chunkFailure;
        resolve({ exitCode: code ?? -1, stderrTail, aborted });
      } catch (error) { reject(error); }
    });
  });
  return { result, abort };
}
