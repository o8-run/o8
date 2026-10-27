// @vitest-environment jsdom
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ operator: 'voice-availability-operator-fixture' }));
const keys = await vi.hoisted(async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const license = generateKeyPairSync('ed25519'); const pilot = generateKeyPairSync('ed25519');
  return { license, pilot, licensePem: license.publicKey.export({ type: 'spki', format: 'pem' }),
    pilotPem: pilot.publicKey.export({ type: 'spki', format: 'pem' }) };
});
// Replace public trust roots and physical media only; admission and persistence stay real.
vi.mock('@/lib/entitlement/license', async original => ({
  ...await original<typeof import('@/lib/entitlement/license')>(), LICENSE_PUBLIC_KEY_PEM: keys.licensePem,
}));
vi.mock('@/lib/voice/managed-live/personal-pilot-key', () => ({ PERSONAL_PILOT_PUBLIC_KEY: keys.pilotPem }));
vi.mock('@/lib/mobile/ws-token-client', () => ({ getMobileWsToken: () => fixture.operator }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => false, canUseTauriEvents: () => false }));
vi.mock('@/components/desktop/thoughts/chat-panel/useTurnByTurnVoice', () => ({
  useTurnByTurnVoice: () => ({ available: false, enabled: false, detail: '', stop() {}, start: async () => false }),
}));
let root: string; let epoch: string;
let voice: typeof import('./route');
let state: typeof import('@/lib/auth/account-state');
let pilot: typeof import('@/lib/voice/managed-live/personal-pilot');
const gateway = 'http://127.0.0.1:45678';
const subject = 'voice-account-fixture';
const id = '11111111-1111-4111-8111-111111111111';
const calls: Array<{ url: string; method: string }> = [];
let closed = false;
const request = (action?: string, token = fixture.operator, binding = 'existing-chat') => new Request('http://localhost/api/voice/live', {
  method: action ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}` },
  ...(action ? { body: JSON.stringify({ action, id, binding, after: 0, context: '', sdp: 'v=0\noffer' }) } : {}),
});
const preview = (expiresAt: number) => writeFileSync(join(root, 'managed-voice-preview.json'),
  JSON.stringify({ version: 1, expiresAt }), { mode: 0o600 });
async function account() {
  const token = await new SignJWT({ plan: 'pro' }).setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(subject).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + 3600).sign(keys.license.privateKey);
  await state.withAccountStateLease(() => {
    state.invalidateAccountState();
    writeFileSync(join(root, 'active-identity'), subject);
    writeFileSync(join(root, 'github-signin-epoch'), epoch);
    writeFileSync(join(root, 'entitlement.json'), JSON.stringify({ plan: 'pro', licenseKey: token }), { mode: 0o600 });
    state.publishReadyAccountState(subject, epoch, token);
  });
}
async function grant(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const signed = await new SignJWT({ iss: pilot.PERSONAL_PILOT_ISSUER, aud: pilot.PERSONAL_PILOT_AUDIENCE,
    sub: subject, iat: now, nbf: now, exp: now + 600, jti: randomUUID(), version: 1,
    purpose: 'personal-live-experiment', installation: pilot.personalPilotInstallation(root, epoch), gateway, ...overrides })
    .setProtectedHeader({ alg: 'EdDSA' }).sign(keys.pilot.privateKey);
  writeFileSync(join(root, 'managed-voice-pilot.jwt'), signed, { mode: 0o600 });
}
beforeEach(async () => {
  // Route signatures use the host crypto realm alongside the mounted browser component.
  vi.stubGlobal('Uint8Array', Object.getPrototypeOf(Buffer)); vi.stubGlobal('crypto', webcrypto);
  vi.resetModules(); root = mkdtempSync(join(tmpdir(), 'o8-voice-availability-')); epoch = randomUUID(); calls.length = 0; closed = false;
  vi.stubEnv('O8_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DATA_DIR', root); vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('WS_TOKEN', fixture.operator); vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '0');
  state = await import('@/lib/auth/account-state'); pilot = await import('@/lib/voice/managed-live/personal-pilot');
  voice = await import('./route'); await account();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/voice/live') {
      const req = new Request('http://localhost/api/voice/live', init);
      return init?.method === 'POST' ? voice.POST(req) : voice.GET(req);
    }
    calls.push({ url, method: init?.method ?? 'GET' });
    if (init?.method === 'DELETE') closed = true;
    return Response.json(init?.method === 'POST' && url.endsWith('/v1/live/sessions') ? { id, sdp: 'v=0\nanswer' }
      : { events: closed ? [{ cursor: 1, event: { type: 'session.closed', usage: { seconds: 1 } } }] : [] });
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it('selects the same signed personal transport for availability and start despite expired local preview state', async () => {
  preview(Date.now() - 1); await grant();
  expect(await (await voice.GET(request())).json()).toMatchObject({ enabled: true, entitled: true, transport: 'personal-webrtc' });
  const started = await voice.POST(request('start'));
  expect(started.status).toBe(200);
  expect(await started.json()).toMatchObject({ id, sdp: 'v=0\nanswer' });
  expect(calls).toEqual([{ url: `${gateway}/v1/live/sessions`, method: 'POST' }]);
  expect(JSON.parse(readFileSync(join(root, 'managed-voice-relay', `${id}.json`), 'utf8'))).toMatchObject({ gateway, personal: { pilotId: expect.any(String) } });
});

it('keeps expired preview alone unavailable and never creates a remote session', async () => {
  preview(Date.now() - 1);
  expect(await (await voice.GET(request())).json()).toMatchObject({ enabled: false, entitled: false, transport: 'local-preview' });
  const started = await voice.POST(request('start'));
  expect(started.status).toBe(503); expect(await started.json()).toMatchObject({ error: 'local_voice_preview_expired' });
  expect(calls).toEqual([]);
});

it('keeps a valid preview local through availability, start, poll and close', async () => {
  preview(Date.now() + 60_000);
  expect(await (await voice.GET(request())).json()).toMatchObject({ enabled: true, entitled: true, transport: 'local-preview' });
  const started = await (await voice.POST(request('start'))).json();
  expect(started).toMatchObject({ transport: 'local-preview', id: expect.any(String) });
  for (const action of ['poll', 'close']) {
    expect((await voice.POST(new Request('http://localhost/api/voice/live', { method: 'POST',
      headers: { authorization: `Bearer ${fixture.operator}` }, body: JSON.stringify({ action, id: started.id, binding: 'existing-chat', after: 0 }) }))).status).toBe(200);
  }
  expect(calls).toEqual([]);
});

it.each(['device', 'anonymous'])('does not admit a %s caller when expired preview and signed personal authorization coexist', async role => {
  preview(Date.now() - 1); await grant();
  const token = role === 'device' ? 'voice-device-fixture' : '';
  if (role === 'device') writeFileSync(join(root, 'mobile-device-tokens'), createHash('sha256').update(token).digest('hex'));
  const availability = await voice.GET(request(undefined, token));
  if (role === 'device') expect(await availability.json()).toMatchObject({ enabled: false, entitled: false });
  else expect(availability.status).toBe(401);
  expect((await voice.POST(request('start', token))).status).toBe(role === 'device' ? 403 : 401);
  expect(calls).toEqual([]);
});

it('recovers the persisted relay after expiry and rotation without retargeting or creating a duplicate', async () => {
  preview(Date.now() - 1); await grant();
  expect((await voice.POST(request('start'))).status).toBe(200);
  const record = readFileSync(join(root, 'managed-voice-relay', `${id}.json`), 'utf8');
  await account(); const now = Math.floor(Date.now() / 1000);
  await grant({ iat: now - 60, nbf: now - 60, exp: now - 1, gateway: 'http://127.0.0.1:45679' });
  vi.resetModules(); voice = await import('./route');
  expect((await voice.POST(request('start'))).status).toBe(503);
  expect((await voice.POST(request('close', fixture.operator, 'wrong-chat'))).status).toBe(404);
  expect((await voice.POST(request('poll'))).status).toBe(200);
  expect((await voice.POST(request('close'))).status).toBe(200);
  expect(calls).toEqual([{ url: `${gateway}/v1/live/sessions`, method: 'POST' },
    { url: `${gateway}/v1/live/sessions/${id}?after=0`, method: 'GET' }, { url: `${gateway}/v1/live/sessions/${id}`, method: 'DELETE' }]);
  expect(readFileSync(join(root, 'managed-voice-relay', `${id}.json`), 'utf8')).toBe(record);
});

it('starts the advertised personal transport through the actual composer Live button', async () => {
  preview(Date.now() - 1); await grant();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const answered = vi.fn();
  class Peer {
    localDescription = { sdp: 'v=0\noffer' }; connectionState = 'connected';
    addTrack() {} createDataChannel() {} close() {}
    createOffer = async () => this.localDescription;
    setLocalDescription = async () => {}; setRemoteDescription = async () => { answered(); };
  }
  class AudioFixture { srcObject = null; play = async () => {}; pause() {} }
  class AudioContextFixture {
    close = async () => {};
    createAnalyser() { return { fftSize: 256, getByteTimeDomainData: (data: Uint8Array) => data.fill(128) }; }
    createMediaStreamSource() { return { connect() {} }; }
  }
  vi.stubGlobal('RTCPeerConnection', Peer); vi.stubGlobal('Audio', AudioFixture); vi.stubGlobal('AudioContext', AudioContextFixture);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 24, 24)] as unknown as DOMRectList);
  const { ManagedLiveButton } = await import('@/components/desktop/thoughts/chat-panel/ManagedLiveButton');
  const host = document.createElement('div'); document.body.append(host); const mounted = createRoot(host);
  const send = vi.fn();
  try {
    await act(async () => mounted.render(createElement(ManagedLiveButton, { binding: 'existing-chat', messages: [], terminals: {}, busy: false,
      send, interrupt() {} })));
    await vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
      expect(host.querySelector('[aria-label="Start managed voice for this conversation"]')).not.toBeNull();
    });
    const start = host.querySelector<HTMLButtonElement>('[aria-label="Start managed voice for this conversation"]');
    expect(start).not.toBeNull();
    await act(async () => start!.click());
    await vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
      expect(answered).toHaveBeenCalledOnce();
      expect(host.querySelector('[aria-label="Disconnect managed voice"]')?.getAttribute('aria-pressed')).toBe('true');
    });
    expect(calls.filter(call => call.method === 'POST' && call.url.endsWith('/v1/live/sessions'))).toEqual([{ url: `${gateway}/v1/live/sessions`, method: 'POST' }]);
    expect(send).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Disconnect managed voice"]')!.click());
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Resume managed voice for this conversation"]')).not.toBeNull());
  } finally { await act(async () => mounted.unmount()); host.remove(); }
});
