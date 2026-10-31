import type { MobileTranscriptEntry } from '@/lib/mobile/types';

export type VoiceTerminals = Record<string, { outcome: 'completed' | 'failed' | 'interrupted' | 'unconfirmed' | 'held'; text: string; transcriptUserMessageId?: string }>;

/** Restored receipts survive voice close/reload; late uncertainty cannot erase confirmed evidence. */
export function voiceTerminalContext(messages: MobileTranscriptEntry[], live: VoiceTerminals): VoiceTerminals {
  const result: VoiceTerminals = {};
  for (const message of messages) {
    const terminal = message.role === 'assistant' && !message.voice ? message.receipt?.terminal : undefined;
    if (!terminal) continue;
    if (!result[terminal.userMessageId] || result[terminal.userMessageId].outcome === 'unconfirmed') {
      result[terminal.userMessageId] = { outcome: terminal.outcome, text: message.text };
    }
  }
  for (const [id, terminal] of Object.entries(live)) {
    if (!result[id] || result[id].outcome === 'unconfirmed') result[id] = terminal;
  }
  return result;
}
