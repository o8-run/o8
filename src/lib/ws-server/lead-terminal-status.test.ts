import { describe, expect, it, vi } from 'vitest';
import { sendLeadTerminalStatus } from './lead-terminal-status';

const { waitForLead } = vi.hoisted(() => ({ waitForLead: vi.fn() }));
vi.mock('@/lib/orchestrator/lead-lifecycle', () => ({ waitForLead }));

describe('lead caller notices', () => {
  it.each(['unreported', 'completed'])('publishes %s with the outcome and reason', async (status) => {
    const outcome = status === 'completed'
      ? { kind: 'completed', summary: 'Verified', evidence: ['checks passed at revision abc'] }
      : null;
    const reason = outcome ? 'Verified' : 'turn ended without an outcome report';
    waitForLead.mockResolvedValue({ cursor: 1,
      lead: { status, repoPath: '/repo', threadId: 'thread', routing: { backend: 'codex' } },
      requestedTurn: { id: 'turn', status, outcome, reason, resultText: 'Provider text' },
    });
    const send = vi.fn();
    await sendLeadTerminalStatus(send, 'lead', 'turn', 0);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      event: 'status', data: expect.objectContaining({
        status: status === 'unreported' ? 'unreported' : 'ready',
        leadStatus: status, outcome, reason,
      }),
    }));
  });
});
