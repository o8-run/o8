import 'server-only';

import { claimMessagesReceiver } from './owner';
import { handleManagedMessage } from '@/lib/symon/managed-messages-inbound';
import { MessagesReceiver, sendWithMessages, type InboundMessage } from './receiver';

const LISTENING_MS = 3_000;
const IDLE_MS = 10_000;
/** A missing permission or unreadable database is checked again at this pace, never in a tight loop. */
const BLOCKED_MS = 60_000;
const ANSWER_WAIT_MS = 3 * 60_000;

/** Asks the shared inbound path until it answers or the wait ends. */
export async function answerThroughInbound(message: InboundMessage, waitMs = ANSWER_WAIT_MS): Promise<string | null> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const response = await handleManagedMessage(message);
    const body = await response.json().catch(() => null) as { ok?: unknown; state?: unknown; text?: unknown } | null;
    if (response.status === 200 && body?.state === 'done' && typeof body.text === 'string') return body.text;
    if (body?.state === 'awaiting_approval') {
      return 'Symon is waiting for your approval in o8. Check the request there.';
    }
    if (response.status !== 202 && response.status !== 503) return null;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return null;
}

export function getMessagesReceiver(): MessagesReceiver {
  const global = globalThis as { __o8MessagesReceiver?: MessagesReceiver };
  global.__o8MessagesReceiver ??= new MessagesReceiver({ answer: answerThroughInbound, send: sendWithMessages });
  return global.__o8MessagesReceiver;
}

/** WS is the sole startup caller, with or without O8_NEXT_O8D. */
export function startMessagesReceiver(): boolean {
  const global = globalThis as { __o8MessagesReceiverLoop?: boolean };
  if (process.platform !== 'darwin' || global.__o8MessagesReceiverLoop) return false;
  if (!claimMessagesReceiver()) return false;
  global.__o8MessagesReceiverLoop = true;
  const receiver = getMessagesReceiver();
  const next = async () => {
    let delay = IDLE_MS;
    try {
      const state = await receiver.tick();
      delay = state === 'listening' ? LISTENING_MS : state === 'off' ? IDLE_MS : BLOCKED_MS;
    } catch {
      delay = BLOCKED_MS;
    }
    setTimeout(() => { void next(); }, delay).unref();
  };
  setTimeout(() => { void next(); }, IDLE_MS).unref();
  return true;
}
