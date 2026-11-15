import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { ensureV56ManagedSymonMessagesSchema } from '@/lib/db/v56-managed-symon-messages-migration';
import { ManagedSymonMessagesStore } from '@/lib/symon/managed-messages-store';
import { SymonBrain } from '@/lib/symon/durable/brain';
import { writeSymonTextBrainMode } from '@/lib/symon/durable/text-brain-setting';

const h = vi.hoisted(() => ({ store: null as unknown, readPlanner: vi.fn(), pollTurn: vi.fn() }));

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/symon/managed-messages-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/symon/managed-messages-store')>(),
  getManagedSymonMessagesStore: () => h.store,
}));
vi.mock('@/lib/chat/gateway-client', () => ({ generateSharedSymonText: vi.fn() }));
vi.mock('@/lib/mobile/symon-text-bridge-client', () => ({
  readSymonTextPlannerInfo: h.readPlanner,
  pollSymonTextTurn: h.pollTurn,
}));

type BrainGlobal = { __o8SymonBrain?: Promise<SymonBrain> };

let dataDir: string;
let previousDataDir: string | undefined;
let sqlite: Database.Database;
let store: ManagedSymonMessagesStore;
const opened: SymonBrain[] = [];

async function installBrain(faux = fauxProvider()) {
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const brain = await SymonBrain.open({
    storagePath: join(dataDir, 'symon', 'durable.sqlite'),
    models,
    model: { provider: model.provider, modelId: model.id },
  });
  opened.push(brain);
  (globalThis as BrainGlobal).__o8SymonBrain = Promise.resolve(brain);
  return { brain, faux };
}

async function route() {
  return (await import('@/lib/symon/http/managed-inbound')).POST;
}

function request(overrides: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/symon/managed-messages/inbound', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventId: 'imessage:message-1',
      conversationId: 'imessage:direct:+15555550100',
      messageId: 'message-1',
      sender: '+15555550100',
      recipient: 'imessage',
      text: 'What is on my calendar?',
      context: '',
      ...overrides,
    }),
  });
}

beforeEach(() => {
  vi.resetModules();
  previousDataDir = process.env.CORTEX_IDE_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'symon-pi-brain-route-'));
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
  sqlite = new Database(':memory:');
  ensureV56ManagedSymonMessagesSchema(sqlite);
  store = new ManagedSymonMessagesStore(sqlite);
  h.store = store;
  h.readPlanner.mockReset();
  h.pollTurn.mockReset();
});

afterEach(async () => {
  delete (globalThis as BrainGlobal).__o8SymonBrain;
  await Promise.all(opened.splice(0).map((brain) => brain.close().catch(() => {})));
  sqlite.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previousDataDir;
});

describe('managed messages on the durable Pi brain (#3453)', () => {
  it('answers on the Pi brain when selected, without the desktop planner', async () => {
    writeSymonTextBrainMode('pi');
    const { faux } = await installBrain();
    faux.setResponses([fauxAssistantMessage('Two meetings today.')]);
    const POST = await route();

    const response = await POST(request());

    expect(await response.json()).toEqual({ ok: true, state: 'done', text: 'Two meetings today.' });
    expect(h.readPlanner).not.toHaveBeenCalled();
    expect(h.pollTurn).not.toHaveBeenCalled();
    expect(store.getConversation('imessage:direct:+15555550100').transcript).toEqual([
      { role: 'user', text: 'What is on my calendar?' },
      { role: 'assistant', text: 'Two meetings today.' },
    ]);
    // A repeated delivery returns the stored answer without another model call.
    expect(await (await POST(request())).json()).toEqual({ ok: true, state: 'done', text: 'Two meetings today.' });
    expect(faux.state.callCount).toBe(1);
  });

  it('falls back to the Pi brain on auto when the desktop bridge is unavailable', async () => {
    const { faux } = await installBrain();
    faux.setResponses([fauxAssistantMessage('Answered without a CLI.')]);
    h.readPlanner.mockRejectedValue(new Error('Symon text planner bridge is not mounted.'));
    const POST = await route();

    expect(await (await POST(request())).json()).toEqual({ ok: true, state: 'done', text: 'Answered without a CLI.' });
  });

  it('falls back to the Pi brain on auto when no planner CLI is installed', async () => {
    const { faux } = await installBrain();
    faux.setResponses([fauxAssistantMessage('Still here.')]);
    h.readPlanner.mockResolvedValue({ available: false, detail: 'no agent CLI found' });
    const POST = await route();

    expect(await (await POST(request())).json()).toEqual({ ok: true, state: 'done', text: 'Still here.' });
  });

  it('keeps the planner on planner mode and reports the missing CLI as before', async () => {
    writeSymonTextBrainMode('planner');
    const { faux } = await installBrain();
    h.readPlanner.mockResolvedValue({ available: false, detail: 'no agent CLI found' });
    const POST = await route();

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'no_cli' });
    expect(faux.state.callCount).toBe(0);
  });

  it('gives the Pi brain the thread turns the planner answered', async () => {
    const { faux } = await installBrain();
    const prompts: string[] = [];
    faux.setResponses([(context) => {
      prompts.push(JSON.stringify(context.messages.at(-1)));
      return fauxAssistantMessage('Following up.');
    }]);
    store.getOrCreateTurn({
      eventId: 'imessage:message-0', conversationId: 'imessage:direct:+15555550100', providerMessageId: 'message-0',
      senderHandle: '+15555550100', recipientHandle: 'imessage', text: 'Earlier question', now: Date.now(),
    });
    store.appendConversation({
      conversationId: 'imessage:direct:+15555550100',
      sessionId: 'planner-session',
      entries: [{ role: 'user', text: 'Book the venue tour' }, { role: 'assistant', text: 'The tour is Friday at 3.' }],
      now: Date.now(),
    });
    h.readPlanner.mockRejectedValue(new Error('Symon text planner bridge is not mounted.'));
    const POST = await route();

    expect(await (await POST(request({ text: 'What time again?' }))).json()).toMatchObject({ text: 'Following up.' });
    expect(prompts[0]).toContain('The tour is Friday at 3.');
    expect(prompts[0]).toContain('What time again?');
  });

  it('finishes a turn a restart interrupted instead of asking the sender to repeat it', async () => {
    writeSymonTextBrainMode('pi');
    const firstFaux = fauxProvider();
    firstFaux.setResponses([async (_context, options) => {
      await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'Stopped' });
    }]);
    const { brain: first } = await installBrain(firstFaux);
    const firstRoute = await route();

    const inFlight = firstRoute(request());
    await vi.waitFor(() => expect(firstFaux.state.callCount).toBe(1));
    // The o8 server stops: its brain closes mid-turn and the route module goes with it.
    await first.close();
    opened.splice(opened.indexOf(first), 1);
    const interrupted = await inFlight;
    expect(interrupted.status).not.toBe(200);
    vi.resetModules();

    const secondFaux = fauxProvider();
    secondFaux.setResponses([fauxAssistantMessage('Your calendar is clear.')]);
    await installBrain(secondFaux);
    const restartedRoute = await route();

    const response = await restartedRoute(request());

    expect(await response.json()).toEqual({ ok: true, state: 'done', text: 'Your calendar is clear.' });
    expect(secondFaux.state.callCount).toBe(1);
    expect(store.getConversation('imessage:direct:+15555550100').transcript.filter((entry) => entry.role === 'user')).toHaveLength(1);
  });

  it('records planner-answered turns into the brain thread and builds on them', async () => {
    const { brain, faux } = await installBrain();
    const contexts: string[] = [];
    faux.setResponses([(context) => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage('Pi follow-up.'); }]);
    h.readPlanner.mockResolvedValue({ available: true, engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', tools: [] });
    h.pollTurn.mockResolvedValue({ state: 'done', result: { status: 'done', text: 'Planner answer.', model: 'gpt-6.1-sol', effort: 'high' } });
    const POST = await route();

    expect(await (await POST(request({ text: 'Planner question' }))).json()).toMatchObject({ text: 'Planner answer.' });
    await vi.waitFor(async () => expect(await brain.transcript('imessage:direct:+15555550100')).toHaveLength(2));

    // The thread's planner session is still live, so the operator switches the brain.
    writeSymonTextBrainMode('pi');
    expect(await (await POST(request({ eventId: 'imessage:message-2', messageId: 'message-2', text: 'Pi question' }))).json())
      .toMatchObject({ text: 'Pi follow-up.' });

    expect(contexts[0]).toContain('Planner answer.');
    expect(contexts[0]).not.toContain('Earlier in this thread');
    expect((await brain.transcript('imessage:direct:+15555550100'))?.map((entry) => entry.text))
      .toEqual(['Planner question', 'Planner answer.', 'Pi question', 'Pi follow-up.']);
  });
});
