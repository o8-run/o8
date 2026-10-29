/** Shell commands understood by the native main window. Unknown kinds stay off the wire. */
export const UI_COMMAND_KINDS = ['open-settings', 'symon-ui', 'ink-mark', 'voice-toggle'] as const;
export const MAX_UI_COMMAND_BYTES = 64 * 1024;

export interface UiCommand {
  kind: typeof UI_COMMAND_KINDS[number];
  payload: Record<string, unknown>;
}

export function parseUiCommand(body: unknown): UiCommand | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { kind, payload = {} } = body as Record<string, unknown>;
  if (!UI_COMMAND_KINDS.some((allowed) => allowed === kind)) return null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return { kind: kind as UiCommand['kind'], payload: payload as Record<string, unknown> };
}
