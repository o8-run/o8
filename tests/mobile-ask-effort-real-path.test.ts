import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetWarmReplPool } from '@/lib/claude-code/warm-repl-pool';
import { getDataDir } from '@/lib/data-dir-migration';
import { enrollDevice } from '@/lib/mobile/device-registry';
import { MOBILE_ASK_MODEL_IDS, resolveMobileAskRoute } from '@/lib/mobile/ask-model-routing';
import { loadSymonTextSession } from '@/lib/mobile/symon-text-session-store';
import { writeSymonTextBrainMode } from '@/lib/symon/durable/text-brain-setting';
import type { SymonTextPlannerSelection } from '@/lib/mobile/symon-text-eval';

const h = vi.hoisted(() => ({
  binary: '',
  reportedEffort: null as string | null,
  auth: vi.fn(),
  planner: vi.fn(),
  turn: vi.fn(),
}));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ getRuntimeAuthSnapshotForClaudeCarrier: h.auth }));
vi.mock('@/lib/mobile/symon-text-bridge-client', () => ({
  readSymonTextPlannerInfo: h.planner,
  pollSymonTextTurn: h.turn,
  pollSymonTextInterrupt: vi.fn(),
}));

import { POST as generate } from '@/app/api/mobile/genui/stream/route';
import { POST as mint } from '@/app/api/mobile/symon/text-session/route';
import { POST as runTurn } from '@/app/api/mobile/symon/text-turn/route';

const root = mkdtempSync(join(tmpdir(), 'o8-mobile-ask-effort-'));
const capture = join(root, 'launches.jsonl');
const selectedModel = MOBILE_ASK_MODEL_IDS[3];
const route = resolveMobileAskRoute(selectedModel, { claude: true, codex: true }, 'high');
if (route.kind === 'managed') throw new Error('Fixture model must have a local route.');
const expectedModel = route.cliModel;
let token: string;

beforeAll(() => {
  token = enrollDevice({ identityPublicKey: Buffer.alloc(32, 17).toString('base64'), deviceLabel: 'Fixture phone' }).deviceToken;
  h.binary = join(root, 'ask-worker.cjs');
  writeFileSync(h.binary, `#!${process.execPath}
const fs = require('node:fs');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), prompt }) + '\\n');
  console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fixture answer' } } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Fixture answer' }));
});
`);
  chmodSync(h.binary, 0o755);
});

beforeEach(() => {
  writeFileSync(capture, '');
  writeSymonTextBrainMode('planner');
  h.reportedEffort = null;
  h.auth.mockReset().mockResolvedValue({ statuses: {
    claude: { installed: true, ready: true, binaryPath: h.binary },
    codex: { installed: true, ready: true, binaryPath: h.binary },
  } });
  h.planner.mockReset().mockImplementation(async (selection?: SymonTextPlannerSelection) => ({
    available: true,
    engine: selection?.engine ?? route.kind,
    model: selection?.model ?? expectedModel,
    effort: h.reportedEffort ?? selection?.effort ?? 'high',
    allowDefaultFallback: true,
    tools: [],
  }));
  h.turn.mockReset().mockImplementation(async (input: { planner: SymonTextPlannerSelection }) => ({
    state: 'done', result: { status: 'done', text: 'Fixture answer', model: input.planner.model, effort: input.planner.effort },
  }));
});

afterEach(async () => {
  resetWarmReplPool();
  await new Promise((resolve) => setTimeout(resolve, 25));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function request(path: string, body: object): NextRequest {
  return new NextRequest(`http://localhost/api/mobile/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function generation(effort?: unknown, stream = false) {
  return request('genui/stream', { model: selectedModel, effort, stream, messages: [{ role: 'user', content: 'Fixture question' }] });
}
function launches(): Array<{ args: string[]; prompt: string }> {
  return readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
function sessions(): string | null {
  const file = join(getDataDir(), 'symon-text-sessions.json');
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

describe.skipIf(process.platform === 'win32')('phone Ask effort through routes, persisted sessions and actual worker launch', () => {
  it.each([false, true])('keeps an explicit low pin in worker arguments and the response receipt (stream %s)', async (stream) => {
    const response = await generate(generation('low', stream));
    expect(response.status).toBe(200);
    const text = await response.text();
    const [launch] = launches();
    expect(launch.args[launch.args.indexOf('--effort') + 1]).toBe('low');
    expect(launch.args[launch.args.indexOf('--model') + 1]).toBe(expectedModel);
    expect(launch.prompt).toContain('Fixture question');
    expect(response.headers.get('X-O8-Ask-Effort')).toBe('low');
    expect(text).toContain('Fixture answer');
  });

  it('retains the documented xhigh default when effort is omitted', async () => {
    const response = await generate(generation());
    expect(response.status).toBe(200);
    await response.text();
    const [launch] = launches();
    expect(launch.args[launch.args.indexOf('--effort') + 1]).toBe('xhigh');
    expect(response.headers.get('X-O8-Ask-Effort')).toBe('xhigh');
  });

  it.each(['', ' low ', 'LOW', 'turbo', null, 1, false, {}, ['low']])('refuses malformed explicit effort %j before dispatch or persistence', async (effort) => {
    const before = sessions();
    const direct = await generate(generation(effort));
    expect(direct.status).toBe(400);
    const planner = await mint(request('symon/text-session', { model: selectedModel, effort }));
    expect(planner.status).toBe(400);
    expect(h.auth).not.toHaveBeenCalled();
    expect(h.planner).not.toHaveBeenCalled();
    expect(launches()).toEqual([]);
    expect(sessions()).toBe(before);
  });

  it.each([selectedModel, 'auto'])('keeps the phone low pin through planner selection, session receipt and turn dispatch (%s)', async (model) => {
    const response = await mint(request('symon/text-session', { model, effort: 'low' }));
    expect(response.status).toBe(200);
    const { session } = await response.json();
    expect(h.planner).toHaveBeenCalledWith(expect.objectContaining({ effort: 'low' }));
    expect(session.effort).toBe('low');
    expect(loadSymonTextSession(session.sessionId)).toMatchObject({ effort: 'low', allowDefaultFallback: false });
    const turnRequest = request('symon/text-turn', {
      sessionId: session.sessionId, turnId: 'fixture-turn', prompt: 'Fixture question',
      planner: { engine: session.engine, model: session.model, effort: session.effort },
    });
    // The admitted device's socket server invokes this internal loopback hop.
    turnRequest.headers.set('x-o8-client-addr', '127.0.0.1');
    const answer = await runTurn(turnRequest);
    expect(h.turn).toHaveBeenCalledWith(expect.objectContaining({ planner: expect.objectContaining({ effort: 'low', allowDefaultFallback: false }) }), expect.any(Number));
    expect((await answer.json()).result.effort).toBe('low');
  });

  it.each(['null', '[]', '{', JSON.stringify({ effort: 'low', padding: 'x'.repeat(4_096) })])('refuses an unreadable or oversized context instead of dropping its pin', async (body) => {
    const before = sessions();
    const response = await mint(new NextRequest('http://localhost/api/mobile/symon/text-session', {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body,
    }));
    expect(response.status).toBe(400);
    expect(h.auth).not.toHaveBeenCalled();
    expect(h.planner).not.toHaveBeenCalled();
    expect(sessions()).toBe(before);
  });

  it('retains the default planner policy when both selections are omitted', async () => {
    const response = await mint(request('symon/text-session', {}));
    expect(response.status).toBe(200);
    expect(h.planner).toHaveBeenCalledWith(undefined);
    expect((await response.json()).session.effort).toBe('high');
  });

  it('refuses a planner receipt that changes a concrete effort pin before persisting it', async () => {
    h.reportedEffort = 'medium';
    const before = sessions();
    const response = await mint(request('symon/text-session', { model: selectedModel, effort: 'low' }));
    expect(response.status).toBe(409);
    expect(sessions()).toBe(before);
  });

  it('refuses a concrete effort on a surface that cannot honor it', async () => {
    writeSymonTextBrainMode('pi');
    const before = sessions();
    const response = await mint(request('symon/text-session', { model: selectedModel, effort: 'low' }));
    expect(response.status).toBe(400);
    expect(h.planner).not.toHaveBeenCalled();
    expect(sessions()).toBe(before);
  });
});
