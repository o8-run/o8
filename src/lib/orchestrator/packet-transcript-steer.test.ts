import { describe, expect, it, vi } from 'vitest';

const registryMock = vi.hoisted(() => ({
  lanes: [{ id: 'lane-1', sessionKey: 'codex-owned:abc', packetId: 'pkt-1' }],
  events: [
    {
      id: 'evt-1',
      laneId: 'lane-1',
      verb: 'steered_packet',
      actor: 'orchestrator',
      payload: { packetId: 'pkt-1', source: 'orchestrator', message: 'Use the new plan.' },
      timestamp: '2026-07-05T12:00:00.000Z',
    },
    {
      id: 'evt-2',
      laneId: 'lane-1',
      verb: 'steer_failed',
      actor: 'orchestrator',
      payload: {
        packetId: 'pkt-1',
        source: 'heal-bot',
        message: 'Retry startup.',
        note: 'Steer failed to start',
        stderrHead: 'codex exited 1',
      },
      timestamp: '2026-07-05T12:00:02.000Z',
    },
  ],
}));

// Partial mock: other modules in this import graph bind registry exports at
// load time, so a replacement factory rots the moment the registry grows one.
vi.mock('@/lib/lane/registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/lane/registry')>(),
  getLaneEvents: vi.fn(() => registryMock.events),
  listLanes: vi.fn(() => registryMock.lanes),
}));

describe('packet transcript steer events', () => {
  it('projects steer lane events into renderable transcript events', async () => {
    const { readSessionSteerTranscriptEvents } = await import('./packet-transcript');

    expect(readSessionSteerTranscriptEvents('codex-owned:abc')).toEqual([
      {
        seq: 1,
        ts: '2026-07-05T12:00:00.000Z',
        type: 'steer',
        source: 'orchestrator',
        text: 'Use the new plan.',
        failed: false,
      },
      {
        seq: 2,
        ts: '2026-07-05T12:00:02.000Z',
        type: 'steer',
        source: 'heal-bot',
        text: 'Retry startup.',
        failed: true,
        note: 'Steer failed to start\ncodex exited 1',
      },
    ]);
  });
});

it('adds durable lane event identity only for an explicit native projection', async () => {
  const { readSessionSteerTranscriptEvents } = await import('./packet-transcript');
  expect(readSessionSteerTranscriptEvents('codex-owned:abc', true)).toMatchObject([
    { eventId: 'evt-1', text: 'Use the new plan.' },
    { eventId: 'evt-2', text: 'Retry startup.' },
  ]);
});
