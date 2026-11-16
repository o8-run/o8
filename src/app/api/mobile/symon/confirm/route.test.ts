import { expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const h = vi.hoisted(() => ({ denied: null as Response | null }));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => h.denied }));
const { POST } = await import('./route');
const { phoneToolServer } = await import('@/lib/symon/execution/server');
function request(body: object) {
  return new NextRequest('http://localhost/api/mobile/symon/confirm', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
it('validates correlated decisions and terminal reasons before touching the owner', async () => {
  for (const body of [{}, { sessionId: 's', callId: 'c', confirmationId: 'x', allow: true, terminal: 'preempted' },
    { sessionId: 's', callId: 'c', confirmationId: 'x', allow: false, terminal: 'invalid' }]) {
    expect(await (await POST(request(body))).json()).toEqual({ ok: false, error: 'bad_request' });
  }
  expect(await (await POST(request({ sessionId: 's', callId: 'c', confirmationId: 'wrong', allow: true }))).json())
    .toEqual({ ok: false, error: 'confirmation_mismatch' });
});
it('preserves first decision and terminal preemption shapes without executing a declined call', async () => {
  const pending = await phoneToolServer.calls.start({ sessionId: 's', callId: 'c', tool: 'terminal_send', args: {}, review: { summary: 'Fixture write', target: {} } });
  const body = { ...pending.confirmation, allow: false, terminal: 'preempted' };
  expect(await (await POST(request(body))).json()).toEqual({ ok: true, resolution: { status: 'preempted' } });
  expect(await phoneToolServer.calls.wait('s', 'c')).toMatchObject({ result: { error: 'confirmation_declined' } });
  expect(await (await POST(request({ ...body, terminal: undefined, allow: true }))).json()).toEqual({ ok: true, resolution: { status: 'preempted' } });
});

it('enforces panel authentication before attempting any correlated decision', async () => {
  h.denied = NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const response = await POST(request({ sessionId: 's', callId: 'c', confirmationId: 'x', allow: true }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  } finally { h.denied = null; }
});
it('refuses malformed consent without consuming a pending confirmation', async () => {
  const pending = await phoneToolServer.calls.start({ sessionId: 's', callId: 'malformed', tool: 'terminal_send', args: {}, review: { summary: 'Fixture write', target: {} } });
  expect(await (await POST(request({ ...pending.confirmation, allow: 'true' }))).json()).toEqual({ ok: false, error: 'bad_request' });
  expect(phoneToolServer.calls.pendingForSession('s')).toContainEqual(pending.confirmation);
  await POST(request({ ...pending.confirmation, allow: false }));
});
it('records an explicit terminal expiry and refuses a later approval', async () => {
  const pending = await phoneToolServer.calls.start({ sessionId: 's', callId: 'expired', tool: 'terminal_send', args: {}, review: { summary: 'Fixture write', target: {} } });
  expect(await (await POST(request({ ...pending.confirmation, allow: false, terminal: 'expired' }))).json()).toEqual({ ok: true, resolution: { status: 'expired' } });
  expect(await (await POST(request({ ...pending.confirmation, allow: true }))).json()).toEqual({ ok: true, resolution: { status: 'expired' } });
  expect(await phoneToolServer.calls.wait('s', 'expired')).toEqual({ ok: false, result: { error: 'confirmation_declined' } });
});
it('replays a denied first decision when a later request tries to approve', async () => {
  const pending = await phoneToolServer.calls.start({ sessionId: 's', callId: 'denied', tool: 'terminal_send', args: {}, review: { summary: 'Fixture write', target: {} } });
  expect(await (await POST(request({ ...pending.confirmation, allow: false }))).json()).toEqual({ ok: true, resolution: { status: 'resolved', allow: false } });
  expect(await (await POST(request({ ...pending.confirmation, allow: true }))).json()).toEqual({ ok: true, resolution: { status: 'already_resolved', allow: false } });
  expect(await phoneToolServer.calls.wait('s', 'denied')).toEqual({ ok: false, result: { error: 'confirmation_declined' } });
});
