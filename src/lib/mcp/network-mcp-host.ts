import { AgentBusError } from '@/lib/agents/service';
import { checkNetworkMcpInbox, listNetworkMcpTeam, sendNetworkMcpMessage } from '@/lib/bots/network-mcp-service';
import { BotNetworkError } from '@/lib/bots/network-types';
import { getDataDir } from '@/lib/data-dir-migration';
import { safeErrorText } from './api-error';
import type { OperatorMcpRequest, OperatorMcpResponse } from './operator-mcp-host';
import { discoverMcp, isModernMcpRequest, modernMcpError, modernMcpResult } from './operator-mcp-protocol';
import { jsonResult, textResult, type McpToolResult } from './operator-handlers/shared';
import { boundOperatorResult, readOperatorResultPage, RESULT_PAGE_TOOL } from './operator-result-pages';
import { NETWORK_MCP_TOOLS } from './network-mcp-tools';

const tools = [...NETWORK_MCP_TOOLS, RESULT_PAGE_TOOL];
const names = new Set(tools.map(tool => tool.name));
function validate(name: string, args: Record<string, unknown>) {
  const schema = tools.find(tool => tool.name === name)!.inputSchema;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  if (Object.keys(args).some(key => !(key in properties))) throw new Error('Use only the arguments published by tools/list.');
  for (const key of (schema.required ?? []) as string[]) if (!(key in args)) throw new Error(`${key} is required.`);
  for (const [key, value] of Object.entries(args)) {
    const rule = properties[key];
    if (rule.type === 'string' && (typeof value !== 'string' || (rule.minLength && !value.trim())
      || (typeof rule.maxLength === 'number' && value.length > rule.maxLength))) throw new Error(`${key} must be a valid string.`);
    if (rule.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${key} must be a boolean.`);
    if (rule.type === 'integer' && (!Number.isSafeInteger(value) || Number(value) < Number(rule.minimum ?? 0)
      || (typeof rule.maximum === 'number' && Number(value) > rule.maximum))) throw new Error(`${key} must be an integer in the published range.`);
  }
}
/** Stdio-only dispatcher. Deliberately absent from the operator HTTP registry. */
export async function handleNetworkMcpMessage(message: OperatorMcpRequest, bindingId: string): Promise<OperatorMcpResponse | null> {
  const modern = isModernMcpRequest(message);
  if (modern) {
    const refusal = modernMcpError(message);
    if (refusal) return refusal;
    if (message.method === 'server/discover') return { jsonrpc: '2.0', id: message.id!, result: discoverMcp() };
  }
  const { id, method } = message;
  if (id === undefined || id === null) return null;
  const result = (value: unknown) => ({ jsonrpc: '2.0' as const, id,
    result: modern ? modernMcpResult(value, method === 'tools/list') : value });
  if (method === 'initialize') return modern
    ? { jsonrpc: '2.0', id, error: { code: -32601, message: 'Modern MCP uses server/discover' } }
    : result({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'o8-operator', version: '1.0.0' } });
  if (method === 'tools/list') return result({ tools });
  if (method !== 'tools/call') return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  const name = typeof message.params?.name === 'string' ? message.params.name : '';
  if (!names.has(name)) return result(textResult(`Tool unavailable in local network profile: ${name}. Call tools/list.`, true));
  const raw = message.params?.arguments === undefined ? {} : message.params.arguments;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result(textResult('arguments must be an object.', true));
  const args = raw as Record<string, unknown>;
  const scope = JSON.stringify([getDataDir(), 'network', bindingId]);
  try {
    validate(name, args);
    if (name === RESULT_PAGE_TOOL.name) return result(readOperatorResultPage(args, scope, names));
    const value = name === 'list_team' ? listNetworkMcpTeam(bindingId)
      : name === 'check_inbox' ? checkNetworkMcpInbox(bindingId, args) : await sendNetworkMcpMessage(bindingId, args);
    return result(boundOperatorResult(name, scope, jsonResult(value)));
  } catch (error) {
    const failure: McpToolResult = jsonResult({ schema: 'o8/network.error/v1', error: {
      code: error instanceof AgentBusError || error instanceof BotNetworkError ? error.code : 'network_tool_failed',
      message: safeErrorText(error),
    } }, true);
    return result(failure);
  }
}
