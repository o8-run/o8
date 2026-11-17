// @vitest-environment jsdom

import { readFileSync, writeFileSync } from 'node:fs';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DesktopWebSocketProvider, useSharedDesktopWs } from '@/components/desktop/hooks/DesktopWebSocketContext';
import { mergeTranscriptEntries } from '@/components/desktop/thoughts/utils';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { transcriptStore } from '@/lib/transcripts/store';
import { buildTranscriptWsCallbacks } from '@/lib/transcripts/wireWsBridge';

vi.mock('@/lib/panel/ws-port-client', () => ({ getBrowserWsPort: () => 47125 }));

// Only the transport is fake. The provider owns boot/sequence/capture filtering;
// the bridge, ID-ordering merger and caller's 200-entry retention are production code.
class RecordingSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: RecordingSocket[] = [];
  readyState = RecordingSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { RecordingSocket.instances.push(this); }
  send() {}
  close() { this.readyState = RecordingSocket.CLOSED; }
}

const callbacks = buildTranscriptWsCallbacks({ merge: mergeTranscriptEntries });
function Bridge() {
  useSharedDesktopWs(undefined, callbacks);
  return null;
}

interface Replay {
  initial: { sessionKey: string; transcript: MobileTranscriptEntry[] };
  frames: Record<string, unknown>[];
}
const directory = 'native/o8-next/fixtures';
const project = (entries: MobileTranscriptEntry[]) => entries.map(({ id, text }) => ({ id, text }));

// Keep the case list tied to the Rust test rather than silently missing a new recording.
const rust = readFileSync('native/o8-next/src/stream.rs', 'utf8');
const cases = rust.match(/fn recorded_streams_match_web\(\)\s*\{\s*for case in \[([^\]]+)\]/)?.[1]
  .match(/"([^"]+)"/g)?.map(name => JSON.parse(name) as string);
if (!cases?.length) throw new Error('Cannot discover Rust recorded stream cases');

for (const name of cases) {
  it(`${name}: recorded transcript IDs, order and text match the current client`, () => {
    if (process.env.O8_STREAM_WRITE === '1' && process.env.CI) {
      throw new Error('O8_STREAM_WRITE is forbidden in CI');
    }
    const replay = JSON.parse(readFileSync(`${directory}/${name}.replay.json`, 'utf8')) as Replay;
    const key = replay.initial.sessionKey;
    const host = document.createElement('div');
    const root = createRoot(host);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('WebSocket', RecordingSocket);
    RecordingSocket.instances = [];
    try {
      transcriptStore.setSlice(key, { messages: replay.initial.transcript, status: 'fresh', lastUpdated: 0 });
      act(() => root.render(createElement(DesktopWebSocketProvider, null, createElement(Bridge))));
      const socket = RecordingSocket.instances[0];
      expect(socket).toBeDefined();
      act(() => {
        socket.readyState = RecordingSocket.OPEN;
        socket.onopen?.();
      });
      for (const frame of replay.frames) {
        act(() => socket.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent));
      }
      const entries = transcriptStore.getSlice(key).messages;
      const path = `${directory}/${name}.entries.json`;
      if (process.env.O8_STREAM_WRITE === '1') {
        // Full entries let the existing native renderer regenerate rows separately.
        // No TypeScript renderer or native-generated transcript oracle is involved.
        writeFileSync(path, `${JSON.stringify({ sessionKey: key, transcript: entries }, null, 2)}\n`);
      } else {
        const rows = JSON.parse(readFileSync(`${directory}/${name}.tree.json`, 'utf8')) as { id: string }[];
        expect(entries.map(entry => entry.id), 'rendered recording must retain the oracle entry order').toEqual(rows.map(row => row.id));
        const expected = JSON.parse(readFileSync(path, 'utf8')) as Replay['initial'];
        expect(project(entries)).toEqual(project(expected.transcript));
      }
    } finally {
      act(() => root.unmount());
      for (const session of new Set([key, 'llm-chat:other'])) transcriptStore.clear(session);
      vi.unstubAllGlobals();
    }
  });
}
