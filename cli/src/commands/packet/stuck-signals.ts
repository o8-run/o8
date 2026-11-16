/**
 * Signs that a following pane's worker is stuck without asking for anything.
 *
 * A worker that waits on a person says so through its lane, and the pane
 * already marks that. A stuck worker often says nothing. Three patterns cover
 * most of those:
 *
 * - quiet: no transcript event for a while (a hang);
 * - retry loop: the same command fails the same way several times;
 * - edit loop: the same file is edited again and again while the tests fail
 *   the same way each run.
 *
 * Only real progress clears a signal: any new event clears quiet, the command
 * passing or failing differently clears a retry loop, and a test result that
 * changes clears an edit loop. Output alone never resets a count, so a loop
 * cannot clear its own signal by printing. A signal only marks the pane; it
 * never stops the worker.
 */

import { plainText, toolDetail, type TranscriptEvent } from './transcript.js';

/** No event for this long means the worker may be hung. */
export const QUIET_MS = 10 * 60_000;
/** A command still running is allowed longer: builds and full test runs are slow. */
export const QUIET_IN_TOOL_MS = 30 * 60_000;
/** The same command failing the same way this many times is a retry loop. */
export const RETRY_LIMIT = 3;
/** Edits to one file, since the tests last changed, that make an edit loop. */
export const EDIT_LIMIT = 4;
/** Test runs in a row with the same failure that make an edit loop. */
export const FLAT_TEST_RUNS = 3;

export type StuckReason = 'quiet' | 'retry_loop' | 'edit_loop';

export interface StuckSignal {
  reason: StuckReason;
  /** The command or file it is about, for the pane. Never sent in a tab mark. */
  detail: string | null;
}

type ToolCall = Extract<TranscriptEvent, { type: 'tool_call' }>;

const EDIT_TOOLS = /^(edit|multiedit|write|notebookedit|apply_patch|str_replace\w*|create_file|write_file|edit_file|replace)$/i;
const PATCH_FILE = /\*\*\* (?:Add|Update) File: ((?:[^\\"'`\r\n]|\\(?![nr"])[\s\S])+)/g;
const TEST_COMMAND = new RegExp([
  String.raw`\b(?:vitest|jest|pytest|mocha|rspec|phpunit|ava|tap)\b`,
  String.raw`\bplaywright test\b`,
  String.raw`\b(?:cargo|go|swift|dotnet|mix|deno|bun) test\b`,
  String.raw`\b(?:npm|pnpm|yarn)(?: run)? test`,
  String.raw`\bmake (?:test|check)\b`,
  String.raw`\bpython3? -m (?:pytest|unittest)\b`,
].join('|'), 'i');

/** Failure output with numbers taken out, so timings and line counts do not make two failures look different. */
function failureKey(summary: string): string {
  return plainText(summary, 400).replace(/\d+(?:\.\d+)?/g, '#');
}

/** The files a tool call edits. */
export function editedFiles(call: ToolCall): string[] {
  const files = new Set<string>();
  for (const found of call.args.slice(0, 20_000).matchAll(PATCH_FILE)) {
    const file = found[1].trim();
    if (file) files.add(file.split(/[\\/]+/).filter(Boolean).slice(-3).join('/'));
  }
  if (files.size === 0 && EDIT_TOOLS.test(call.tool.trim())) {
    const detail = toolDetail(call);
    if (detail) files.add(detail);
  }
  return [...files];
}

/** Whether a tool call runs a test suite. */
export function runsTests(call: ToolCall): boolean {
  return TEST_COMMAND.test(toolDetail(call)) || TEST_COMMAND.test(call.args.slice(0, 2_000));
}

/**
 * Watches one worker's transcript as a pane follows it. Feed it every event
 * the pane shows, and ask it after each round.
 */
export class StuckWatch {
  private lastEventAt: number;
  private openCall = false;
  private readonly calls = new Map<string, ToolCall>();
  private lastCall: ToolCall | null = null;
  /** Per command: the last failure and how many times in a row it happened. */
  private readonly failures = new Map<string, { key: string; count: number; detail: string }>();
  /** Per file: edits since the test result last changed. */
  private readonly edits = new Map<string, number>();
  private lastTestKey: string | null = null;
  private flatTestRuns = 0;

  constructor(private readonly now: () => number = Date.now) {
    this.lastEventAt = now();
  }

  /** Forget everything, as when the packet is dispatched again. */
  restart(): void {
    this.lastEventAt = this.now();
    this.openCall = false;
    this.calls.clear();
    this.lastCall = null;
    this.failures.clear();
    this.edits.clear();
    this.lastTestKey = null;
    this.flatTestRuns = 0;
  }

  /** Start the quiet clock over, as when a held pane follows again. */
  touch(): void {
    this.lastEventAt = this.now();
  }

  observe(events: readonly TranscriptEvent[]): void {
    for (const event of events) {
      this.lastEventAt = this.now();
      if (event.type === 'tool_call') this.onCall(event);
      else if (event.type === 'tool_result') this.onResult(event);
      // A steer is a person stepping in: what came before no longer counts against the worker.
      else if (event.type === 'steer') this.restart();
      else if (event.type === 'done' || event.type === 'error') this.openCall = false;
    }
  }

  private onCall(call: ToolCall): void {
    this.openCall = true;
    this.lastCall = call;
    if (call.callId) this.calls.set(call.callId, call);
    if (this.calls.size > 500) this.calls.delete(this.calls.keys().next().value as string);
    for (const file of editedFiles(call)) this.edits.set(file, (this.edits.get(file) ?? 0) + 1);
  }

  private onResult(result: Extract<TranscriptEvent, { type: 'tool_result' }>): void {
    this.openCall = false;
    const call = (result.callId ? this.calls.get(result.callId) : undefined) ?? this.lastCall;
    if (!call) return;
    const detail = toolDetail(call);
    const command = `${call.tool}\u0000${detail}`;
    if (result.ok) {
      this.failures.delete(command);
    } else {
      const key = failureKey(result.summary);
      const previous = this.failures.get(command);
      this.failures.set(command, { key, detail, count: previous?.key === key ? previous.count + 1 : 1 });
    }
    if (runsTests(call)) {
      const testKey = result.ok ? 'pass' : failureKey(result.summary);
      if (result.ok || testKey !== this.lastTestKey) {
        // The tests moved: a new failure, or they pass. Edits since then are progress.
        this.edits.clear();
        this.flatTestRuns = result.ok ? 0 : 1;
      } else {
        this.flatTestRuns += 1;
      }
      this.lastTestKey = testKey;
    }
  }

  /** The strongest sign the worker is stuck now, or `null`. */
  check(): StuckSignal | null {
    // Edits between the runs make this the better account of a failing test run three times.
    if (this.flatTestRuns >= FLAT_TEST_RUNS) {
      let worst: [string, number] | null = null;
      for (const entry of this.edits) if (!worst || entry[1] > worst[1]) worst = entry;
      if (worst && worst[1] >= EDIT_LIMIT) return { reason: 'edit_loop', detail: worst[0] };
    }
    for (const failure of this.failures.values()) {
      if (failure.count >= RETRY_LIMIT) return { reason: 'retry_loop', detail: failure.detail || null };
    }
    const quietFor = this.now() - this.lastEventAt;
    if (quietFor >= (this.openCall ? QUIET_IN_TOOL_MS : QUIET_MS)) return { reason: 'quiet', detail: null };
    return null;
  }
}

/** The fixed phrase a tab mark carries for each signal. It never names a command or a path. */
export const STUCK_MARK: Record<StuckReason, string> = {
  quiet: 'Needs you: no output',
  retry_loop: 'Needs you: same error 3x',
  edit_loop: 'Needs you: edits, tests flat',
};

/** The line the pane prints when a signal starts. */
export function stuckLine(signal: StuckSignal): string {
  const about = signal.detail ? `: ${signal.detail}` : '';
  switch (signal.reason) {
    case 'quiet':
      return 'o8: no output from this worker for a while. It may be hung. It is still running.';
    case 'retry_loop':
      return `o8: the same command failed the same way ${RETRY_LIMIT} times${about}. The worker may be stuck in a loop.`;
    case 'edit_loop':
      return `o8: the worker keeps editing the same file while the tests fail the same way${about}.`;
  }
}
