import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  fetchMutation: vi.fn(),
  printJson: vi.fn(),
  laneMissing: false,
}));

vi.mock('../../config.js', () => ({ resolveConfig: () => ({ apiBase: 'http://127.0.0.1:47120' }) }));
vi.mock('../../output.js', () => ({
  printHumanHeading: vi.fn(),
  printHumanKv: vi.fn(),
  printJson: h.printJson,
}));
vi.mock('./correlated-mutation.js', () => ({ fetchCorrelatedPacketMutation: h.fetchMutation }));
vi.mock('./target.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./target')>();
  return {
    ...actual,
    resolvePacketTarget: async (target: string) => {
      if (h.laneMissing) throw new CliError('packet_target_not_found', `Explicit packet target ${target} did not resolve.`, EXIT.NOT_FOUND);
      return { packetId: target, laneId: 'lane-1' };
    },
    requirePacketId: (target: { packetId: string }) => target.packetId,
  };
});

import { CliError, EXIT } from '../../api.js';
import { runPacketClose } from './close';

describe('o8 packet discard', () => {
  beforeEach(() => {
    h.fetchMutation.mockReset();
    h.printJson.mockReset();
    h.laneMissing = false;
  });

  it('closes a never-launched packet by its explicit id when no lane exists', async () => {
    h.laneMissing = true;
    h.fetchMutation.mockResolvedValue({
      status: 200,
      data: { ok: true, result: { closed: true, disposition: 'superseded', laneId: null, note: 'Closed unmerged.' } },
    });

    await expect(runPacketClose(
      { human: false, verbose: false },
      ['decompose-1785965515969-5900hy', '--reason', 'superseded'],
    )).resolves.toBe(0);
    expect(h.fetchMutation).toHaveBeenCalledWith(
      expect.anything(),
      '/api/orchestrator/discard-packet',
      expect.objectContaining({ packetId: 'decompose-1785965515969-5900hy', disposition: 'superseded' }),
      expect.anything(),
    );
  });

  it('sends the missing-worktree acknowledgement through the canonical discard route', async () => {
    h.fetchMutation.mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        result: {
          closed: true,
          disposition: 'wontfix',
          laneId: 'lane-1',
          worktreeCleanup: 'missing',
          note: 'Worktree was already missing.',
        },
      },
    });

    await expect(runPacketClose(
      { human: false, verbose: false },
      ['packet-1', '--acknowledge-missing-worktree'],
      'discard',
    )).resolves.toBe(0);

    expect(h.fetchMutation).toHaveBeenCalledWith(
      expect.anything(),
      '/api/orchestrator/discard-packet',
      expect.objectContaining({
        packetId: 'packet-1',
        disposition: 'wontfix',
        acknowledgeMissingWorktree: true,
        clientMutationId: expect.any(String),
      }),
      expect.anything(),
    );
    expect(h.printJson).toHaveBeenCalledWith(expect.objectContaining({
      schema: 'o8/cli/packet.discard/v1',
      packet: expect.objectContaining({ worktreeCleanup: 'missing' }),
    }));
  });
});
