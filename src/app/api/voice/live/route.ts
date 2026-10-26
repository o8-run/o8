import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { loadSymonTextSession } from '@/lib/mobile/symon-text-session-store';
import { resolveDeviceByToken } from '@/lib/mobile/device-registry';
import { planToken, proxyBaseUrl } from '@/lib/cortex/qa/llm/inference-route';
import { accountStateMatches, readAccountState, withAccountStateAdmission } from '@/lib/auth/account-state';
import { loadVoiceRelay, saveVoiceRelay, voiceGatewayUrl, VoiceRelayPersistenceError } from '@/lib/voice/managed-live/relay-store';
import { localVoicePreview, previewVoiceRequest } from '@/lib/voice/managed-live/local-preview';
import { byokVoiceAvailable, byokVoiceRequest, isByokVoiceSession } from '@/lib/voice/managed-live/byok-request';
import { personalVoiceGateway } from '@/lib/voice/managed-live/personal-dev';
import { personalVoicePilot, verifyPersonalVoiceAccount, type PilotAccount } from '@/lib/voice/managed-live/personal-pilot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type PersonalRoute = { gateway: string; pilotId?: string };
async function personalRoute(token: string, account: PilotAccount): Promise<PersonalRoute | null> {
  const pilot = await personalVoicePilot(token, account);
  if (pilot) return { gateway: pilot.gateway, pilotId: pilot.id };
  const gateway = personalVoiceGateway();
  if (!gateway) return null;
  await verifyPersonalVoiceAccount(token, account);
  return { gateway };
}
type LiveAdmission = {
  personal: PersonalRoute | null;
  preview: ReturnType<typeof localVoicePreview>;
  enabled: boolean;
  entitled: boolean;
  transport?: 'personal-webrtc' | 'local-preview';
};
/** Availability and new sessions share transport precedence and account admission. */
async function liveAdmission(operator: boolean): Promise<LiveAdmission> {
  const account = readAccountState(); const token = planToken();
  const personal = await personalRoute(token ?? '', account ?? { accountId: null, epoch: null });
  const current = Boolean(account && account.accountId && account.epoch && accountStateMatches(account)
    && readAccountState()?.generation === account.generation && token && hash(token) === account.licenseDigest);
  if (personal) {
    if (!current) throw new Error('Account unavailable');
    return { personal, preview: 'disabled', enabled: operator, entitled: operator, transport: 'personal-webrtc' };
  }
  const preview = localVoicePreview();
  if (preview !== 'disabled') {
    const enabled = operator && preview === 'enabled';
    return { personal: null, preview, enabled, entitled: enabled, transport: 'local-preview' };
  }
  return { personal: null, preview, enabled: process.env.O8_MANAGED_LIVE_ENABLED === '1', entitled: current };
}
function owner(request: Request): string | null {
  const principal = resolveRequestPrincipal(request);
  if (principal !== 'operator' && principal !== 'device') return null;
  const bearer = request.headers.get('authorization')?.slice(7).trim() ?? '';
  return hash(`${principal}\0${bearer}`);
}
export async function GET(request: Request) {
  if (!owner(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const sessionId = new URL(request.url).searchParams.get('symonSession');
  if (sessionId) {
    const session = loadSymonTextSession(sessionId);
    const role = resolveRequestPrincipal(request);
    const device = role === 'device' ? resolveDeviceByToken(request.headers.get('authorization')?.slice(7) ?? '') : null;
    const ready = Boolean(session && session.subject === role && (role === 'operator' || session.deviceId === device?.id));
    return NextResponse.json({ ready, ...(ready && session ? { session: { sessionId: session.sessionId, engine: session.engine, model: session.model, transcript: session.transcript } } : {}) }, { status: ready ? 200 : 409 });
  }
  const byokAvailable = await byokVoiceAvailable(resolveRequestPrincipal(request) === 'operator');
  try {
    const admission = await withAccountStateAdmission(() => liveAdmission(resolveRequestPrincipal(request) === 'operator'));
    return NextResponse.json({ enabled: admission.enabled, entitled: admission.entitled, transport: admission.transport, byokAvailable }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return NextResponse.json({ error: 'personal_voice_unavailable', enabled: false, byokAvailable }, { status: 503 }); }
}
export async function POST(request: Request) {
  const principal = owner(request);
  if (!principal) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 128 * 1024) return NextResponse.json({ error: 'body_too_large' }, { status: 413 });
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: 'invalid_body' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  try {
    if (body.source === 'byok' || (body.action !== 'start' && isByokVoiceSession(body.id))) return byokVoiceRequest(body, request);
  } catch { return NextResponse.json({ error: 'byok_voice_receipt_unavailable' }, { status: 503 }); }
  if (body.source !== undefined && body.source !== 'managed') return NextResponse.json({ error: 'invalid_voice_source' }, { status: 400 });
  try {
    if (body.action !== 'start' && !personalVoiceGateway() && localVoicePreview() !== 'disabled' && !loadVoiceRelay(typeof body.id === 'string' ? body.id : '')) {
      if (resolveRequestPrincipal(request) !== 'operator') return NextResponse.json({ error: 'local_voice_preview_operator_only' }, { status: 403 });
      return previewVoiceRequest(body, principal);
    }
  } catch { /* An expired personal marker must not prevent authenticated close. */ }
  try { return await withAccountStateAdmission(async () => {
    const operator = resolveRequestPrincipal(request) === 'operator';
    if (body.action === 'start') {
      let admission: LiveAdmission;
      try { admission = await liveAdmission(operator); }
      catch { return NextResponse.json({ error: 'personal_voice_unavailable' }, { status: 503 }); }
      if (admission.personal && !operator) return NextResponse.json({ error: 'personal_voice_operator_only' }, { status: 403 });
      if (admission.preview !== 'disabled') {
        if (!operator) return NextResponse.json({ error: 'local_voice_preview_operator_only' }, { status: 403 });
        return previewVoiceRequest(body, principal);
      }
      return relay(body, principal, operator, admission.personal);
    }
    return relay(body, principal, operator);
  }); }
  catch { return NextResponse.json({ error: 'voice_account_unavailable' }, { status: 503 }); }
}
async function relay(body: Record<string, unknown>, principal: string, operator: boolean, selectedPersonal: PersonalRoute | null = null) {
  const account = readAccountState();
  if (!account || !accountStateMatches(account)) return NextResponse.json({ error: 'voice_account_unavailable' }, { status: 503 });
  const token = planToken();
  if (!token) return NextResponse.json({ error: 'managed_voice_not_entitled' }, { status: 403 });
  if (hash(token) !== account.licenseDigest) return NextResponse.json({ error: 'voice_account_unavailable' }, { status: 503 });
  if (!account.accountId || !account.epoch) return NextResponse.json({ error: 'voice_account_unavailable' }, { status: 503 });
  let personal: PersonalRoute | null = null;
  if (body.action === 'start' || body.action === 'event') {
    try { personal = body.action === 'start' ? selectedPersonal : await personalRoute(token, account); }
    catch { return NextResponse.json({ error: 'personal_voice_unavailable' }, { status: 503 }); }
    if (personal && !operator) return NextResponse.json({ error: 'personal_voice_operator_only' }, { status: 403 });
    if (!accountStateMatches(account) || readAccountState()?.generation !== account.generation) return NextResponse.json({ error: 'voice_account_changed' }, { status: 503 });
  }
  // Routine credential housekeeping rotates generation. Controls belong to the
  // verified signed-in account; generation still fences each in-flight request.
  const accountOwner = hash(JSON.stringify(['voice-owner-v2', principal, account.accountId, account.epoch]));
  let gateway: string;
  let path = '/v1/live/sessions';
  let method = 'POST';
  let payload: unknown;
  try {
  if (body.action === 'start') {
    if (!personal && process.env.O8_MANAGED_LIVE_ENABLED !== '1') return NextResponse.json({ error: 'managed_voice_disabled' }, { status: 503 });
    if (typeof body.binding !== 'string' || !body.binding || body.binding.length > 2000
      || typeof body.context !== 'string' || body.context.length > 8000 || typeof body.sdp !== 'string') {
      return NextResponse.json({ error: 'invalid_binding' }, { status: 400 });
    }
    gateway = personal?.gateway ?? voiceGatewayUrl(proxyBaseUrl());
    payload = { binding: hash(body.binding), context: body.context, sdp: body.sdp };
  } else {
    const id = typeof body.id === 'string' ? body.id : '';
    const record = loadVoiceRelay(id);
    if (!record || record.version !== 2 || record.owner !== accountOwner || typeof body.binding !== 'string' || record.binding !== hash(body.binding)) return NextResponse.json({ error: 'session_not_found' }, { status: 404 });
    if (record.personal && body.action === 'event' && (!personal || !operator || personal.gateway !== record.gateway
      || (personal.pilotId ?? null) !== record.personal.pilotId)) return NextResponse.json({ error: 'personal_voice_unavailable' }, { status: 503 });
    gateway = record.gateway;
    path += `/${encodeURIComponent(id)}`;
    if (body.action === 'poll' && Number.isSafeInteger(body.after) && Number(body.after) >= 0) {
      path += `?after=${body.after}`; method = 'GET';
    } else if (body.action === 'close') method = 'DELETE';
    else if (body.action === 'event') { path += '/events'; payload = body.event; }
    else return NextResponse.json({ error: 'invalid_action' }, { status: 400 });
  }
    const response = await fetch(`${gateway}${path}`, { method, redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(35_000) });
    const data = await response.json() as Record<string, unknown>;
    if (response.ok && body.action === 'start' && typeof data.id === 'string') {
      try { saveVoiceRelay({ version: 2, id: data.id, owner: accountOwner, binding: hash(body.binding as string), gateway, createdAt: Date.now(),
        ...(personal ? { personal: { pilotId: personal.pilotId ?? null } } : {}) }); }
      catch (error) {
        if (error instanceof VoiceRelayPersistenceError && error.published) {
          // Publication proved this id was newly ours. Keep its record and an
          // unknown outcome even if best-effort closure acknowledges receipt.
          await fetch(`${gateway}/v1/live/sessions/${encodeURIComponent(data.id)}`, { method: 'DELETE', redirect: 'error',
            headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) }).catch(() => {});
        }
        throw error;
      }
    }
    if (readAccountState()?.generation !== account.generation || !accountStateMatches(account)) {
      return NextResponse.json({ error: 'voice_account_changed' }, { status: 503 });
    }
    return NextResponse.json(data, { status: response.status, headers: { 'Cache-Control': 'no-store' } });
  } catch { return NextResponse.json({ error: 'managed_voice_transport_unknown' }, { status: 502 }); }
}
