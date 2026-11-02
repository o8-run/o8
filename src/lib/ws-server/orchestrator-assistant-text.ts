/**
 * #2142 — the assistant-text buffer for one orchestrator turn, with an explicit
 * discard for a retried attempt.
 *
 * ws-server used to hold this as two bare `let`s declared once per WS message,
 * outside the turn call. The `text` case appended every token to that single
 * buffer with no attempt boundary, so when the false-dispatch retry landed, the
 * discarded attempt's narration and the retry's narration were concatenated into
 * one chat bubble and persisted that way — the operator read two glued-together
 * turns with no separator. Making the buffer an object with a `discard()` gives
 * the attempt boundary somewhere to land, and gives it a test.
 */
export interface AssistantTextBuffer {
  /** Append a streamed token/segment to the CURRENT attempt. */
  /** Adds the chunk and returns what was added, with any separator a new block needs. */
  append(chunk: string): string;
  /** Marks a tool call: the next text starts a new block, not the same sentence. */
  endBlock(): void;
  /**
   * Drop everything the discarded attempt streamed, including the record of
   * what was already written to disk — the caller removes that row separately,
   * and the next persist must not be short-circuited as "unchanged".
   */
  discard(): void;
  /** Text of the current attempt only. */
  readonly value: string;
  /**
   * Whether a persist would write anything new. `hasReceipt` forces the terminal
   * write (token counts / session id land even when the text is unchanged).
   */
  shouldPersist(hasReceipt: boolean): boolean;
  markPersisted(): void;
  /** True once `discard()` has run — the turn had an attempt thrown away. */
  readonly discarded: boolean;
}

/** Saved on a turn the operator stopped, so it never persists as an empty reply (#3659). */
export const OPERATOR_STOPPED_NOTE = 'Stopped by the operator.';

/** Record the operator's Stop at the end of whatever the turn streamed. */
export function appendOperatorStopNote(buffer: AssistantTextBuffer): void {
  if (buffer.value.endsWith(OPERATOR_STOPPED_NOTE)) return;
  buffer.append(buffer.value.trim() ? `\n\n${OPERATOR_STOPPED_NOTE}` : OPERATOR_STOPPED_NOTE);
}

export function createAssistantTextBuffer(): AssistantTextBuffer {
  let text = '';
  let persisted = '';
  let discarded = false;
  let blockEnded = false;
  return {
    append(chunk: string) {
      const separated = blockEnded && text && !/\s$/.test(text) && !/^\s/.test(chunk) ? `\n\n${chunk}` : chunk;
      blockEnded = false;
      text += separated;
      return separated;
    },
    endBlock() { blockEnded = true; },
    discard() {
      text = '';
      persisted = '';
      discarded = true;
    },
    get value() { return text; },
    shouldPersist(hasReceipt: boolean) {
      if (!text) return false;
      return text !== persisted || hasReceipt;
    },
    markPersisted() { persisted = text; },
    get discarded() { return discarded; },
  };
}
