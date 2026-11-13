import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { SymonBrain } from '@/lib/symon/durable/brain';
import { writeSymonTextBrainMode } from '@/lib/symon/durable/text-brain-setting';
import { SYMON_MANAGED_MODEL } from '@/lib/symon/durable/managed-provider';

const h = vi.hoisted(() => ({ readPlanner: vi.fn(), pollTurn: vi.fn(), model: 'auto', codexReady: true }));

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/mobile/symon-text-bridge-client', () => ({
  readSymonTextPlannerInfo: h.readPlanner,
  pollSymonTextTurn: h.pollTurn,
  pollSymonTextInterrupt: vi.fn(),
}));
vi.mock('@/lib/auth/principal', () => ({ resolveRequestPrincipal: () => 'operator' }));
vi.mock('@/lib/mobile/symon-agent-context', () => ({
  readSymonAgentContext: async () => ({ model: h.model }),
  resolveSymonAgentScope: async () => ({ workspaceMode: 'o8', repoId: null, repoPath: null }),
}));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  getRuntimeAuthSnapshotForClaudeCarrier: async () => ({ statuses: {
    claude: { installed: true, ready: true }, codex: { installed: true, ready: h.codexReady },
  } }),
}));

import { POST as mintTextSession } from '@/app/api/mobile/symon/text-session/route';
import { DELETE as stopTextTurn, POST as runTextTurn } from '@/lib/symon/http/text-turn';

type BrainGlobal = { __o8SymonBrain?: Promise<SymonBrain> };

let dataDir: string;
let previousDataDir: string | undefined;
let brain: SymonBrain;
let faux: ReturnType<typeof fauxProvider>;

beforeEach(async () => {
  previousDataDir = process.env.CORTEX_IDE_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'symon-phone-pi-'));
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
  h.model = 'auto';
  h.codexReady = true;
  h.readPlanner.mockReset();
  h.pollTurn.mockReset();
  faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  brain = await SymonBrain.open({ storagePath: join(dataDir, 'symon', 'durable.sqlite'), models, model: { provider: model.provider, modelId: model.id } });
  (globalThis as BrainGlobal).__o8SymonBrain = Promise.resolve(brain);
});

afterEach(async () => {
  delete (globalThis as BrainGlobal).__o8SymonBrain;
  await brain.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previousDataDir;
});

const mintRequest = () => new NextRequest('http://localhost/api/mobile/symon/text-session', { method: 'POST', body: '{}' });
const turnRequest = (body: object) => new NextRequest('http://localhost/api/mobile/symon/text-turn', { method: 'POST', body: JSON.stringify(body) });

async function mint() {
  const response = await mintTextSession(mintRequest());
  return { status: response.status, body: await response.json() };
}

describe('phone text sessions on the durable Pi brain (#3453)', () => {
  it('binds a new phone session to the Pi brain on auto when the desktop bridge is unavailable, and answers on it', async () => {
    h.readPlanner.mockRejectedValue(new Error('Symon text planner bridge is not mounted.'));
    faux.setResponses([fauxAssistantMessage('Phone answer.'), fauxAssistantMessage('Second answer.')]);

    const minted = await mint();
    expect(minted.status).toBe(200);
    expect(minted.body.session).toMatchObject({ engine: 'pi', model: SYMON_MANAGED_MODEL.id, effort: 'default' });
    const { sessionId, engine, model, effort } = minted.body.session;
    const planner = { engine, model, effort };

    const first = await (await runTextTurn(turnRequest({ sessionId, turnId: 't1', prompt: 'formatted prompt', text: 'Hello', planner }))).json();
    expect(first).toEqual({ ok: true, state: 'done', result: { status: 'done', text: 'Phone answer.', model, effort } });
    // A repeated poll of the same turn reaches the same answer.
    expect(await (await runTextTurn(turnRequest({ sessionId, turnId: 't1', prompt: 'formatted prompt', text: 'Hello', planner }))).json()).toEqual(first);
    await runTextTurn(turnRequest({ sessionId, turnId: 't2', prompt: 'formatted prompt', text: 'And then?', planner }));

    expect(faux.state.callCount).toBe(2);
    expect(h.pollTurn).not.toHaveBeenCalled();
    expect((await brain.transcript(`phone:${sessionId}`))?.map((entry) => entry.text)).toEqual(['Hello', 'Phone answer.', 'And then?', 'Second answer.']);
    expect((await brain.summary(`phone:${sessionId}`))?.source).toBe('phone');
  });

  it('binds to the Pi brain when the phone asks for the managed model or the operator chose it', async () => {
    h.model = 'managed-free';
    expect((await mint()).body.session.engine).toBe('pi');
    h.model = 'auto';
    writeSymonTextBrainMode('pi');
    h.readPlanner.mockResolvedValue({ available: true, engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', tools: [] });
    expect((await mint()).body.session.engine).toBe('pi');
    expect(h.readPlanner).not.toHaveBeenCalled();
  });

  it('keeps native planners and explicit pins as before', async () => {
    h.readPlanner.mockResolvedValue({ available: true, engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', tools: [] });
    expect((await mint()).body.session.engine).toBe('codex');

    h.model = 'codex-sol-xhigh';
    h.codexReady = false;
    expect((await mint()).status).toBe(503);

    writeSymonTextBrainMode('planner');
    h.model = 'auto';
    h.readPlanner.mockRejectedValue(new Error('Symon text planner bridge is not mounted.'));
    expect((await mint()).status).toBe(503);
    h.readPlanner.mockResolvedValue({ available: false, detail: 'no agent CLI found' });
    expect((await mint()).status).toBe(501);
  });

  it('refuses a Pi turn on a native session and a native turn on a Pi session', async () => {
    h.readPlanner.mockResolvedValue({ available: true, engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', tools: [] });
    const native = (await mint()).body.session;
    const asPi = await runTextTurn(turnRequest({ sessionId: native.sessionId, turnId: 'x', prompt: 'p', text: 'Hi', planner: { engine: 'pi', model: SYMON_MANAGED_MODEL.id, effort: 'default' } }));
    expect(asPi.status).toBe(409);

    writeSymonTextBrainMode('pi');
    const pi = (await mint()).body.session;
    const asNative = await runTextTurn(turnRequest({ sessionId: pi.sessionId, turnId: 'y', prompt: 'p', text: 'Hi', planner: { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' } }));
    expect(asNative.status).toBe(409);
    expect(h.pollTurn).not.toHaveBeenCalled();
    expect(faux.state.callCount).toBe(0);
  });

  it('stops a running Pi turn from the phone', async () => {
    writeSymonTextBrainMode('pi');
    faux.setResponses([async (_context, options) => {
      await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'Stopped' });
    }]);
    const { sessionId, engine, model, effort } = (await mint()).body.session;

    expect(await (await runTextTurn(turnRequest({ sessionId, turnId: 'slow', prompt: 'p', text: 'Take your time', planner: { engine, model, effort } }))).json())
      .toEqual({ ok: true, state: 'pending' });
    const stopped = await stopTextTurn(new NextRequest('http://localhost/api/mobile/symon/text-turn', { method: 'DELETE', body: JSON.stringify({ sessionId, turnId: 'slow' }) }));

    expect(await stopped.json()).toEqual({ ok: true, state: 'done' });
    const after = await (await runTextTurn(turnRequest({ sessionId, turnId: 'slow', prompt: 'p', text: 'Take your time', planner: { engine, model, effort } }))).json();
    expect(after.state).toBe('error');
  });

  it('records a native phone answer into the brain thread for the Symon tab', async () => {
    h.readPlanner.mockResolvedValue({ available: true, engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', tools: [] });
    const { sessionId, engine, model, effort } = (await mint()).body.session;
    h.pollTurn.mockResolvedValue({ state: 'done', result: { status: 'done', text: 'Native answer.', model, effort } });

    await runTextTurn(turnRequest({ sessionId, turnId: 'n1', prompt: 'formatted prompt', text: 'Native question', planner: { engine, model, effort } }));

    await vi.waitFor(async () => expect((await brain.transcript(`phone:${sessionId}`))?.map((entry) => entry.text))
      .toEqual(['Native question', 'Native answer.']));
    expect(faux.state.callCount).toBe(0);
  });
});
