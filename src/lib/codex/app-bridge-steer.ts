import type { ChildProcess } from 'node:child_process';
import type { CodexOrchestratorSession } from '@/lib/lane/codex-orchestrator-session';
import type { OrchestratorBackend, OrchestratorTurnOptions } from '@/lib/lane/orchestrator-backends/types';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { createCodexSteerRelay } from './app-bridge-steer-relay';
import { assertCodexLiveSteerEffort } from './app-bridge-steer-effort';

type LiveSteer = NonNullable<OrchestratorBackend['liveSteer']>;
type Route = Pick<OrchestratorTurnOptions, 'model' | 'permissionMode' | 'toolProfile' | 'orchestrationMode'>;
const bridges = new WeakMap<CodexOrchestratorSession, { running: () => boolean; steer: LiveSteer }>();
const ACK_TIMEOUT_MS = 10_000;

/** IPC exists only for a bridge owned by this server, never a recovered exec. */
export function registerCodexAppBridgeSteer(session: CodexOrchestratorSession, proc: ChildProcess, route: Route): () => void {
  let threadId: string | null = null;
  let turnId: string | null = null;
  const pending = new Map<string, { resolve: (result: { accepted: boolean }) => void; reject: (error: Error) => void }>();
  const attempted = new Set<string>();
  const running = () => session.status === 'busy' && session.proc === proc && proc.connected && !proc.killed && Boolean(threadId && turnId);
  const publishCapability = () => {
    relay?.publish();
    if (!session.historyThreadId) return;
    void publishRealtimeMutation({ mutation: { mutationId: `codex-steer-${session.historyThreadId}-${Date.now()}`,
      source: 'server', action: 'composer-queue', status: 'completed', surfaceId: session.historyThreadId,
      createdAt: new Date().toISOString() } }).catch(() => {});
  };
  const onMessage = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const message = value as Record<string, unknown>;
    if (message.type === 'codex.bridge.turn') {
      threadId = typeof message.threadId === 'string' ? message.threadId : null;
      turnId = typeof message.turnId === 'string' ? message.turnId : null;
      publishCapability();
    } else if (message.type === 'codex.bridge.steer.result' && typeof message.id === 'string') {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.accepted === true || message.accepted === false) waiter.resolve({ accepted: message.accepted });
      else waiter.reject(new Error('Codex steer acknowledgement was not confirmed.'));
    }
  };
  proc.on('message', onMessage);
  const close = () => {
    const hadTurn = Boolean(turnId);
    threadId = turnId = null;
    if (hadTurn) publishCapability();
    proc.removeListener('message', onMessage);
    for (const waiter of pending.values()) waiter.reject(new Error('Codex bridge disconnected before steer acknowledgement.'));
    pending.clear();
    relay?.close();
  };
  proc.once('disconnect', close);
  proc.once('close', close);
  const steer: LiveSteer = async (_repoPath, message, options) => {
    if (!running() || options.attachments?.length || options.threadId !== session.historyThreadId || options.model !== route.model
      || (options.orchestrationMode ?? 'fleet') !== (route.orchestrationMode ?? 'fleet')
      || (options.permissionMode ?? 'full') !== route.permissionMode || (options.toolProfile ?? 'full') !== route.toolProfile) return { accepted: false };
    assertCodexLiveSteerEffort(options.thinkingEffort);
    const id = options.clientUserMessageId;
    if (!id || attempted.has(id)) throw new Error('Codex steer requires a unique queued message identity.');
    // No asynchronous preparation after this cancellation/permission fence.
    options.beforeAdmit();
    if (!running()) return { accepted: false };
    attempted.add(id);
    return new Promise<{ accepted: boolean }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Codex steer acknowledgement timed out.'));
      }, ACK_TIMEOUT_MS);
      const done = (action: () => void) => { clearTimeout(timeout); action(); };
      pending.set(id, { resolve: result => done(() => resolve(result)), reject: error => done(() => reject(error)) });
      const failed = () => {
        const waiter = pending.get(id); pending.delete(id);
        waiter?.reject(new Error('Codex bridge could not confirm steer delivery.'));
      };
      try {
        proc.send({ type: 'codex.bridge.steer', id, threadId, expectedTurnId: turnId,
          input: [{ type: 'text', text: message, text_elements: [] }], clientUserMessageId: id }, error => { if (error) failed(); });
      } catch { failed(); }
    });
  };
  const relay = session.historyThreadId ? createCodexSteerRelay({ repoPath: session.repoPath, threadId: session.historyThreadId }, steer, running) : null;
  bridges.set(session, { running, steer });
  return close;
}

export function getCodexAppBridgeSteer(session: CodexOrchestratorSession | null): LiveSteer | undefined {
  const bridge = session && bridges.get(session);
  return bridge?.running() ? bridge.steer : undefined;
}
