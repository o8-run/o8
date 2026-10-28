import { describe, expect, it, vi } from 'vitest';
import { createOrchestratorMessageHandler } from './socket';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

describe('orchestrator error system message (#4963)', () => {
  it('writes the failure line instead of source even when the source resembles an error', () => {
    const ws = {} as WebSocket;
    const messagesRef = { current: [] as MobileTranscriptEntry[] };
    const handler = createOrchestratorMessageHandler({
      captureFirstTurnPlanRef: { current: false }, currentWs: ws,
      currentAssistantRef: { current: null }, eventCountRef: { current: 0 },
      lastSeqRef: { current: 0 }, finalizeFirstTurnPlanCapture: vi.fn(),
      firstTurnPlanChunksRef: { current: [] }, firstTurnPlanStartedRef: { current: false },
      flushCurrentAssistant: vi.fn(), scheduleFlushCurrentAssistant: vi.fn(),
      lastEventAtRef: { current: Date.now() }, messagesRef, resetEpochRef: { current: 0 },
      setMessages: update => { messagesRef.current = typeof update === 'function' ? update(messagesRef.current) : update; },
      setStatus: vi.fn(), statusRef: { current: 'busy' }, wsRef: { current: ws },
    });
    handler({ data: JSON.stringify({ channel: 'orchestrator', event: 'error', data: { error:
      'file:///bundle/bridge.mjs:2\nError: {void 0;}; throw failure;\n  ^\n\nTypeError: turn/start failed\n    at run (bridge.mjs:2:1)' } }) } as MessageEvent);
    expect(messagesRef.current).toMatchObject([{ role: 'system', isError: true, text: 'Orchestrator error: TypeError: turn/start failed' }]);
  });
});
