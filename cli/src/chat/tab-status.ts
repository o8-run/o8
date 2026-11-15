/**
 * What `o8 chat` reports to a terminal that reads the Program Status Protocol.
 *
 * The tab shows that a turn is running, that a reply is ready to read, or that
 * the chat needs attention. Every message is a fixed phrase: the report never
 * carries a prompt, a reply, a tool name, an error text, or a path.
 */

import type { TerminalStatusReport } from '../terminal-status.js';

export interface ChatTabState {
  connection: 'connecting' | 'connected' | 'disconnected';
  busy: boolean;
  error: boolean;
  /** A turn has finished since the operator last sent a message. */
  replyReady: boolean;
}

export function chatStatusReport(state: ChatTabState): TerminalStatusReport {
  if (state.connection === 'disconnected') return { state: 'error', msg: 'Connection lost' };
  if (state.error) return { state: 'error', msg: 'Needs attention' };
  if (state.connection === 'connecting') return { state: 'working', msg: 'Connecting' };
  if (state.busy) return { state: 'working', msg: 'Working' };
  if (state.replyReady) return { state: 'done', msg: 'Reply ready' };
  return { state: 'idle', msg: 'Ready' };
}

export interface TurnTracker {
  /** A turn is running, as far as this chat has been told. */
  running: boolean;
  /** The operator asked to stop the running turn. */
  stopRequested: boolean;
  /** A turn finished with a reply and nothing was sent since. */
  replyReady: boolean;
}

export const initialTurnTracker: TurnTracker = { running: false, stopRequested: false, replyReady: false };

/**
 * What the chat learned about the turn:
 * - `started`: a message was sent from this chat. A busy report from the
 *   thread is not enough, because opening a conversation replays old events.
 * - `stop-requested`: the operator asked to stop the turn.
 * - `ready`: the thread reported the turn finished.
 * - `failed`: the turn ended in an error, or the agent stopped.
 * - `reset`: the connection was reopened or lost, so the turn's fate is unknown.
 */
export type TurnSignal = 'started' | 'stop-requested' | 'ready' | 'failed' | 'reset';

/**
 * Decides whether a reply is waiting to be read. Only a turn this chat saw
 * running and then finishing cleanly counts. A stopped turn, a failed turn,
 * and a turn cut off by a reconnect do not, so the tab never claims a reply
 * that did not arrive.
 */
export function trackTurn(turn: TurnTracker, signal: TurnSignal): TurnTracker {
  switch (signal) {
    case 'started':
      return turn.running ? turn : { running: true, stopRequested: false, replyReady: false };
    case 'stop-requested':
      return turn.running ? { ...turn, stopRequested: true } : turn;
    case 'ready':
      return turn.running ? { running: false, stopRequested: false, replyReady: !turn.stopRequested } : turn;
    case 'failed':
      return initialTurnTracker;
    case 'reset':
      return turn.running ? initialTurnTracker : turn;
  }
}
