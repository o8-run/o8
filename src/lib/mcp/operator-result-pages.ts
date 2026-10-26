import { randomUUID } from 'node:crypto';
import { jsonResult, textResult, type McpTool, type McpToolResult } from './operator-handlers/shared';

// Leave space for JSON-RPC and protocol metadata around a tool result.
const RESULT_LIMIT_BYTES = 19_000;
const PAGE_LIMIT_BYTES = 18_000;
const CACHE_LIMIT_BYTES = 32 * 1024 * 1024;
const CACHE_LIMIT_ENTRIES = 32;
const RESULT_TTL_MS = 5 * 60_000;
const UNAVAILABLE = 'Saved result unavailable or expired. Rerun a read-only source call; check status before retrying a mutation.';

interface SavedResult {
  sourceTool: string;
  scope: string;
  serialized: string;
  bytes: number;
  expiresAt: number;
  isError?: boolean;
}

// Development route recompilation must not discard an already returned cursor.
const cacheKey = Symbol.for('o8.mcp.operator-result-pages');
const cacheRoot = globalThis as typeof globalThis & { [key: symbol]: Map<string, SavedResult> | undefined };
const results = cacheRoot[cacheKey] ??= new Map<string, SavedResult>();

export const RESULT_PAGE_TOOL: McpTool = {
  name: 'o8_result_page',
  description: 'Read the next page of a saved large tool result without repeating the source action. Required: resultId from the first page. Use nextArguments exactly; concatenate text from all pages and parse it as JSON to recover the original MCP result. Results expire after 5 minutes or cache eviction. Example: o8_result_page({resultId: "returned-result-id", offset: 12000}).',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    resultId: { type: 'string', minLength: 1, description: 'Opaque saved result identifier returned by a tool.' },
    offset: { type: 'integer', minimum: 0, default: 0, description: 'UTF-16 text offset from nextArguments; default 0 replays the first page.' },
  }, required: ['resultId'] },
};

function prune() {
  const now = Date.now();
  for (const [id, result] of results) if (result.expiresAt <= now) results.delete(id);
}

function resultPage(id: string, saved: SavedResult, offset: number): McpToolResult {
  let length = Math.min(12_000, saved.serialized.length - offset);
  for (;;) {
    const nextOffset = offset + length;
    const result = jsonResult({
      schema: 'o8/mcp/result-page/v1',
      summary: 'Read this saved result with o8_result_page; continuation never repeats the source action. Concatenate text pages, then parse JSON.',
      sourceTool: saved.sourceTool,
      resultId: id,
      offset,
      totalCharacters: saved.serialized.length,
      totalBytes: saved.bytes,
      expiresAt: new Date(saved.expiresAt).toISOString(),
      text: saved.serialized.slice(offset, nextOffset),
      nextArguments: nextOffset < saved.serialized.length ? { resultId: id, offset: nextOffset } : null,
    }, saved.isError);
    if (Buffer.byteLength(JSON.stringify(result)) <= PAGE_LIMIT_BYTES) return result;
    length = Math.floor(length / 2);
  }
}

export function boundOperatorResult(sourceTool: string, scope: string, result: McpToolResult): McpToolResult {
  const serialized = JSON.stringify(result);
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= RESULT_LIMIT_BYTES || sourceTool === RESULT_PAGE_TOOL.name) return result;
  // Keep image observations usable by visual clients; summarize their text
  // alongside the existing typed image blocks instead of serializing an image.
  if (result.content.some((block) => block.type === 'image')) {
    return { ...result, content: [{ type: 'text', text: JSON.stringify({
      summary: 'Image content is attached. Use the image blocks for visual inspection.', bytes,
    }) }, ...result.content] };
  }
  if (bytes > CACHE_LIMIT_BYTES) return jsonResult({
    summary: 'Result exceeds the 32 MB saved-result limit. Narrow the source query before reading again; check status before retrying a mutation.',
    sourceTool, totalBytes: bytes, truncated: true,
  }, result.isError);
  prune();
  let totalBytes = [...results.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  while (results.size >= CACHE_LIMIT_ENTRIES || totalBytes + bytes > CACHE_LIMIT_BYTES) {
    const oldest = results.keys().next().value!;
    totalBytes -= results.get(oldest)!.bytes;
    results.delete(oldest);
  }
  const id = randomUUID();
  const saved: SavedResult = { sourceTool, scope, serialized, bytes,
    expiresAt: Date.now() + RESULT_TTL_MS, isError: result.isError };
  results.set(id, saved);
  return resultPage(id, saved, 0);
}

export function readOperatorResultPage(args: Record<string, unknown>, scope: string, allowedTools: Set<string>): McpToolResult {
  if (typeof args.resultId !== 'string' || !args.resultId.trim()) {
    return textResult('resultId is required. Use resultId from a saved result page.', true);
  }
  const offset = args.offset ?? 0;
  if (!Number.isSafeInteger(offset) || Number(offset) < 0) {
    return textResult('offset must be a non-negative integer. Use offset from nextArguments.', true);
  }
  prune();
  const saved = results.get(args.resultId);
  if (!saved || saved.scope !== scope || !allowedTools.has(saved.sourceTool)) return textResult(UNAVAILABLE, true);
  if (Number(offset) > saved.serialized.length) {
    return textResult('offset exceeds the saved result. Use offset from nextArguments or 0 to replay.', true);
  }
  return resultPage(args.resultId, saved, Number(offset));
}
