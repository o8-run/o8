export function longHistoryFixture(session?: number): {
  messages: Array<{ id: string; role: 'user' | 'assistant'; text: string; timestamp: number }>;
  payloadBytes: number;
  digest: string;
  complexity: { messages: number; turns: number; messagesPerKind: number; kinds: string[]; fencedBlocks: number; tables: number };
};
