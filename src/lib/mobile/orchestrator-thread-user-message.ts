import type { MobileTranscriptEntry } from './types';
import { createHandoffHistoryMarker } from './orchestrator-handoff-history';
import type { ChatHistoryMessage } from './orchestrator-thread-projection';

export function appendUserHistoryMessage(input: {
  messages: ChatHistoryMessage[];
  content: string;
  messageId?: string;
  media?: MobileTranscriptEntry['media'];
  handoff?: MobileTranscriptEntry['handoff'];
  steerAnchor?: MobileTranscriptEntry['steerAnchor'];
  timestamp: number;
}): ChatHistoryMessage[] {
  const next = [...input.messages];
  const last = next[next.length - 1];
  const duplicateIndex = input.messageId
    ? next.findIndex(message => message.role === 'user' && message.id === input.messageId)
    : last?.role === 'user' && !input.media?.length && last.content === input.content ? next.length - 1 : -1;
  const duplicate = duplicateIndex >= 0;
  if (duplicate && input.media?.length && input.messageId) {
    next[duplicateIndex] = { ...next[duplicateIndex], media: input.media };
  }
  if (input.handoff && !next.some((message) => message.id === input.handoff?.handoffId)) {
    next.splice(duplicate ? duplicateIndex : next.length, 0, createHandoffHistoryMarker(input.handoff, input.timestamp));
  }
  if (!duplicate) {
    next.push({
      id: input.messageId?.trim() || `user-${input.timestamp}`,
      role: 'user',
      content: input.content,
      ...(input.steerAnchor ? { steerAnchor: input.steerAnchor } : {}),
      ...(input.media?.length ? { media: input.media } : {}),
      timestamp: input.handoff ? input.timestamp + 1 : input.timestamp,
    });
  }
  return next;
}
