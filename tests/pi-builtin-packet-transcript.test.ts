/**
 * #3666: operator MCP -> real apiFetch -> API GET -> persisted packet/session.
 * Only fetch's transport is bridged in-process; no worker or model is launched.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpToolResult } from '@/lib/mcp/operator-handlers/shared';
import type { TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { PiWorkerSessionRecord } from '@/lib/pi-builtin/types';

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(),
  requestRealtimeRefresh: vi.fn(),
}));

// Require the test harness boundary before any application import can pin paths.
const dataRoot = process.env.CORTEX_IDE_DATA_DIR;
if (!dataRoot || process.env.O8_DATA_DIR) throw new Error('An isolated test data root is required.');
const fixtureRoot = mkdtempSync(join(dataRoot, 'pi-packet-transcript-'));
const priorPiRoot = process.env.O8_OWNED_PI_BUILTIN_ROOT;
process.env.O8_OWNED_PI_BUILTIN_ROOT = join(fixtureRoot, 'owned-pi-builtin');
const originalFetch = globalThis.fetch;
const base = 'http://127.0.0.1';
const requests: Request[] = [];
globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== base || url.pathname !== '/api/orchestrator/packet-transcript' || request.method !== 'GET') {
    throw new Error(`Unexpected test fetch: ${request.method} ${url.pathname}`);
  }
  requests.push(request);
  const headers = new Headers(request.headers);
  headers.set('host', url.host);
  return getTranscript(new NextRequest(url, { headers, signal: request.signal }));
});

const { GET: getTranscript } = await import('@/app/api/orchestrator/packet-transcript/route');
const { handleTranscript } = await import('@/lib/mcp/operator-handlers/status');
const { setApiBase } = await import('@/lib/mcp/operator-handlers/shared');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { closeDb, getDbPath } = await import('@/lib/db');
setApiBase(base);
const panelToken = getOrCreateWsToken();

interface TranscriptPayload {
  packetId: string;
  sessionKey: string | null;
  events: TranscriptEvent[];
  nextCursor: number | null;
  note?: string | null;
}

const at = '2026-10-14T12:00:00.000Z';
const line = (event: Record<string, unknown>) => `${JSON.stringify({ at, ...event })}\n`;
let fixtureNumber = 0;

function persistSession(logs: Array<string | null>) {
  const id = `transcript-${++fixtureNumber}`;
  const sessionKey = `pi-builtin-owned:${id}`;
  const sessionDir = join(process.env.O8_OWNED_PI_BUILTIN_ROOT!, id);
  mkdirSync(join(sessionDir, 'runs'), { recursive: true });
  const recentRuns = logs.map((raw, index) => {
    const stdoutPath = join(sessionDir, 'runs', `run-${index}.jsonl`);
    if (raw !== null) writeFileSync(stdoutPath, raw);
    return { id: `run-${index}`, mode: 'resume' as const, prompt: 'Fixture task',
      startedAt: new Date(Date.parse(at) + index * 1_000).toISOString(),
      outcome: 'finished' as const, stdoutPath };
  }).reverse(); // Owned metadata stores newest first; readback must be chronological.
  const session: PiWorkerSessionRecord = {
    surfaceId: sessionKey, sessionDir, cwd: fixtureRoot, repoPath: fixtureRoot,
    title: 'Pi transcript fixture', createdAt: at, updatedAt: at,
    latestPrompt: 'Fixture task', latestSummary: 'Fixture result',
    model: 'fixture-model', readOnly: true, recentRuns,
  };
  const metadataPath = join(sessionDir, 'session.json');
  writeFileSync(metadataPath, JSON.stringify(session));
  return { sessionKey, metadataPath };
}

function persistPacket(sessionKey: string): string {
  const packet: OrchestratorPacket = {
    id: `packet-${fixtureNumber}`, referenceLabel: 'pi-1', title: 'Read Pi transcript',
    summary: 'Read the persisted Pi run', workspaceTargetPath: fixtureRoot, branchTarget: 'fixture/pi',
    runtime: 'pi-builtin', dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued',
    releaseState: 'pending', status: 'running',
    lane: { tileId: 'tile-pi', tabId: 'tab-pi', repoPath: fixtureRoot,
      worktreePath: fixtureRoot, runtime: 'pi-builtin', sessionKey },
  };
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), packets: [packet] });
  expect(JSON.parse(readFileSync(join(dataRoot!, 'orchestrator-state.json'), 'utf8')).mission.packets[0].lane.sessionKey)
    .toBe(sessionKey);
  return packet.id;
}

function payload(result: McpToolResult): TranscriptPayload {
  expect(result.isError).not.toBe(true);
  const content = result.content[0];
  if (content.type !== 'text') throw new Error('Expected an operator JSON result.');
  return (JSON.parse(content.text) as { data: TranscriptPayload }).data;
}

beforeEach(() => { requests.length = 0; });
afterAll(() => {
  closeDb();
  globalThis.fetch = originalFetch;
  if (priorPiRoot === undefined) delete process.env.O8_OWNED_PI_BUILTIN_ROOT;
  else process.env.O8_OWNED_PI_BUILTIN_ROOT = priorPiRoot;
  // The harness owns removal of its complete fresh data root.
});

describe('Pi builtin persisted operator transcript', () => {
  it('delivers tool/result/text/done through MCP, pagination, tail and session-key fallback', async () => {
    const { sessionKey } = persistSession([
      line({ type: 'assistant', text: 'Earlier turn.' }),
      line({ type: 'tool_call', name: 'read_file', args: { path: 'src/worker.ts' } })
        + line({ type: 'tool_result', name: 'read_file', output: 'Worker source read.', isError: false })
        + line({ type: 'assistant', text: 'The worker is ready.' })
        + line({ type: 'settled', outcome: 'finished', summary: 'Finished.' }),
    ]);
    const packetId = persistPacket(sessionKey);
    const full = payload(await handleTranscript({ packetId }));
    expect(full).toMatchObject({ packetId, sessionKey, nextCursor: 5 });
    expect(full.events).toEqual([
      { seq: 1, ts: at, type: 'assistant', text: 'Earlier turn.' },
      { seq: 2, ts: at, type: 'tool_call', tool: 'read_file',
        args: '{"path":"src/worker.ts"}', summary: expect.stringContaining('src/worker.ts') },
      { seq: 3, ts: at, type: 'tool_result', tool: 'read_file', ok: true, summary: 'Worker source read.' },
      { seq: 4, ts: at, type: 'assistant', text: 'The worker is ready.' },
      { seq: 5, ts: at, type: 'done', exitCode: 0 },
    ]);
    expect(requests[0].headers.get('authorization')).toBe(`Bearer ${panelToken}`);
    expect(getDbPath()).toBe(join(dataRoot!, 'cortex-ide.db'));

    const first = payload(await handleTranscript({ packetId, limit: 2 }));
    expect(first.events).toEqual(full.events.slice(0, 2));
    expect(first.nextCursor).toBe(2);
    const rest = payload(await handleTranscript({ packetId, cursor: first.nextCursor, limit: 3 }));
    expect(rest.events).toEqual(full.events.slice(2));
    expect(payload(await handleTranscript({ packetId, cursor: 5 }))).toMatchObject({ events: [], nextCursor: null });
    expect(payload(await handleTranscript({ packetId, cursor: 99, tail: true, limit: 2 })).events)
      .toEqual(full.events.slice(-2));

    const response = await fetch(`${base}/api/orchestrator/packet-transcript?${new URLSearchParams({ sessionKey, tail: '1', limit: '50' })}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(await response.json()).toMatchObject({ sessionKey, events: full.events, nextCursor: 5 });
  });

  it.each(['missing-session', 'missing-log', 'malformed-metadata', 'malformed-log'])(
    'returns a benign empty transcript for %s', async (kind) => {
      const fixture = persistSession([kind === 'missing-log' ? null :
        'not-json\nnull\n[]\n{"type":"assistant","text":7}\n{"type":"provider","secret":"do not surface"}\n'
        + '{"at":"2026-10-14T12:00:00.000Z","type":"assistant","text":"unfinished record"}']);
      if (kind === 'malformed-metadata') writeFileSync(fixture.metadataPath, '{broken');
      const sessionKey = kind === 'missing-session' ? 'pi-builtin-owned:absent' : fixture.sessionKey;
      const packetId = persistPacket(sessionKey);
      const result = payload(await handleTranscript({ packetId }));
      expect(result).toMatchObject({ packetId, sessionKey, events: [], nextCursor: null });
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(result)).not.toMatch(/do not surface|unfinished record|not-supported/);
    },
  );

  it.each(['failed', 'interrupted'] as const)('preserves an earlier completion and reports a resumed %s turn', async (outcome) => {
    const { sessionKey } = persistSession([
      line({ type: 'settled', outcome: 'finished', summary: 'Earlier turn finished.' }),
      line({ type: 'tool_result', name: 'run_command', output: 'Command refused.', isError: true })
        + line({ type: 'settled', outcome, summary: 'The later turn did not complete.' }),
    ]);
    const packetId = persistPacket(sessionKey);
    const full = payload(await handleTranscript({ packetId }));
    expect(full.events).toEqual([
      { seq: 1, ts: at, type: 'done', exitCode: 0 },
      { seq: 2, ts: at, type: 'tool_result', tool: 'run_command', ok: false, summary: 'Command refused.' },
      { seq: 3, ts: at, type: 'error', message: `Pi ${outcome}: The later turn did not complete.` },
    ]);
    const resumed = payload(await handleTranscript({ packetId, cursor: 1 }));
    expect(resumed.events).toEqual(full.events.slice(1));
    expect(resumed.events.some((event) => event.type === 'done')).toBe(false);
    expect(resumed.nextCursor).toBe(3);
  });
});

it('preserves legacy missing-time formatting while native mode leaves it unknown', async () => {
  const { sessionKey } = persistSession([`${JSON.stringify({ type: 'assistant', text: 'Answer without a timestamp' })}\n`]);
  const query = new URLSearchParams({ sessionKey });
  const read = async () => {
    const response = await getTranscript(new NextRequest(`${base}/api/orchestrator/packet-transcript?${query}`, {
      headers: { host: new URL(base).host, authorization: `Bearer ${panelToken}` },
    }));
    expect(response.status).toBe(200);
    return response.json();
  };
  expect((await read()).events[0].ts).toBe('1970-01-01T00:00:00.000Z');
  query.set('cursorToken', '');
  const native = await read();
  expect(native.events[0].ts).toBe('1970-01-01T00:00:00.000Z');
  expect(native.events[0].nativeTimestamp).toBe('');
  expect(native.events[0].eventId).toEqual(expect.any(String));
});
