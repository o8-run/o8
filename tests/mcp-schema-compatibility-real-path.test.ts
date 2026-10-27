import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn(async () => {}) }));

const { POST } = await import('@/app/api/mcp/route');
const reviewRoute = await import('@/app/api/orchestrator/review/route');
const { createMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { listDispatchableRuntimes } = await import('@/lib/orchestrator/runtime-capabilities');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { closeDb } = await import('@/lib/db');

const runtime = listDispatchableRuntimes()[0];
const repoPath = mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'schema-replay-'));
const token = getOrCreateWsToken();
const schemas = new Map<string, ReturnType<Ajv.Ajv['compile']>>();
const validator = new Ajv({ allErrors: true, strictKeywords: true, strictDefaults: true,
  coerceTypes: false, useDefaults: false, removeAdditional: false });

interface Replay {
  label: string;
  tool: 'submit_review' | 'create_mission';
  input: Record<string, unknown>;
}

const review = (label: string, severity: string, verdict: Record<string, string>): Replay => ({
  label, tool: 'submit_review', input: { approved: false,
    findings: [{ file: 'src/example.ts', severity, description: 'Check empty input', ...verdict }] },
});

const replays: Replay[] = [
  ...['bug', 'high', 'critical', 'error', 'rule_violation', 'medium', 'warning', 'policy', 'note', 'low', 'info']
    .map((severity) => review(`severity ${severity}`, severity, { status: 'deferred' })),
  review('severity with mixed case and whitespace', ' WaRnInG ', { status: 'fixed' }),
  review('uppercase severity', ' CRITICAL ', { status: 'accepted' }),
  ...['fixed', 'accepted', 'deferred'].map((resolution) => review(`resolution-only ${resolution}`, 'warning', { resolution })),
  review('status takes precedence over resolution', 'warning', { status: 'accepted', resolution: 'deferred' }),
  { label: 'empty findings', tool: 'submit_review', input: { approved: false, findings: [] } },
  { label: 'inline task without issues field', tool: 'create_mission', input: { issues_inline: [{ title: 'Replay one task' }] } },
  { label: 'inline task with empty issues', tool: 'create_mission', input: { issues: [], issues_inline: [{ title: 'Replay one task' }] } },
  { label: 'multiple inline tasks with empty issues', tool: 'create_mission', input: { issues: [], issues_inline: [{ title: 'Replay first task' }, { title: 'Replay second task' }] } },
  { label: 'inline task with empty comparison list', tool: 'create_mission', input: { comparisonModels: [], issues_inline: [{ title: 'Replay one task' }] } },
];

async function rpc(method: string, params?: Record<string, unknown>) {
  const response = await POST(new Request('http://localhost/api/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }));
  expect(response.status).toBe(200);
  const message = await response.json();
  expect(message.error).toBeUndefined();
  return message.result;
}

async function call(name: string, args: Record<string, unknown>) {
  const result = await rpc('tools/call', { name, arguments: args });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return JSON.parse(result.content[0].text);
}

beforeAll(async () => {
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test',
    'commit', '--allow-empty', '-m', 'test fixture'], { cwd: repoPath, stdio: 'pipe' });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new NextRequest(new Request(input, init));
    if (request.nextUrl.pathname === '/api/orchestrator/create-mission') {
      const body = await request.json();
      return Response.json({ ok: true, result: await createMission(body) });
    }
    if (request.nextUrl.pathname === '/api/orchestrator/review') return reviewRoute.POST(request);
    throw new Error(`Unexpected replay route: ${request.nextUrl.pathname}`);
  });
  const { tools } = await rpc('tools/list');
  for (const name of ['submit_review', 'create_mission']) {
    const tool = tools.find((entry: { name: string }) => entry.name === name);
    expect(tool, name).toBeDefined();
    schemas.set(name, validator.compile(tool.inputSchema));
  }
});

afterAll(() => { vi.restoreAllMocks(); closeDb(); });

describe('main-compatible calls against the discovered schemas (22 replays)', () => {
  it.each(replays)('$label', async ({ tool, input }) => {
    let args: Record<string, unknown>;
    if (tool === 'submit_review') {
      const prepared = await call('create_mission', { repoPath, runtime, dispatch: false,
        holdMerges: true, issues_inline: [{ title: 'Prepare review replay' }] });
      args = { ...input, packetId: prepared.packets[0].id };
    } else {
      args = { ...input, repoPath, runtime, dispatch: false, holdMerges: true };
    }
    const unchanged = structuredClone(args);
    // Exercise the real handlers and persisted review state before checking the
    // client contract: schema validation must not prevent a successful call.
    const result = await call(tool, args);
    if (tool === 'submit_review') {
      expect(result.recorded).toBe(true);
      const packet = readOrchestratorControlPlaneState().packets.find((entry) => entry.id === args.packetId);
      expect(packet?.review?.approved).toBe(false);
      expect(packet?.review?.findings).toHaveLength((input.findings as unknown[]).length);
    } else {
      expect(result.missionId).toEqual(expect.any(String));
      expect(result.packets).toHaveLength((input.issues_inline as unknown[]).length);
    }
    const validate = schemas.get(tool)!;
    expect(validate(args), JSON.stringify(validate.errors)).toBe(true);
    expect(args).toEqual(unchanged);
  });
});
