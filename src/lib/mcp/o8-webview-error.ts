/** Only fixed, app-owned guidance crosses the MCP boundary. Native details stay private. */
const messages = {
  webview_socket_unconfigured: 'O8_TAURI_MCP_SOCKET is required when O8_DATA_DIR or CORTEX_IDE_DATA_DIR is set; refusing to fall back to the installed app WebView socket.',
  webview_auth_missing: 'Native bridge authentication is missing. Launch o8 to publish its bridge token, or configure TAURI_MCP_AUTH_TOKEN for the selected bridge.',
  webview_auth_rejected: 'Native bridge authentication was rejected. Relaunch o8 and reconnect the HTTP MCP host to the current bridge. Inspect state before retrying an action.',
  webview_bridge_missing: 'No native webview bridge is available. Launch o8 with the bridge enabled and check O8_TAURI_MCP_SOCKET for this instance.',
  webview_bridge_unresponsive: 'The native webview bridge did not respond. Check that the app window is loaded and its result bridge has permission. Inspect state before retrying an action.',
  webview_window_missing: 'No target app window is available. Open the main o8 window and retry the read.',
  webview_permission_denied: 'The native bridge lacks permission. Check the app webview bridge capability and operating system permissions before retrying.',
  webview_command_failed: 'The native bridge could not complete this command. Check the app window and bridge diagnostics. Inspect state before retrying an action.',
  webview_outcome_unknown: 'Webview connection dropped during a mutation; not retried automatically because the action may have already executed. Inspect the app before issuing another action.',
} as const;

export class WebviewBridgeError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'WebviewBridgeError';
  }
}

export function nativeWebviewError(error: unknown): WebviewBridgeError {
  const message = typeof error === 'string' ? error : '';
  if (message === 'Authentication failed: invalid or missing auth token') return new WebviewBridgeError('webview_auth_rejected');
  if (/^Window not found[:.]/i.test(message)) return new WebviewBridgeError('webview_window_missing');
  if (/not allowed.*permissions|permission (?:denied|required)/i.test(message)) return new WebviewBridgeError('webview_permission_denied');
  if (/timeout waiting for .* response|request timed out/i.test(message)) return new WebviewBridgeError('webview_bridge_unresponsive');
  return new WebviewBridgeError('webview_command_failed');
}
