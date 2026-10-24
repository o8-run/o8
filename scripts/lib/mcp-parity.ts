import { isDeepStrictEqual } from 'node:util';

export interface RecordedMcpRequest {
  name: string;
  body: unknown;
  headers?: Record<string, string>;
  credential?: 'operator' | 'absent' | 'invalid' | 'read-only';
  /** Exact freshness pointers after parsing text content; validated timestamp fields are also allowed. */
  freshness?: string[];
}
export interface McpExchange { status: number; headers: Record<string, string>; body: unknown; catalogBytes?: string }
const timestampNames = new Set(['capturedAt', 'createdAt', 'updatedAt', 'decidedAt', 'generatedAt', 'checkedAt', 'observedAt', 'timestamp']);
function timestamp(value: unknown): boolean {
  return typeof value === 'number' ? Number.isFinite(value) && value >= 946684800000
    : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}
const freshnessNames = new Set(['checkedAt', 'generatedAt', 'observedAt', 'timestamp', 'timeAgo', 'ageMs', 'expiresInMs']);

function decoded(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decoded);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (key === 'text' && (value as { type?: string }).type === 'text' && typeof entry === 'string') {
      try { return [key, { json: decoded(JSON.parse(entry)) }]; } catch { /* plain text stays exact */ }
    }
    return [key, decoded(entry)];
  }));
}

function escapePointer(key: string): string { return key.replaceAll('~', '~0').replaceAll('/', '~1'); }

/** Compares every key, array position and value; declared freshness never permits missing fields. */
export function compareMcpExchanges(reference: McpExchange, candidate: McpExchange, freshness: string[] = []): void {
  for (const pointer of freshness) {
    const leaf = pointer.split('/').at(-1);
    if (!pointer.startsWith('/body/') || !leaf || !freshnessNames.has(leaf)) {
      throw new Error(`Invalid freshness declaration: ${pointer}`);
    }
  }
  const allowed = new Set(freshness);
  const walk = (left: unknown, right: unknown, pointer: string): void => {
    if (isDeepStrictEqual(left, right)) return;
    const leaf = pointer.split('/').at(-1) ?? '';
    if (timestampNames.has(leaf) && typeof left === typeof right && timestamp(left) && timestamp(right)) return;
    if (allowed.has(pointer)) {
      if (typeof left !== typeof right || left === null || right === null
        || !['string', 'number'].includes(typeof left)) throw new Error(`Freshness type mismatch at ${pointer}`);
      return;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
        throw new Error(`Array mismatch at ${pointer}`);
      }
      left.forEach((entry, index) => walk(entry, right[index], `${pointer}/${index}`));
      return;
    }
    if (left && right && typeof left === 'object' && typeof right === 'object') {
      const a = left as Record<string, unknown>;
      const b = right as Record<string, unknown>;
      if (!isDeepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort())) throw new Error(`Field mismatch at ${pointer}`);
      for (const key of Object.keys(a)) walk(a[key], b[key], `${pointer}/${escapePointer(key)}`);
      return;
    }
    // Do not print values: recordings may be run against private local state.
    throw new Error(`Value mismatch at ${pointer}`);
  };
  walk(decoded(reference), decoded(candidate), '');
}

export async function sendRecordedMcp(base: string, token: string, recording: RecordedMcpRequest): Promise<McpExchange> {
  const credential = recording.credential ?? 'operator';
  const authorization = credential === 'operator' ? `Bearer ${token}`
    : credential === 'read-only' ? 'Bearer o8ro_fixture-refused' : credential === 'invalid' ? 'Bearer fixture-invalid' : undefined;
  const response = await fetch(`${base}/api/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      ...(authorization ? { authorization } : {}), ...recording.headers },
    body: typeof recording.body === 'string' ? recording.body : JSON.stringify(recording.body),
    signal: AbortSignal.timeout(180_000),
  });
  const raw = await response.text();
  let body: unknown = raw;
  try { body = JSON.parse(raw); } catch { /* empty notifications and parse errors are compared too */ }
  const headers = Object.fromEntries(['content-type', 'allow'].flatMap((key) => {
    const value = response.headers.get(key);
    return value === null ? [] : [[key, value]];
  }));
  // Catalog parity includes the exact wire bytes; tool results retain their
  // field-by-field comparison and narrowly declared freshness allowances.
  const responses: unknown[] = Array.isArray(body) ? body : [body];
  const catalog = responses.some((entry) => entry && typeof entry === 'object'
    && Array.isArray((entry as { result?: { tools?: unknown } }).result?.tools));
  return { status: response.status, headers, body,
    ...(catalog ? { catalogBytes: raw } : {}) };
}

export async function replayMcp(reference: string, candidate: string, token: string, requests: RecordedMcpRequest[]): Promise<number> {
  for (const recording of requests) {
    const left = await sendRecordedMcp(reference, token, recording);
    const right = await sendRecordedMcp(candidate, token, recording);
    try { compareMcpExchanges(left, right, recording.freshness); }
    catch (error) { throw new Error(`${recording.name}: ${(error as Error).message}`); }
  }
  return requests.length;
}
