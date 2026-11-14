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

/**
 * Tracks whether a reply is waiting to be read. A turn that ends sets it; the
 * next turn that starts clears it. Reconnecting resets `busy` without a turn
 * ending, so a drop to idle only counts while the connection is up.
 */
export function nextReplyReady(
  previous: { busy: boolean; replyReady: boolean },
  current: { busy: boolean; connection: ChatTabState['connection'] },
): boolean {
  if (current.busy) return false;
  if (previous.busy && current.connection === 'connected') return true;
  return previous.replyReady;
}
