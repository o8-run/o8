import type { IncomingMessage, ServerResponse } from 'node:http';
import { isVoiceBinding, isVoiceTerminal, sameVoiceBinding, voiceHostId, type VoiceBinding, type VoiceHostPayload, type VoiceTerminal } from '@/lib/next/voice-host';
import { isVoiceHostFrame, type VoiceHostFrame } from '@/lib/next/voice-host';

type Result = { status: number; body: Record<string, unknown> };
type Delegation = { text: string; userMessageId?: string };
const result = (status: number, body: Record<string, unknown>): Result => ({ status, body });
const invalid = () => result(400, { ok: false, code: 'INVALID_VOICE_HOST_REQUEST' });
const conflict = () => result(409, { ok: false, code: 'VOICE_BINDING_MISMATCH' });

/** One owner in the realtime process; Next route workers hold no voice state. */
export class VoiceHostBroker {
  private hostId = '';
  private heartbeat = 0;
  private active: (VoiceBinding & { state: string; requestId: string }) | null = null;
  private delegations = new Map<string, Delegation>();
  private terminals = new Map<string, VoiceTerminal>();
  private confirmations = new Map<string, Record<string, unknown>>();
  private requests = new Map<string, { body: string; result: Result }>();
  constructor(private publish: (frame: Record<string, unknown>) => void, private now = Date.now) {}
  private available() { return Boolean(this.hostId && this.now() - this.heartbeat < 15_000); }
  private frame(payload: VoiceHostPayload) {
    this.publish({ type: 'ui-command', kind: 'voice-host-state', payload });
  }
  private terminalKey(threadId: string, repoPath: string, userMessageId: string) {
    return JSON.stringify([threadId, repoPath, userMessageId]);
  }
  state(): Result {
    return this.available() ? result(200, { ok: true, available: true, active: this.active, confirmations: [...this.confirmations.values()].filter(value => Number(value.expiresAt) > this.now()) })
      : result(503, { ok: false, available: false, code: 'VOICE_HOST_UNAVAILABLE' });
  }
  request(input: unknown): Result {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
    const body = input as VoiceHostPayload;
    if (body.action === 'publish') {
      if (!isVoiceHostFrame(input as Record<string, unknown>)) return invalid();
      const frame = input as VoiceHostFrame;
      const admitted = this.ui(frame);
      if (!admitted) return invalid();
      if (admitted.status === 200) this.publish({ type: 'ui-command', kind: frame.kind, payload: frame.payload });
      return admitted;
    }
    if (body.action === 'ready') {
      if (!voiceHostId(body.hostId)) return invalid();
      if (this.available() && this.hostId !== body.hostId) return conflict();
      if (this.hostId !== body.hostId) {
        this.active = null; this.delegations.clear(); this.requests.clear(); this.terminals.clear(); this.confirmations.clear();
      }
      this.hostId = body.hostId; this.heartbeat = this.now();
      return result(200, { ok: true, leaseMs: 15_000 });
    }
    if (!this.available()) return this.state();
    if (body.action === 'symon-toggle' || body.action === 'decision') {
      if (body.action === 'decision' && (!voiceHostId(body.confirmationId) || typeof body.allow !== 'boolean')) return invalid();
      if (body.action === 'decision') {
        const gate = this.confirmations.get(body.confirmationId!);
        if (!gate || Number(gate.expiresAt) <= this.now()) return conflict();
      }
      this.frame({ ...body, hostId: this.hostId });
      return result(202, { ok: true });
    }
    if (!isVoiceBinding(body)) return invalid();
    if (body.action === 'start' || body.action === 'stop') {
      if (!voiceHostId(body.requestId) || (body.action === 'start' && body.source !== 'byok')) return invalid();
      const prior = this.requests.get(body.requestId);
      if (prior) return prior.body === JSON.stringify(body) ? prior.result : conflict();
      if (body.action === 'start') {
        if (this.active && (this.active.nonce === body.nonce || !['closed', 'idle', 'error'].includes(this.active.state))) return conflict();
        this.active = { binding: body.binding, nonce: body.nonce, threadId: body.threadId, repoPath: body.repoPath, state: 'connecting', requestId: body.requestId };
        this.delegations.clear(); this.terminals.clear();
      } else {
        if (!this.active || !sameVoiceBinding(this.active, body)) return conflict();
        this.active.state = 'closing';
      }
      this.frame({ ...body, hostId: this.hostId });
      const receipt = result(202, { ok: true, requestId: body.requestId, state: this.active.state });
      this.requests.set(body.requestId, { body: JSON.stringify(body), result: receipt });
      if (this.requests.size > 128) this.requests.delete(this.requests.keys().next().value!);
      return receipt;
    }
    if (!this.active || !sameVoiceBinding(this.active, body)) return conflict();
    if (body.action === 'context') {
      this.frame({ ...body, hostId: this.hostId }); return result(200, { ok: true });
    }
    if (!voiceHostId(body.delegationId)) return invalid();
    const delegation = this.delegations.get(body.delegationId);
    if (!delegation) return conflict();
    if (body.action === 'accepted') {
      if (!voiceHostId(body.userMessageId)) return invalid();
      if (delegation.userMessageId && delegation.userMessageId !== body.userMessageId) return conflict();
      delegation.userMessageId = body.userMessageId;
      this.frame({ ...this.active, action: 'accepted', hostId: this.hostId, delegationId: body.delegationId, userMessageId: body.userMessageId });
      this.forwardTerminal(body.delegationId, delegation);
      return result(200, { ok: true });
    }
    if (body.action === 'terminal') {
      // A client can request replay, never supply a replacement terminal.
      if (!this.forwardTerminal(body.delegationId, delegation)) return conflict();
      return result(200, { ok: true });
    }
    return invalid();
  }
  ui(command: VoiceHostFrame): Result | null {
    if (command.kind !== 'voice-host-state' && command.kind !== 'voice-delegate') return null;
    const body = command.payload as unknown as VoiceHostPayload;
    if (!this.available() || body.hostId !== this.hostId) return conflict();
    if (command.kind === 'voice-host-state' && body.action === 'confirmation') {
      const gate = body.confirmation;
      if (!gate || !voiceHostId(gate.confirmationId) || typeof gate.expiresAt !== 'number') return invalid();
      if (this.confirmations.size >= 128 && !this.confirmations.has(gate.confirmationId)) return conflict();
      this.confirmations.set(gate.confirmationId, gate);
      return result(200, { ok: true });
    }
    if (command.kind === 'voice-host-state' && body.action === 'confirmation-dismissed') {
      if (!voiceHostId(body.confirmationId)) return invalid();
      this.confirmations.delete(body.confirmationId); return result(200, { ok: true });
    }
    if (command.kind === 'voice-host-state' && body.action === 'symon-state') return result(200, { ok: true });
    if (!this.active || !sameVoiceBinding(this.active, body)) return conflict();
    if (command.kind === 'voice-delegate') {
      if (this.active.state === 'closing' || !voiceHostId(body.delegationId) || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16_000) return invalid();
      const prior = this.delegations.get(body.delegationId);
      if (prior) return result(prior.text === body.text ? 208 : 409, { ok: prior.text === body.text });
      if (this.delegations.size >= 128) return conflict();
      this.delegations.set(body.delegationId, { text: body.text });
    } else if (body.action === 'state') {
      if (!['idle', 'connecting', 'live', 'closing', 'closed', 'unknown', 'error'].includes(body.state ?? '')) return invalid();
      if (this.active.state === 'closing' && ['connecting', 'live'].includes(body.state!)) return conflict();
      this.active.state = body.state!;
    } else if (body.action !== 'transcript' && body.action !== 'interrupt') return invalid();
    return result(200, { ok: true });
  }
  /** Called only from the server's existing orchestrator event publication. */
  observe(frame: Record<string, unknown>) {
    if (!this.available() || !this.active || frame.channel !== 'orchestrator') return;
    const data = frame.data as Record<string, unknown> | undefined;
    if (!data || typeof data.threadId !== 'string' || typeof data.repoPath !== 'string' || !isVoiceTerminal(data.voiceTerminal)) return;
    if (this.active.threadId !== data.threadId || this.active.repoPath !== data.repoPath) return;
    const key = this.terminalKey(data.threadId, data.repoPath, data.voiceTerminal.userMessageId);
    const prior = this.terminals.get(key);
    if (!prior || prior.outcome === 'unconfirmed') this.terminals.set(key, data.voiceTerminal);
    if (this.terminals.size > 256) this.terminals.delete(this.terminals.keys().next().value!);
    if (this.active?.threadId !== data.threadId || this.active.repoPath !== data.repoPath) return;
    for (const [id, delegation] of this.delegations) this.forwardTerminal(id, delegation);
  }
  private forwardTerminal(delegationId: string, delegation: Delegation): boolean {
    if (!this.active || !delegation.userMessageId || !this.available()) return false;
    const terminal = this.terminals.get(this.terminalKey(this.active.threadId, this.active.repoPath, delegation.userMessageId));
    if (!terminal) return false;
    this.frame({ ...this.active, action: 'terminal', hostId: this.hostId, delegationId, voiceTerminal: terminal });
    return true;
  }
}

export async function handleVoiceHostHttp(req: IncomingMessage, res: ServerResponse, broker: VoiceHostBroker) {
  let response: Result;
  if (req.method === 'GET') response = broker.state();
  else if (req.method === 'POST') {
    const chunks: Buffer[] = []; let bytes = 0;
    try {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 64 * 1024) { res.writeHead(413).end(); req.resume(); return; }
        chunks.push(Buffer.from(chunk));
      }
      response = broker.request(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      if (!req.complete || res.destroyed) return;
      response = invalid();
    }
  } else response = result(405, { ok: false });
  res.writeHead(response.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(response.body));
}
