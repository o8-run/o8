import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import type { OwnedChildExitOutcome } from './types';

const DEFAULT_STDERR_TAIL_BYTES = 500;

export function classifyChildExit(
  code: number | null,
  signal: NodeJS.Signals | null,
): OwnedChildExitOutcome['classification'] {
  if (signal) return 'signal-kill';
  if (code === 0) return 'clean-exit';
  return 'nonzero-exit';
}

export function childExitOutcome(
  code: number | null,
  signal: NodeJS.Signals | null,
): OwnedChildExitOutcome {
  return {
    code,
    signal,
    classification: classifyChildExit(code, signal),
  };
}

/** Operator-facing text for a worker that exited 0 without any output. */
export function silentCleanExitMessage(humanLabel: string): string {
  return `${humanLabel} exited without producing any output, so no work was done. Retry the worker; if it keeps happening, check that its CLI is installed and signed in.`;
}

export async function readAbnormalStderrTail(
  stderrPath: string,
  outcome: OwnedChildExitOutcome,
  maxBytes = DEFAULT_STDERR_TAIL_BYTES,
): Promise<string | undefined> {
  if (outcome.classification === 'clean-exit') return undefined;
  const raw = await readFile(stderrPath).catch(() => null);
  if (!raw?.length) return undefined;
  const start = Math.max(0, raw.length - maxBytes);
  return raw.subarray(start).toString('utf8');
}

export function observeChildExit(
  child: ChildProcess,
  onClose: (outcome: OwnedChildExitOutcome) => void,
): void {
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;

  child.once('exit', (code, signal) => {
    exitCode = code;
    exitSignal = signal;
  });
  child.once('close', (code, signal) => {
    onClose(childExitOutcome(code ?? exitCode, signal ?? exitSignal));
  });
}
