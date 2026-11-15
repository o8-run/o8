/** These stateful services belong to WS in every transport mode. */
export const symonOwnerPaths = new Set([
  '/api/mobile/symon/text-turn',
  '/api/panel/symon/conversations',
  '/api/panel/symon/conversations/continue',
  '/api/panel/symon/conversations/transcript',
  '/api/panel/symon/conversations/record',
  '/api/symon/managed-messages/inbound',
  '/api/panel/symon/messages-receiver',
]);
