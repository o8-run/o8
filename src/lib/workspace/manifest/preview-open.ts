import 'server-only';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { requestBrowserOpen } from '@/lib/mcp/o8-browser-open';
let client: O8WebviewClient | undefined;

/** Approved manifests opt in; an unavailable desktop never becomes a false opened receipt. */
export async function openWorkspacePreview(url: string): Promise<Record<string, unknown>> {
  client ??= new O8WebviewClient();
  try { return await requestBrowserOpen(client, { url, timeoutMs: 1000 }); }
  catch { return { ok: false, status: 'unavailable' }; }
}
