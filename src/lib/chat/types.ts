import type { ChatModelId } from '@/components/desktop/orchestrator/ModePicker';

export type ChatRequestModel = Extract<ChatModelId, 'o8-default' | 'byo-key'>;
export type ChatHistoryRole = 'user' | 'assistant';

export interface ChatHistoryMessage {
  role: ChatHistoryRole;
  content: string;
}

export interface ChatRequestBody {
  message: string;
  model: ChatRequestModel;
  history: ChatHistoryMessage[];
}

export type ChatStreamEvent =
  | { type: 'content'; text: string }
  | { type: 'usage'; count: number; limit: number; remaining: number }
  | { type: 'done' }
  | { type: 'error'; error: string; message: string };

export interface ChatErrorResponse {
  error: string;
  message: string;
  limit?: number;
  remaining?: number;
}
