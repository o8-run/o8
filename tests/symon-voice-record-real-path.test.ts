// @vitest-environment jsdom
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModels, fauxProvider } from '@earendil-works/pi-ai';
import { SymonBrain } from '@/lib/symon/durable/brain';
import type { StartRealtimeOptions } from '@/lib/voice/realtime-client';

const h = vi.hoisted(() => ({ sessions: [] as Array<{ onEvent?: (event: Record<string, unknown>) => void }> }));

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/voice/realtime-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/voice/realtime-client')>(),
  startRealtimeSession: (options: StartRealtimeOptions) => {
    h.sessions.push(options);
    return { stop: async () => {}, appendText: async () => {}, appendSpeech: async () => {}, mode: 'openai-byok', status: 'live' };
  },
}));

import { POST as recordRoute } from '@/lib/symon/http/record';
import { RealtimeVoiceHost } from '@/components/desktop/dictation/RealtimeVoiceHost';
import { createSymonVoiceTranscriptRecorder } from '@/lib/symon/voice-transcript-recorder';

type BrainGlobal = { __o8SymonBrain?: Promise<SymonBrain> };

let dir: string;
let brain: SymonBrain;
let root: Root | null = null;
const posted: unknown[] = [];

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  dir = mkdtempSync(join(tmpdir(), 'symon-voice-record-'));
  h.sessions = [];
  posted.length = 0;
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  brain = await SymonBrain.open({ storagePath: join(dir, 'durable.sqlite'), models, model: { provider: model.provider, modelId: model.id }, o8Servers: null });
  (globalThis as BrainGlobal).__o8SymonBrain = Promise.resolve(brain);
  // The webview's fetch reaches the real record route.
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url === '/api/voice/live') return Response.json({ enabled: false });
    posted.push(JSON.parse(String(init.body)));
    return recordRoute(new NextRequest(`http://localhost${url}`, { method: init.method, headers: init.headers as HeadersInit, body: init.body as string }));
  });
});

afterEach(async () => {
  if (root) act(() => root!.unmount());
  root = null;
  vi.unstubAllGlobals();
  delete (globalThis as BrainGlobal).__o8SymonBrain;
  await brain.close();
  rmSync(dir, { recursive: true, force: true });
});

const userLine = (itemId: string, transcript: string) => ({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript });
const symonLine = (itemId: string, transcript: string) => ({ type: 'response.output_audio_transcript.done', item_id: itemId, response_id: `resp_${itemId}`, transcript });

async function texts(key: string) {
  return (await brain.transcript(key))?.map((entry) => `${entry.role}: ${entry.text}`);
}

describe('voice sessions recorded into the Symon store (#3455)', () => {
  it('records a desktop voice session from the voice host into one voice thread', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(createElement(RealtimeVoiceHost)));
    await act(async () => { window.dispatchEvent(new Event('o8:symon-voice-toggle')); });
    expect(h.sessions).toHaveLength(1);
    const onEvent = h.sessions[0].onEvent!;

    onEvent(userLine('item_1', 'What is running right now?'));
    onEvent({ type: 'response.output_audio_transcript.delta', item_id: 'item_2', delta: 'Two' });
    onEvent(symonLine('item_2', 'Two packets are running.'));
    onEvent(symonLine('item_2', 'Two packets are running.'));

    await vi.waitFor(() => expect(posted).toHaveLength(3));
    const key = (posted[0] as { key: string }).key;
    expect(key).toMatch(/^voice:[A-Za-z0-9_-]+$/);
    await vi.waitFor(async () => expect(await texts(key)).toEqual(['user: What is running right now?', 'assistant: Two packets are running.']));
    expect((await brain.list()).find((thread) => thread.key === key)).toMatchObject({ source: 'voice', title: 'Voice' });
  });

  it('starts a new thread for the next voice session', async () => {
    const first = createSymonVoiceTranscriptRecorder(undefined, 'session-a');
    const second = createSymonVoiceTranscriptRecorder(undefined, 'session-b');
    first.observe(userLine('item_1', 'First session'));
    second.observe(userLine('item_1', 'Second session'));
    await Promise.all([first.flush(), second.flush()]);

    expect(await texts('voice:session-a')).toEqual(['user: First session']);
    expect(await texts('voice:session-b')).toEqual(['user: Second session']);
  });

  it('skips empty lines and keeps recording after a failed write', async () => {
    let fail = true;
    const recorder = createSymonVoiceTranscriptRecorder(async (body) => {
      if (fail) { fail = false; throw new Error('offline'); }
      return fetch('/api/panel/symon/conversations/record', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    }, 'session-c');

    recorder.observe(userLine('item_1', 'Lost while offline'));
    recorder.observe(userLine('item_2', '   '));
    recorder.observe({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'item_3' });
    recorder.observe(symonLine('item_4', 'Back online.'));
    await recorder.flush();

    expect(await texts('voice:session-c')).toEqual(['assistant: Back online.']);
  });
});
