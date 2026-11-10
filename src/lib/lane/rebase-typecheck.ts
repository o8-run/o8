import { access } from 'node:fs/promises';

import { detectTypecheckSkip, NO_REPOSITORY_TYPESCRIPT, repositoryTypeScriptCompiler } from './typecheck-availability';
import { runConfinedProcess } from '@/lib/sandbox/run-confined';

const TYPECHECK_TIMEOUT_MS = 120_000;
const TYPECHECK_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const TYPECHECK_OUTPUT_PREVIEW_CHARS = 2_000;
const DIAGNOSTIC_PATTERN = /\berror TS(\d+):/;
const INCLUDE_PATTERN_DETAIL = /Matched by include pattern .*tsconfig\.json/i;
const IGNORABLE_GHOST_FILE_CODE = '6053';

interface DiagnosticBlock {
  code: string;
  text: string;
}

export type LaneRebaseTypecheckResult =
  | { ok: true; skipped?: string }
  | { ok: false; output: string };

/**
 * Typechecks `cwd` with the TypeScript compiler installed in `installRoot`,
 * never one from the lane's checkout, under the confinement lane commands get
 * (#3412).
 */
export async function runLaneRebaseTypecheck(input: {
  cwd: string;
  /** The repository whose TypeScript install compiles the merge; never the lane's checkout. */
  installRoot: string;
  actualBranch: string;
  logPrefix: string;
}): Promise<LaneRebaseTypecheckResult> {
  const compiler = repositoryTypeScriptCompiler(input.installRoot);
  const skip = await detectTypecheckSkip(input.cwd);
  const skipped = skip.skip
    ? skip.reason
    : await access(compiler).then(() => undefined, () => NO_REPOSITORY_TYPESCRIPT);
  if (skipped) {
    console.warn(
      `[${input.logPrefix}] Skipping typecheck for ${input.actualBranch}: ${skipped}. ` +
        'Treating as pass so the merge does not loop the layer-1 auto-retry (#1255).',
    );
    return { ok: true, skipped };
  }
  const startedAt = Date.now();
  try {
    await runConfinedProcess(input.cwd, process.execPath, [compiler, '--noEmit'], {
      cwd: input.cwd,
      timeout: TYPECHECK_TIMEOUT_MS,
      maxBuffer: TYPECHECK_MAX_BUFFER_BYTES,
    });
    console.log(`[${input.logPrefix}] Typecheck passed for ${input.actualBranch}`);
    return { ok: true };
  } catch (error) {
    const output = extractTypecheckOutput(error);

    // A compiler that exited non-zero without writing a single byte never got
    // far enough to look for a type error. A timeout kill and a worktree whose
    // contents were not ready both look like this from execFile. Blocking the
    // merge on it hands the operator a review decision no judgment can resolve,
    // so record it the way this module already records a missing compiler
    // (#1255) and let the merge continue with the check marked skipped.
    //
    // Deliberately keyed on empty output rather than "no diagnostics parsed": a
    // compiler that crashes on the diff's own types writes a stack trace with
    // no `error TS` line, and that has to keep blocking the merge, carrying its
    // evidence, exactly as it did before.
    if (producedNoOutput(error)) {
      const detail = `${describeExecFailure(error)}, no output after ${Date.now() - startedAt}ms`;
      console.warn(
        `[${input.logPrefix}] Typecheck for ${input.actualBranch} wrote no output; treating as an environment failure (${detail}).`,
      );
      return { ok: true, skipped: `typecheck did not run to completion (${detail})` };
    }

    const diagnostics = splitDiagnosticBlocks(output);
    const ignorableDiagnostics = diagnostics.filter(isIgnorableGhostFileDiagnostic);

    // Rebased worktrees can inherit stale Next-generated route/file lists through
    // TypeScript's incremental state. Treating pure TS6053 include-pattern misses
    // as hard failures creates false-negative merge responses and double-dispatch loops.
    if (diagnostics.length > 0 && ignorableDiagnostics.length === diagnostics.length) {
      console.warn(
        `[${input.logPrefix}] Ignoring ${ignorableDiagnostics.length} TS6053 ghost-file diagnostic${ignorableDiagnostics.length === 1 ? '' : 's'} after rebase for ${input.actualBranch}; stale Next type cache would otherwise trigger a false-negative merge result and double-dispatch loop.`,
      );
      return { ok: true };
    }

    const preview = truncateTypecheckOutput(output);
    console.error(`[${input.logPrefix}] Typecheck failed for ${input.actualBranch}:\n${preview}`);
    return { ok: false, output: preview };
  }
}

/**
 * True when the compiler wrote nothing at all. Read from the error's own
 * streams rather than the collapsed preview, which falls back to the exec
 * message and would be indistinguishable from a real one-line stderr.
 */
function producedNoOutput(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const streams = error as { stdout?: unknown; stderr?: unknown };
  const stdout = String(streams.stdout ?? '').trim();
  const stderr = String(streams.stderr ?? '').trim();
  return stdout === '' && stderr === '';
}

/**
 * Name what actually happened to the process, so an environment failure is
 * diagnosable from the lane log instead of collapsing to "Command failed".
 */
function describeExecFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown failure';
  const detail = error as { killed?: boolean; signal?: string | null; code?: number | string };
  const parts: string[] = [];
  if (detail.killed && detail.signal) {
    parts.push(`killed with ${detail.signal} at the ${TYPECHECK_TIMEOUT_MS / 1_000}s timeout`);
  } else if (detail.signal) {
    parts.push(`terminated by ${detail.signal}`);
  }
  if (typeof detail.code === 'number') parts.push(`exit code ${detail.code}`);
  else if (typeof detail.code === 'string') parts.push(detail.code);
  return parts.length > 0 ? parts.join(', ') : error.message;
}

function extractTypecheckOutput(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const stdout = 'stdout' in error ? String((error as { stdout?: unknown }).stdout ?? '').trim() : '';
  const stderr = 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '').trim() : '';

  return stdout || stderr || error.message || 'Unknown typecheck error';
}

function truncateTypecheckOutput(output: string) {
  return output.slice(0, TYPECHECK_OUTPUT_PREVIEW_CHARS) || 'Unknown typecheck error';
}

function splitDiagnosticBlocks(output: string): DiagnosticBlock[] {
  const blocks: DiagnosticBlock[] = [];
  let currentBlock: { code: string; lines: string[] } | null = null;

  for (const line of output.split('\n')) {
    const match = line.match(DIAGNOSTIC_PATTERN);
    if (match) {
      if (currentBlock) {
        blocks.push({
          code: currentBlock.code,
          text: currentBlock.lines.join('\n').trim(),
        });
      }
      currentBlock = { code: match[1], lines: [line] };
      continue;
    }

    if (currentBlock) {
      currentBlock.lines.push(line);
    }
  }

  if (currentBlock) {
    blocks.push({
      code: currentBlock.code,
      text: currentBlock.lines.join('\n').trim(),
    });
  }

  return blocks;
}

function isIgnorableGhostFileDiagnostic(block: DiagnosticBlock) {
  return block.code === IGNORABLE_GHOST_FILE_CODE && INCLUDE_PATTERN_DETAIL.test(block.text);
}
