import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

let reference: Awaited<ReturnType<typeof startParityReference>>;
beforeAll(async () => { reference = await startParityReference(); }, 120_000);
afterAll(async () => { await reference?.stop(); });

describe('WS server after voice retirement', () => {
  it('keeps the shared mobile terminal and update inventory endpoints available', async () => {
    const origin = reference.url.replace(/^ws:/, 'http:').replace(/\/ws$/, '');
    const headers = { authorization: `Bearer ${reference.token}`, 'content-type': 'application/json' };
    const inventory = await fetch(`${origin}/terminal-voice-sessions`, { headers });
    expect(inventory.status).toBe(200);
    expect(await inventory.json()).toEqual({ sessions: [] });
    const input = await fetch(`${origin}/terminal-voice-input`, {
      method: 'POST', headers, body: JSON.stringify({}),
    });
    expect(input.status).toBe(400);
    expect(await input.text()).toBe('sessionName and text required');
    const denied = await fetch(`${origin}/terminal-voice-sessions`);
    expect(denied.status).toBe(401);
  });

  it.each(['/symon-task-complete', '/internal/next/voice-host'])(
    'no longer serves the retired callback %s', async path => {
      const origin = reference.url.replace(/^ws:/, 'http:').replace(/\/ws$/, '');
      const response = await fetch(`${origin}${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${reference.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(404);
    },
  );
});
