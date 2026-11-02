export interface AgentPresence {
  agentId: string;
  name: string;
  repo: string;
  worktreePath: string | null;
  runtime: string;
  sessionKey: string | null;
  laneId: string | null;
  packetId: string | null;
  lastSeen: string;
}

export interface AgentMessageRefs {
  laneId: string | null;
  packetId: string | null;
  /** Immutable identities recorded when the message was accepted. Older messages omit this. */
  identities?: { from: AgentMessageIdentity | null; to: AgentMessageIdentity | null };
}

export interface AgentMessageIdentity {
  runtime: string;
  sessionKey: string | null;
}

export interface AgentConversationReceipt {
  id: string;
  replyToId: string | null;
  turnIndex: number;
  turnLimit: number;
  remainingTurns: number;
  status: 'open' | 'closed';
  closedReason: string | null;
  lastMessageId: string;
}

export interface AgentMessage {
  schema: 'o8/agents.message-event/v1';
  kind: 'message';
  sequence: number;
  id: string;
  from: string;
  to: string;
  repo: string;
  text: string;
  refs: AgentMessageRefs;
  /** Missing on older, unthreaded messages. */
  conversation?: AgentConversationReceipt | null;
  delivery: 'native' | 'poll' | 'failed';
  deliveryNote: string | null;
  timestamp: string;
}

/** Storage identity and presentation; never substitutes for a bus principal. */
export interface BotMember {
  id: string;
  house: string;
  name: string;
  iconKey: string | null;
  homeThreadId: string | null;
  createdAt: string;
  updatedAt: string;
  sourceIds: string[];
  bindings: BotMemberBinding[];
}

/** An explicit snapshot of an existing local bus session's delivery context. */
export interface BotMemberBinding {
  id: string;
  memberId: string;
  agentId: string;
  agentName: string;
  repo: string;
  runtime: string;
  sessionKey: string;
  createdAt: string;
  live: boolean;
}
