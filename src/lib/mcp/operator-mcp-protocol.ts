import type { OperatorMcpRequest, OperatorMcpResponse } from './operator-mcp-host';
import { browserWriteAllowed } from '../../../scripts/lib/http-request-boundary.cjs';

export const STATELESS_MCP_VERSION = '2026-07-28';
export const MCP_VERSIONS = [STATELESS_MCP_VERSION, '2024-11-05'];
const VERSION = 'io.modelcontextprotocol/protocolVersion';
const CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO = { name: 'o8-operator', version: '1.0.0' };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function meta(message: unknown): Record<string, unknown> {
  if (!object(message) || !object(message.params) || !object(message.params._meta)) return {};
  return message.params._meta;
}
export function isModernMcpRequest(message: unknown): boolean {
  return object(message) && (message.method === 'server/discover' || VERSION in meta(message) || CAPABILITIES in meta(message));
}
function error(message: unknown, code: number, text: string, data?: unknown): OperatorMcpResponse {
  const id = object(message) && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : null;
  return { jsonrpc: '2.0', id, error: { code, message: text, ...(data ? { data } : {}) } };
}
export function modernMcpError(message: unknown): OperatorMcpResponse | null {
  if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
    || !(typeof message.id === 'string' || (typeof message.id === 'number' && Number.isSafeInteger(message.id)))) {
    return error(message, -32600, 'Invalid request');
  }
  const metadata = meta(message);
  if (typeof metadata[VERSION] !== 'string' || !object(metadata[CAPABILITIES])) {
    return error(message, -32602, 'Required per-request protocol metadata is missing or malformed');
  }
  if (metadata[VERSION] !== STATELESS_MCP_VERSION) {
    return error(message, -32022, 'Unsupported protocol version', { supported: MCP_VERSIONS, requested: metadata[VERSION] });
  }
  if (message.method === 'tools/call' && object(message.params)
    && message.params.arguments !== undefined && !object(message.params.arguments)) {
    return error(message, -32602, 'Tool arguments must be an object');
  }
  return null;
}
export function modernMcpResult(result: unknown, cacheable = false): Record<string, unknown> {
  const body = object(result) ? result : {};
  return { ...body, resultType: 'complete',
    _meta: { ...(object(body._meta) ? body._meta : {}), 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    ...(cacheable ? { ttlMs: 0, cacheScope: 'private' } : {}) };
}

function decodedHeader(value: string | null): string | null {
  if (value === null || !/^[\x20-\x7e]*$/.test(value)) return null;
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value;
  const encoded = value.slice(9, -2);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

/** Mirror a stdio request's metadata when the thin bridge sends it over HTTP. */
export function modernMcpHeaders(message: unknown): Record<string, string> {
  if (!isModernMcpRequest(message) || !object(message)) return {};
  const headers: Record<string, string> = {};
  const version = meta(message)[VERSION];
  if (typeof version === 'string') headers['MCP-Protocol-Version'] = version;
  if (typeof message.method === 'string') headers['Mcp-Method'] = message.method;
  const params = object(message.params) ? message.params : {};
  const name = message.method === 'resources/read' ? params.uri : params.name;
  if (typeof name === 'string' && ['tools/call', 'resources/read', 'prompts/get'].includes(String(message.method))) {
    headers['Mcp-Name'] = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(name)
      && !(name.startsWith('=?base64?') && name.endsWith('?=')) ? name : `=?base64?${Buffer.from(name).toString('base64')}?=`;
  }
  return headers;
}

/** Validate mirrored routing fields before any handler or native-read side effect. */
export function prepareMcpHttp(payload: unknown, headers: Headers, protocol = 'http:'): { modern: boolean; refusal: OperatorMcpResponse | null; status?: number } {
  const version = headers.get('mcp-protocol-version');
  const messages = Array.isArray(payload) ? payload : [payload];
  const modern = (version !== null && version !== '2024-11-05') || messages.some(isModernMcpRequest)
    || (version === null && (headers.has('mcp-method') || headers.has('mcp-name')));
  if (!browserWriteAllowed('POST', name => headers.get(name), protocol)) {
    return { modern, refusal: error(payload, -32600, 'Origin is not allowed'), status: 403 };
  }
  if (!modern) return { modern, refusal: null };
  if (Array.isArray(payload)) return { modern, refusal: error(null, -32600, 'Modern MCP requires one request per POST') };
  const malformed = modernMcpError(payload);
  // A mismatched or missing header is a routing error, independently of the
  // version the body requested. Never route one tool and execute another.
  const metadata = meta(payload);
  if (!object(payload) || version === null || version !== metadata[VERSION]
    || headers.get('mcp-method') !== payload.method) {
    return { modern, refusal: error(payload, -32020, 'Header mismatch: protocol version or method') };
  }
  if (malformed) return { modern, refusal: malformed };
  const params = object(payload.params) ? payload.params : {};
  const name = payload.method === 'resources/read' ? params.uri
    : ['tools/call', 'prompts/get'].includes(String(payload.method)) ? params.name : undefined;
  if (name !== undefined || ['tools/call', 'resources/read', 'prompts/get'].includes(String(payload.method))) {
    if (typeof name !== 'string' || decodedHeader(headers.get('mcp-name')) !== name) {
      return { modern, refusal: error(payload, -32020, 'Header mismatch: tool, prompt or resource name') };
    }
  }
  return { modern, refusal: null };
}

export function modernMcpHttpStatus(response: OperatorMcpResponse | undefined): number {
  if (!response?.error) return 200;
  return response.error.code === -32601 ? 404 : response.error.code === -32603 ? 500 : 400;
}

export function discoverMcp(): Record<string, unknown> {
  return modernMcpResult({ supportedVersions: MCP_VERSIONS, capabilities: { tools: {} } }, true);
}

export function modernMcpCall(message: OperatorMcpRequest): OperatorMcpRequest {
  // Durable cursors are request arguments. Modern clients poll progress rather
  // than tying application progress to the lifetime of a response socket.
  if (message.method !== 'tools/call' || message.params?.name !== 'mission_tail') return message;
  return { ...message, params: { ...message.params, arguments: {
    ...(object(message.params.arguments) ? message.params.arguments : {}), timeoutMs: 0,
  } } };
}
