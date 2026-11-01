import type { BotMemberBinding } from '@/lib/agents/types';

/** An author is distinct from both chat role and runtime/model attribution. */
export interface NetworkMessageAuthor {
  kind: 'human' | 'bot';
  id?: string;
  name: string;
  agentId?: string;
  runtime?: string;
  sessionKey?: string | null;
}
export interface NetworkMessageReceipt {
  messageId: string;
  conversationId: string;
  sequence: number;
  replyToId: string | null;
  from: string;
  to: string;
  delivery: 'native' | 'poll' | 'failed';
}
export type NetworkParticipant = Omit<BotMemberBinding, 'live' | 'createdAt'>;
export interface BotNetworkThread {
  threadId: string;
  repoPath: string;
  conversationId: string | null;
  /** One binding means operator↔bot; two bindings mean a peer exchange. */
  participants: NetworkParticipant[];
  title: string;
  createdAt: string;
}
export interface NetworkSendIntent {
  status: 'pending' | 'accepted' | 'cancelled' | 'rejected';
  threadId: string;
  clientId: string;
  requestId: string;
  text: string;
  replyToId: string | null;
  messageId: string | null;
  createdAt: number;
}
export class BotNetworkError extends Error {
  constructor(message: string, readonly code: string, readonly status = 409) {
    super(message); this.name = 'BotNetworkError';
  }
}

/** Attention metadata is distinct from delivery, exchange closure and agent execution. */
export interface NetworkQuestionSummary {
  id: string;
  status: 'pending' | 'answered';
  questionMessageId: string;
  answerMessageId: string | null;
}
