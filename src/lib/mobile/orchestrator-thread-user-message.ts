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
  const duplicate = last?.role === 'user' && (
    (Boolean(input.messageId) && last.id === input.messageId)
    || (!input.media?.length && last.content === input.content)
  );
  if (duplicate && input.media?.length && input.messageId && last.id === input.messageId) {
    next[next.length - 1] = { ...last, media: input.media };
  }
  if (input.handoff && !next.some((message) => message.id === input.handoff?.handoffId)) {
    next.splice(duplicate ? next.length - 1 : next.length, 0, createHandoffHistoryMarker(input.handoff, input.timestamp));
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
