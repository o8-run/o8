import type { MobileTranscriptEntry } from '@/lib/mobile/types';

export interface VoiceBinding {
  binding: string;
  nonce: string;
  threadId: string;
  repoPath: string;
}
export interface VoiceTerminal {
  queueItemId: string;
  outcome: 'completed' | 'failed' | 'held';
  text: string;
}
export interface VoiceHostPayload extends Partial<VoiceBinding> {
  action: string;
  hostId?: string;
  requestId?: string;
  source?: 'byok';
  state?: string;
  detail?: string;
  delegationId?: string;
  queueItemId?: string;
  transcriptUserMessageId?: string;
  text?: string;
  messages?: MobileTranscriptEntry[];
  busy?: boolean;
  voiceTerminal?: VoiceTerminal;
  confirmation?: Record<string, unknown>;
  confirmationId?: string;
  callId?: string;
  allow?: boolean;
}
export const voiceHostId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512;
export function isVoiceBinding(value: VoiceHostPayload): value is VoiceHostPayload & VoiceBinding {
  return [value.binding, value.nonce, value.threadId, value.repoPath].every(voiceHostId);
}
export function sameVoiceBinding(a: Partial<VoiceBinding>, b: Partial<VoiceBinding>): boolean {
  return a.binding === b.binding && a.nonce === b.nonce && a.threadId === b.threadId && a.repoPath === b.repoPath;
}
export function isVoiceTerminal(value: unknown): value is VoiceTerminal {
  if (!value || typeof value !== 'object') return false;
  const terminal = value as VoiceTerminal;
  return voiceHostId(terminal.queueItemId) && typeof terminal.text === 'string'
    && ['completed', 'failed', 'held'].includes(terminal.outcome);
}

/** Only voice frames cross this host's transport; desktop UI commands stay off it. */
export interface VoiceHostFrame {
  kind: 'voice-host-state' | 'voice-delegate';
  payload: Record<string, unknown>;
}
export function isVoiceHostFrame(value: Record<string, unknown>): value is Record<string, unknown> & VoiceHostFrame {
  return ['voice-host-state', 'voice-delegate'].includes(String(value.kind))
    && !!value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload);
}
