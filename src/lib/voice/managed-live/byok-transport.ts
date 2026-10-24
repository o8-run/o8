import 'server-only';

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { getDataDir } from '@/lib/data-dir-migration';
import { byokHash, saveByokReceipt, type ByokEvent, type ByokReceipt } from './byok-store';

type Running = { record: ByokReceipt; socket?: WebSocket; deadline?: ReturnType<typeof setTimeout>; closeTimer?: ReturnType<typeof setTimeout>; authorityTimer?: ReturnType<typeof setInterval> };
type Registry = { sessions: Map<string, Running>; failedProfiles: Set<string> };
// Next may reload a route module while its socket remains alive. Keep one owner
// per process; a fresh process must reconcile from its durable receipts instead.
const globals = globalThis as typeof globalThis & { __o8ByokVoice?: Registry };
const registry: Registry = globals.__o8ByokVoice ??= { sessions: new Map(), failedProfiles: new Set() };
const sessionKey = (id: string) => `${getDataDir()}\0${id}`;
export const byokStorageFailed = () => registry.failedProfiles.has(getDataDir());
export const runningByokSession = (id: string) => registry.sessions.get(sessionKey(id));
export function registerByokSession(record: ByokReceipt): Running {
  const running: Running = { record }; registry.sessions.set(sessionKey(record.id), running); return running;
}
function checkpoint(s: Running): boolean {
  try { saveByokReceipt(s.record); return true; }
  catch { registry.failedProfiles.add(getDataDir()); return false; }
}
function emit(s: Running, event: ByokEvent) {
  s.record.events.push({ cursor: ++s.record.cursor, event });
  if (s.record.events.length > 512) s.record.events.shift();
}
export function unknownByokSession(s: Running): void {
  if (s.record.state === 'closed') return;
  clearTimeout(s.deadline); clearTimeout(s.closeTimer); clearInterval(s.authorityTimer);
  if (s.record.state !== 'unknown') {
    s.record.state = 'unknown'; emit(s, { type: 'o8.transport.unknown', event_id: randomUUID() }); checkpoint(s);
  }
  if (s.socket && s.socket.readyState !== WebSocket.CLOSED) s.socket.close();
}
export function closeByokSession(s: Running): void {
  if (s.record.state === 'closed') return;
  s.record.closeRequestedAt ??= Date.now(); clearTimeout(s.deadline);
  if (!s.socket || s.socket.readyState !== WebSocket.OPEN) { unknownByokSession(s); checkpoint(s); return; }
  if (s.record.state === 'closing') return;
  s.record.state = 'closing'; checkpoint(s);
  s.closeTimer = setTimeout(() => unknownByokSession(s), 15_000); s.closeTimer.unref?.();
  try { s.socket.send(JSON.stringify({ type: 'session.close', event_id: randomUUID() })); }
  catch { unknownByokSession(s); }
}
function eventObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
/** Forward only fields the current-chat protocol consumes; provider errors and
 * configuration objects may contain secrets and are never returned or stored. */
function normalize(value: Record<string, unknown>): ByokEvent | null {
  if (typeof value.event_id !== 'string' || !value.event_id || value.event_id.length > 100) throw new Error('Invalid event identity');
  const base = { type: value.type, event_id: value.event_id };
  if (value.type === 'session.input_transcript.delta' || value.type === 'session.output_transcript.delta') {
    if (typeof value.delta !== 'string' || value.delta.length > 6144 || !Number.isSafeInteger(value.start_ms)
      || !Number.isSafeInteger(value.end_ms) || Number(value.start_ms) < 0 || Number(value.end_ms) < Number(value.start_ms)) throw new Error('Invalid transcript');
    return { ...base, delta: value.delta, start_ms: value.start_ms, end_ms: value.end_ms };
  }
  if (value.type === 'session.delegation.created') {
    const delegation = eventObject(value.delegation);
    if (delegation?.target !== 'client') return null;
    if (typeof delegation.id !== 'string' || !delegation.id || delegation.id.length > 100
      || !Number.isSafeInteger(value.offset_ms) || Number(value.offset_ms) < 0) throw new Error('Invalid delegation');
    return { ...base, delegation: { id: delegation.id, target: 'client' }, offset_ms: value.offset_ms };
  }
  if (value.type === 'session.usage.updated' || value.type === 'session.closed') {
    const usage = eventObject(value.usage);
    if (typeof usage?.seconds !== 'number' || !Number.isFinite(usage.seconds) || usage.seconds < 0) throw new Error('Invalid usage');
    return { ...base, usage: { seconds: usage.seconds }, ...(typeof value.reason === 'string' && value.reason.length <= 100 ? { reason: value.reason } : {}) };
  }
  if (['session.commentary.appended', 'session.thinking.appended', 'session.instructions.appended'].includes(String(value.type))) {
    return base; // Acknowledgement is a receipt, never a backend completion claim.
  }
  return null;
}
function receive(s: Running, raw: WebSocket.RawData) {
  if (s.record.state === 'closed') return;
  try {
    const value = eventObject(JSON.parse(String(raw)));
    if (!value) throw new Error('Invalid provider event');
    if (value.type === 'session.started') return;
    if (value.type === 'error') { closeByokSession(s); return; }
    // Ignore unconsumed provider event types without persisting their payload.
    if (!['session.input_transcript.delta', 'session.output_transcript.delta', 'session.delegation.created',
      'session.usage.updated', 'session.closed', 'session.commentary.appended', 'session.thinking.appended', 'session.instructions.appended'].includes(String(value.type))) return;
    const event = normalize(value); if (!event) return;
    const eventId = byokHash(String(event.event_id)); const digest = byokHash(JSON.stringify(event));
    const prior = s.record.seen[eventId];
    if (prior) { if (prior !== digest) unknownByokSession(s); return; }
    const full = Object.keys(s.record.seen).length >= 4096;
    // The terminal receipt must remain reachable after the ordinary event budget
    // requests closure. It does not need another replay slot once closed.
    if (full && event.type !== 'session.closed') { closeByokSession(s); return; }
    if (!full) s.record.seen[eventId] = digest;
    if (event.type === 'session.delegation.created') {
      if (s.record.state !== 'active') return;
      const id = (event.delegation as { id: string }).id;
      if (s.record.delegations.includes(id)) return;
      s.record.delegations.push(id);
    }
    if (event.type === 'session.usage.updated' || event.type === 'session.closed') {
      const seconds = (event.usage as { seconds: number }).seconds;
      if (seconds < s.record.seconds) throw new Error('Usage decreased');
      s.record.seconds = seconds;
      if (event.type === 'session.closed') {
        if (s.record.closeReason) event.reason = s.record.closeReason;
        s.record.state = 'closed'; s.record.finalSeconds = seconds;
        clearTimeout(s.deadline); clearTimeout(s.closeTimer); clearInterval(s.authorityTimer);
      }
    }
    emit(s, event);
    if (!checkpoint(s) && s.record.state !== 'closed') closeByokSession(s);
    if (s.record.state === 'closed') {
      s.socket?.close(); registry.sessions.delete(sessionKey(s.record.id));
    }
  } catch { unknownByokSession(s); }
}
export async function attachByokSession(s: Running, key: string, recovering = false): Promise<void> {
  if (!s.record.providerId) throw new Error('Provider identity unavailable');
  if (s.socket) { s.socket.removeAllListeners(); s.socket.close(); }
  const socket = new WebSocket(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(s.record.providerId)}/attach`, {
    headers: { Authorization: `Bearer ${key}` }, maxPayload: 256 * 1024, handshakeTimeout: 10_000, followRedirects: false,
  });
  s.socket = socket;
  socket.on('message', raw => receive(s, raw)); socket.on('error', () => unknownByokSession(s));
  socket.on('close', () => unknownByokSession(s));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Voice attachment timeout')); }, 12_000); timer.unref?.();
    const fail = () => { clearTimeout(timer); reject(new Error('Voice attachment failed')); };
    socket.once('open', () => { clearTimeout(timer); socket.off('error', fail); resolve(); });
    socket.once('error', fail);
  });
  if (s.record.state === 'closed') return;
  if (socket.readyState !== WebSocket.OPEN) throw new Error('Voice attachment ended');
  s.record.state = 'active';
  if (!checkpoint(s) || recovering || s.record.closeRequestedAt) closeByokSession(s);
}
export function watchByokAuthority(s: Running, authorized: () => Promise<boolean>): void {
  let checking = false;
  s.authorityTimer = setInterval(() => {
    if (checking || s.record.state !== 'active') return;
    checking = true;
    void authorized().then(ready => { if (!ready) closeByokSession(s); }, () => closeByokSession(s))
      .finally(() => { checking = false; });
  }, 1000);
  s.authorityTimer.unref?.();
}
export function setByokDuration(s: Running, milliseconds: number): void {
  // This timer requests closure locally. It is not a provider-enforced ceiling.
  s.deadline = setTimeout(() => {
    s.record.closeReason = 'session_limit';
    closeByokSession(s);
  }, milliseconds); s.deadline.unref?.();
}
export function sendByokEvent(s: Running, value: unknown): { data: Record<string, unknown>; status: number } {
  const event = eventObject(value);
  if (s.record.state !== 'active') return { data: { error: 'session_not_active' }, status: 409 };
  if (!event || !['session.thinking.append', 'session.commentary.append'].includes(String(event.type))
    || typeof event.event_id !== 'string' || !event.event_id || event.event_id.length > 100
    || typeof event.content !== 'string' || event.content.length > 500
    || (event.delegation_id !== null && (typeof event.delegation_id !== 'string' || !s.record.delegations.includes(event.delegation_id)))) {
    return { data: { error: 'invalid_event' }, status: 400 };
  }
  const normalized = JSON.stringify({ type: event.type, event_id: event.event_id, delegation_id: event.delegation_id, content: event.content });
  const id = byokHash(event.event_id); const digest = byokHash(normalized); const prior = s.record.sent[id];
  if (prior) return prior.digest !== digest ? { data: { error: 'event_id_conflict' }, status: 409 }
    : { data: { state: prior.state === 'submitted' ? 'submitted' : 'unknown' }, status: prior.state === 'submitted' ? 200 : 409 };
  if (Object.keys(s.record.sent).length >= 4096) { closeByokSession(s); return { data: { error: 'session_event_limit' }, status: 409 }; }
  s.record.sent[id] = { digest, state: 'pending' };
  if (!checkpoint(s)) { closeByokSession(s); return { data: { error: 'byok_voice_receipt_unavailable' }, status: 503 }; }
  try {
    if (s.socket?.readyState !== WebSocket.OPEN) throw new Error('Voice connection missing');
    s.socket.send(normalized); s.record.sent[id].state = 'submitted';
    if (!checkpoint(s)) throw new Error('Voice event receipt unavailable');
    return { data: { state: 'submitted' }, status: 200 };
  } catch { unknownByokSession(s); return { data: { error: 'byok_voice_event_unknown' }, status: 502 }; }
}
