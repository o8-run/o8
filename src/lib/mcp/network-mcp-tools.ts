import type { McpTool } from './operator-handlers/shared';

export const NETWORK_MCP_TOOLS: McpTool[] = [
  { name: 'ask_user', description: 'Ask the human one durable question in the existing native needs-input Inbox. Returns immediately with a question ticket; pending means awaiting a human answer. Repeat the same requestId and question to retrieve the answer across session restarts, even after inbox acknowledgement. The human replies through the native network-thread composer; check_inbox also receives that correlated reply. Accepted proves durable bus acceptance, never human reading or processing.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      question: { type: 'string', minLength: 1, maxLength: 4000 },
      requestId: { type: 'string', minLength: 1, maxLength: 200 },
    }, required: ['question', 'requestId'] } },
  { name: 'list_team', description: 'List durable local bot members and the explicit session bindings available in this repository. Membership and live presence are separate. Copy a binding id as send_message.to; bindings are routing references, not authentication claims.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'send_message', description: 'Send through the existing bounded agent bus to one explicit local binding. Reuse requestId and identical arguments after an uncertain result. A reply must name the latest message as replyToId; close ends the exchange. Use to: operator only to reply to an existing operator message. Accepted means durable bus acceptance; poll means inbox availability, native means the existing runtime handoff or target inbox acknowledgement, and neither proves processing.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      to: { type: 'string', minLength: 1, maxLength: 200 },
      text: { type: 'string', minLength: 1, maxLength: 4000 },
      requestId: { type: 'string', minLength: 1, maxLength: 200 },
      replyToId: { type: 'string', minLength: 1, maxLength: 200 }, close: { type: 'boolean' },
    }, required: ['to', 'text', 'requestId'] } },
  { name: 'check_inbox', description: 'Read and acknowledge this explicitly bound local session inbox using the existing target-session semantics. Omit cursor to resume the durable acknowledgement cursor. Already acknowledged/native messages are skipped, even with an older cursor; a lost response is not replayed by this call. limit is 1–100. Follow hasMore and cursor for subsequent pages. Inbox acknowledgement does not prove processing. Large saved result pages must be read with o8_result_page without repeating this action.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 },
    } } },
];
