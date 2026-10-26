import { NextResponse } from 'next/server';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { callPluginTool } from '@/lib/mcp/plugin-host';
import { discoverPluginCatalog } from '@/lib/mcp/plugin-catalog';
import { TaskDraftError } from '@/lib/mcp/task-draft-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const principal = resolveRequestPrincipalContext(request);
  if (principal.role !== 'plugin') {
    return NextResponse.json({ error: 'plugin_credential_required' }, { status: principal.role === 'anonymous' ? 401 : 403 });
  }
  let message: Record<string, unknown>;
  try {
    const body = await request.text();
    if (Buffer.byteLength(body) > 16_384) return NextResponse.json({ error: 'request_too_large' }, { status: 413 });
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request');
    message = value as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (message.jsonrpc !== '2.0' || (typeof message.id !== 'string' && typeof message.id !== 'number')) {
    return NextResponse.json({ error: 'method_forbidden' }, { status: 403 });
  }
  if (message.method === 'tools/list') {
    try {
      const result = await discoverPluginCatalog(principal);
      return NextResponse.json({ jsonrpc: '2.0', id: message.id, result }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      return NextResponse.json({ error: error instanceof TaskDraftError ? error.code : 'catalog_unavailable' },
        { status: error instanceof TaskDraftError ? error.status : 503, headers: { 'Cache-Control': 'no-store' } });
    }
  }
  if (message.method !== 'tools/call') return NextResponse.json({ error: 'method_forbidden' }, { status: 403 });
  const receipt = await callPluginTool(principal, message.params);
  return NextResponse.json({
    jsonrpc: '2.0', id: message.id,
    result: { content: [{ type: 'text', text: JSON.stringify(receipt.result) }], structuredContent: receipt.result, isError: !receipt.result.ok },
  }, { status: receipt.status, headers: { 'Cache-Control': 'no-store' } });
}
