import { randomUUID } from 'node:crypto';
import { lane, laneResult, scope } from './scope';
import { pause, request, required, str, trim, type Args, type Json } from './transport';
export async function control(tool: string, args: Args, signal: AbortSignal): Promise<unknown> {
  if (tool === 'o8_dispatch' || tool === 'o8_delegate') {
    const task = required(args, 'task'), repo = await scope(args, signal, tool === 'o8_dispatch');
    if (!repo) {
      const r = await request('/api/canvas/intent', signal, { verb: 'send-prompt', args: { text: task }, ensure: true, origin: 'symon' });
      return { ok: true, delegated: true, task, to: 'the live in-app orchestrator', navigated: r.navigated === true };
    }
    if (tool === 'o8_delegate') {
      const body: Json = { repoId: repo.id, repoPath: repo.path, task, source: 'symon-code' };
      if (trim(args, '__symonSessionId')) body.sessionId = trim(args, '__symonSessionId');
      if (trim(args, '__symonCallId')) body.callId = trim(args, '__symonCallId');
      const r = await request('/symon-orchestrator-turn', signal, body, true);
      return { accepted: r.accepted === true, repoId: repo.id, repoPath: repo.path, task, sessionId: r.sessionId ?? null, turnId: r.turnId ?? null, requestId: r.requestId ?? null, taskId: r.taskId ?? null, note: r.note ?? r.error ?? null };
    }
    const body: Json = { prompt: task, repoPath: repo.path, taskName: [...task].slice(0, 60).join(''), clientMutationId: `symon-dispatch-${randomUUID()}` };
    if (str(args, 'base_branch')) body.baseBranch = str(args, 'base_branch');
    const r = await request('/api/orchestrator/delegate', signal, body, false, true);
    const common = { repoId: repo.id, repoPath: repo.path, packetId: str(r, 'packetId'), codename: str(r, 'codename') };
    return r.ok === true ? { dispatched: true, ...common, laneId: str(r, 'laneId'), repo: repo.name }
      : { dispatched: false, ...common, approvalId: str(r, 'approvalId'), note: str(r, 'note') || 'The orchestrator queued the task pending approval.' };
  }
  const key = tool === 'o8_stop_agent' || (tool === 'o8_agent_task' && trim(args, 'laneId')) ? 'laneId' : 'packetId';
  let message = '';
  if (tool === 'o8_agent_task') {
    message = (typeof args.task === 'string' ? str(args, 'task') : str(args, 'message')).trim();
    if (!message) throw new Error("o8_agent_task needs a 'task'");
    if (Boolean(trim(args, 'laneId')) === Boolean(trim(args, 'packetId'))) throw new Error('o8_agent_task requires exactly one of laneId or packetId');
  }
  if (tool === 'o8_packet_steer') message = required(args, 'message');
  const l = await lane(args, key, signal), target = laneResult(l);
  if (tool === 'o8_packet_wait') {
    let last = 'working';
    for (let i = 0; i < 6; i++) {
      try {
        const r = await request(`/api/orchestrator/review-state?packetId=${encodeURIComponent(target.packetId)}`, signal);
        if (typeof r.state === 'string') {
          last = r.state;
          if (last !== 'working') return { ok: true, ...target, state: last, ready: last === 'ready-to-merge' };
        }
      } catch { signal.throwIfAborted(); }
      await pause(2000, signal);
    }
    return { ok: true, ...target, state: last, ready: false, note: 'still working after ~12s — ask again to keep waiting' };
  }
  let path: string, body: Json;
  const mutation = `symon-${randomUUID()}`;
  const keep = typeof args.keepWorktree === 'boolean' ? args.keepWorktree : args.keep_worktree === true;
  switch (tool) {
    case 'o8_packet_reset':
      path = '/api/orchestrator/reset-packet'; body = { packetId: target.packetId, clearWorktree: !keep, idempotencyKey: mutation };
      if (trim(args, 'reason')) body.reason = trim(args, 'reason');
      break;
    case 'o8_stop_agent':
      path = '/api/agent-control/action'; body = { ref: { kind: 'packet', id: target.packetId }, action: { kind: 'terminate' }, clientMutationId: mutation }; break;
    case 'o8_packet_rerun':
      path = '/api/orchestrator/rerun-with-feedback'; body = { packetId: target.packetId, feedback: trim(args, 'feedback') || 'Retry: the previous attempt did not land. Re-read the task and try again carefully.', idempotencyKey: mutation }; break;
    default:
      if (key === 'laneId') {
        path = '/api/agent-control/action'; body = { ref: { kind: 'lane', id: target.laneId }, action: { kind: 'send_turn', message }, clientMutationId: mutation };
      } else {
        path = '/api/orchestrator/steer-packet'; body = { packetId: target.packetId, message, source: tool === 'o8_agent_task' ? 'symon-agent-task' : 'symon', idempotencyKey: mutation };
      }
  }
  const r = await request(path, signal, body, false, true);
  if (tool === 'o8_packet_reset') return { ok: true, ...target, worktree: keep ? 'kept' : 'wiped', redispatched: false, note: 'reset exactly this packet; it was not relaunched because o8 has no packet-scoped relaunch endpoint' };
  if (tool === 'o8_stop_agent') return { ok: true, ...target, reaped: (r.result as Json | undefined)?.interruptedSessions ?? 0, note: 'stopped the exact lane — killed the process and archived it; not relaunched' };
  if (r.ok === false) throw new Error(str(r, 'note') || str(r, 'error', 'o8 returned an error'));
  return tool === 'o8_packet_rerun' ? { restarted: true, ...target } : { steered: true, ...target, result: r.result ?? r };
}
