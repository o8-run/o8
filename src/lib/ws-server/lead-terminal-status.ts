import { waitForLead } from '@/lib/orchestrator/lead-lifecycle';

/** Bridge an admitted persistent lead turn to the existing chat event stream. */
export async function sendLeadTerminalStatus(
  send: (message: Record<string, unknown>) => void, leadId: string, turnId: string, afterCursor: number,
  userMessageId = `lead-user-${turnId}`,
): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  let cursor = afterCursor;
  while (Date.now() < deadline) {
    const receipt = await waitForLead({
      leadId,
      turnId,
      afterCursor: cursor,
      waitMs: Math.min(30_000, deadline - Date.now()),
    });
    cursor = receipt.cursor;
    const leadStatus = receipt.lead.status;
    const status = leadStatus === 'stopped' ? 'stopped' : receipt.requestedTurn?.status;
    if (!status || status === 'queued' || status === 'running' || status === 'waiting_workers') continue;
    const assistantText = receipt.requestedTurn?.resultText
      ?? receipt.requestedTurn?.outcome?.summary
      ?? receipt.requestedTurn?.error
      ?? '';
    if (assistantText) {
      send({
        channel: 'orchestrator',
        event: 'output',
        data: {
          text: assistantText,
          repoPath: receipt.lead.repoPath,
          threadId: receipt.lead.threadId,
          backend: receipt.lead.routing.backend,
          assistantMessageId: `lead-assistant-${receipt.requestedTurn?.id}`,
        },
      });
    }
    send({
      channel: 'orchestrator',
      event: 'status',
      data: {
        status: status === 'failed' || status === 'stopped' ? 'dead' : status === 'unreported' ? 'unreported' : 'ready',
        outcome: receipt.requestedTurn?.outcome ?? null,
        reason: receipt.requestedTurn?.reason ?? null,
        leadStatus: status,
        repoPath: receipt.lead.repoPath,
        threadId: receipt.lead.threadId,
        backend: receipt.lead.routing.backend,
        lead: receipt.lead,
        admittedTurnId: turnId,
        voiceTerminal: { userMessageId, text: assistantText,
          outcome: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'unconfirmed' },
      },
    });
    return;
  }
}
