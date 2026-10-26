import { userInfo } from 'node:os';
import { WebviewBridgeError } from '@/lib/mcp/o8-webview-error';

export function resolveO8WebviewSocketPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  username: string = userInfo().username,
): string {
  const explicitSocket = env.O8_TAURI_MCP_SOCKET?.trim();
  if (explicitSocket) {
    return explicitSocket;
  }

  if (env.O8_DATA_DIR?.trim() || env.CORTEX_IDE_DATA_DIR?.trim()) {
    throw new WebviewBridgeError('webview_socket_unconfigured');
  }

  return `/tmp/tauri-mcp-o8-${username}.sock`;
}
