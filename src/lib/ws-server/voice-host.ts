import type { IncomingMessage, ServerResponse } from 'node:http';
import { isVoiceBinding, sameVoiceBinding, voiceHostId, isVoiceHostFrame, type VoiceHostFrame, type VoiceBinding, type VoiceHostPayload, type VoiceTerminal } from '@/lib/next/voice-host';
import { readVoiceQueueReceipt, readVoiceQueueTranscriptId } from './voice-host-queue';

type Result = { status: number; body: Record<string, unknown> };
type Delegation = { text: string; queueItemId?: string };
const result = (status: number, body: Record<string, unknown>): Result => ({ status, body });
const invalid = () => result(400, { ok: false, code: 'INVALID_VOICE_HOST_REQUEST' });
const conflict = () => result(409, { ok: false, code: 'VOICE_BINDING_MISMATCH' });

/** One owner in the realtime process; Next route workers hold no voice state. */
export class VoiceHostBroker {
  private hostId = '';
  private heartbeat = 0;
  private active: (VoiceBinding & { state: string; requestId: string }) | null = null;
  private dictation: (VoiceBinding & { requestId: string; state: string; submit: boolean; final: boolean }) | null = null;
  private delegations = new Map<string, Delegation>();
  private terminals = new Map<string, VoiceTerminal>();
  private confirmations = new Map<string, Record<string, unknown>>();
  private requests = new Map<string, { body: string; result: Result }>();
  constructor(private publish: (frame: Record<string, unknown>) => void, private now = Date.now) {}
  private available() { return Boolean(this.hostId && this.now() - this.heartbeat < 15_000); }
  private frame(payload: VoiceHostPayload) {
    this.publish({ type: 'ui-command', kind: 'voice-host-state', payload });
  }
  private terminalKey(threadId: string, repoPath: string, queueItemId: string) {
    return JSON.stringify([threadId, repoPath, queueItemId]);
  }
  state(): Result {
    return this.available() ? result(200, { ok: true, available: true, hostId: this.hostId, active: this.active, dictation: this.dictation, confirmations: [...this.confirmations.values()].filter(value => Number(value.expiresAt) > this.now()) })
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
      const available = this.available();
      if (!available) this.dictation = null;
      if (available && this.hostId !== body.hostId) return conflict();
      if (this.hostId !== body.hostId) {
        this.active = null; this.dictation = null; this.delegations.clear(); this.requests.clear(); this.terminals.clear(); this.confirmations.clear();
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
    if (body.action === 'dictation-start' || body.action === 'dictation-stop') return this.dictationRequest(body);
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
      if (!voiceHostId(body.queueItemId)) return invalid();
      if (!readVoiceQueueReceipt(this.active, body.queueItemId)) return conflict();
      if ([...this.delegations.values()].some(other => other !== delegation && other.queueItemId === body.queueItemId)) return conflict();
      if (delegation.queueItemId && delegation.queueItemId !== body.queueItemId) return conflict();
      delegation.queueItemId = body.queueItemId;
      this.frame({ ...this.active, action: 'accepted', hostId: this.hostId, delegationId: body.delegationId, queueItemId: body.queueItemId });
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
    if (command.kind === 'dictation-text' || command.kind === 'dictation-state') return this.dictationFrame(command);
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
  private dictationRequest(body: VoiceHostPayload & VoiceBinding): Result {
    if (!voiceHostId(body.requestId) || body.action === 'dictation-stop' && typeof body.submit !== 'boolean') return invalid();
    const prior = this.requests.get(body.requestId);
    if (prior) return prior.body === JSON.stringify(body) ? prior.result : conflict();
    if (body.action === 'dictation-start') {
      if (this.dictation && !['idle', 'error'].includes(this.dictation.state)) return result(409, {
        ok: false, code: 'VOICE_INPUT_BUSY', state: 'error', error: 'Another dictation is active. Finish it before starting another microphone.',
      });
      this.dictation = { binding: body.binding, nonce: body.nonce, threadId: body.threadId, repoPath: body.repoPath,
        requestId: body.requestId, state: 'starting', submit: false, final: false };
    } else {
      if (!this.dictation || !sameVoiceBinding(this.dictation, body) || ['idle', 'error'].includes(this.dictation.state)) return conflict();
      this.dictation.state = 'stopping'; this.dictation.submit = body.submit!;
    }
    this.frame({ ...body, hostId: this.hostId });
    const receipt = result(202, { ok: true, requestId: body.requestId, state: this.dictation!.state });
    this.requests.set(body.requestId, { body: JSON.stringify(body), result: receipt });
    if (this.requests.size > 128) this.requests.delete(this.requests.keys().next().value!);
    return receipt;
  }
  private dictationFrame(command: VoiceHostFrame): Result {
    const body = command.payload as unknown as VoiceHostPayload;
    const active = this.dictation;
    if (!this.available() || body.hostId !== this.hostId || !active || !sameVoiceBinding(active, body) || body.requestId !== active.requestId) return conflict();
    if (command.kind === 'dictation-text') {
      if (typeof body.text !== 'string' || typeof body.final !== 'boolean') return invalid();
      if (['idle', 'error'].includes(active.state) || active.state === 'stopping' && !active.submit || active.final) return conflict();
      if (body.final) {
        if (active.state !== 'stopping' || !active.submit) return conflict();
        active.final = true;
      }
    } else {
      if (!['listening', 'idle', 'error'].includes(body.state ?? '') || body.error !== undefined && typeof body.error !== 'string') return invalid();
      if (body.state === 'listening') {
        if (['idle', 'error'].includes(active.state)) return conflict();
        if (active.state !== 'stopping') active.state = 'listening';
      } else active.state = body.state!;
    }
    return result(200, { ok: true });
  }
  /** Settlement can happen after streaming, or in another HTTP worker. */
  refreshQueuedTerminals() {
    if (!this.available() || !this.active) return;
    for (const [id, delegation] of this.delegations) {
      if (!delegation.queueItemId) continue;
      const key = this.terminalKey(this.active.threadId, this.active.repoPath, delegation.queueItemId);
      if (this.terminals.has(key)) continue;
      const receipt = readVoiceQueueReceipt(this.active, delegation.queueItemId);
      if (!receipt?.terminal) continue;
      this.terminals.set(key, receipt.terminal);
      this.forwardTerminal(id, delegation);
    }
  }
  private forwardTerminal(delegationId: string, delegation: Delegation): boolean {
    if (!this.active || !delegation.queueItemId || !this.available()) return false;
    const terminal = this.terminals.get(this.terminalKey(this.active.threadId, this.active.repoPath, delegation.queueItemId));
    if (!terminal) {
      const receipt = readVoiceQueueReceipt(this.active, delegation.queueItemId);
      if (!receipt?.terminal) return false;
      this.terminals.set(this.terminalKey(this.active.threadId, this.active.repoPath, delegation.queueItemId), receipt.terminal);
      return this.forwardTerminal(delegationId, delegation);
    }
    this.frame({ ...this.active, action: 'terminal', hostId: this.hostId, delegationId, voiceTerminal: terminal,
      transcriptUserMessageId: readVoiceQueueTranscriptId(this.active, delegation.queueItemId) });
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
