import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
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
