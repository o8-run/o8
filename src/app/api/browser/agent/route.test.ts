import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  evalJs: vi.fn(),
  nextRequest: vi.fn(),
  hasEngineSession: vi.fn(),
  engineRead: vi.fn(),
}));

vi.mock('@/lib/mcp/o8-webview-client', () => ({
  O8WebviewClient: class {
    evalJs = mocks.evalJs;
  },
}));

vi.mock('@/lib/browser-engine/engine', () => ({
  getBrowserEngine: () => ({ hasSession: mocks.hasEngineSession, read: mocks.engineRead }),
}));
vi.mock('@/lib/next/browser-pipe', () => ({ requestNextBrowser: mocks.nextRequest }));

vi.mock('@/lib/lane/events', () => ({ recordLaneEvent: vi.fn() }));
vi.mock('@/lib/lane/registry', () => ({ findLatestLaneByPacket: vi.fn(() => null) }));

const { POST } = await import('./route');

function request(verb: string, args: Record<string, unknown>) {
  return new NextRequest('http://localhost:3001/api/browser/agent', {
    method: 'POST',
    body: JSON.stringify({ verb, args }),
  });
}

describe('/api/browser/agent localization verbs', () => {
  beforeEach(() => {
    mocks.evalJs.mockReset();
    mocks.nextRequest.mockReset().mockReturnValue(null);
    mocks.hasEngineSession.mockReset().mockReturnValue(false);
    mocks.engineRead.mockReset();
  });

  it('keeps default verbs on the existing engine session while a Next child is open', async () => {
    const engine = { ok: true, url: 'https://example.org/', title: 'Engine page', text: 'Engine text', interactive: [] };
    mocks.hasEngineSession.mockReturnValue(true);
    mocks.engineRead.mockResolvedValue(engine);
    mocks.nextRequest.mockReturnValue(Promise.resolve({ ok: true, title: 'Next page' }));
    expect(await (await POST(request('read', {}))).json()).toEqual(engine);
    expect(mocks.nextRequest).not.toHaveBeenCalled();
    expect(mocks.engineRead).toHaveBeenCalledOnce();
  });

  it('targets explicit panel at Next even when an engine session exists, without replay on a failed receipt', async () => {
    mocks.hasEngineSession.mockReturnValue(true);
    const receipt = { ok: false, actionDispatched: null, automaticReplay: false };
    mocks.nextRequest.mockReturnValue(Promise.resolve(receipt));
    expect(await (await POST(request('click', { surface: 'panel', selector: '#link' }))).json()).toEqual(receipt);
    expect(mocks.nextRequest).toHaveBeenCalledWith('click', { surface: 'panel', selector: '#link' });
    expect(mocks.engineRead).not.toHaveBeenCalled();
    expect(mocks.evalJs).not.toHaveBeenCalled();
  });

  it('drives localize through the real iframe-agent route', async () => {
    const envelope = {
      ok: true,
      surface: 'canvas',
      coordinateSpace: 'host-viewport',
      viewport: { width: 1200, height: 800 },
      interactive: [{ selector: '#save', tag: 'button', label: 'Save', rect: { left: 10, top: 20, width: 80, height: 30 } }],
    };
    mocks.evalJs.mockResolvedValue({ result: JSON.stringify(envelope) });

    const response = await POST(request('localize', { surface: 'canvas' }));
    expect(await response.json()).toEqual(envelope);
    expect(mocks.evalJs).toHaveBeenCalledOnce();
    expect(mocks.evalJs.mock.calls[0][0]).toContain('.localize(');
  });

  it('drives an exact selector rect through the same production route', async () => {
    const envelope = {
      ok: true,
      surface: 'canvas',
      coordinateSpace: 'host-viewport',
      viewport: { width: 1200, height: 800 },
      selector: '#save',
      tag: 'button',
      label: 'Save',
      rect: { left: 10, top: 20, width: 80, height: 30 },
    };
    mocks.evalJs.mockResolvedValue({ result: JSON.stringify(envelope) });

    const response = await POST(request('rect', { surface: 'canvas', selector: '#save' }));
    expect(await response.json()).toEqual(envelope);
    expect(mocks.evalJs.mock.calls[0][0]).toContain('.rect(');
  });

  it('pulls native-child localization through browser_view_eval_result', async () => {
    const envelope = {
      ok: true,
      surface: 'native',
      coordinateSpace: 'page-viewport',
      viewport: { width: 900, height: 600 },
      interactive: [],
    };
    mocks.evalJs.mockResolvedValue({
      result: JSON.stringify({ open: true, result: JSON.stringify(envelope) }),
    });

    const response = await POST(request('localize', { surface: 'panel' }));
    expect(await response.json()).toEqual(envelope);
    expect(mocks.evalJs.mock.calls[0][0]).toContain('browser_view_eval_result');
    expect(mocks.evalJs.mock.calls[0][0]).toContain('.localize(');
  });

  it('preserves a pending Browser observation instead of treating dispatch as opened', async () => {
    const envelope = { ok: false, status: 'pending', requestId: 'observed-browser-request', automaticReplay: false, actionDispatched: true, reason: 'browser-not-visible' };
    mocks.evalJs.mockResolvedValue({ result: JSON.stringify(envelope) });
    const response = await POST(request('open', { requestId: envelope.requestId, timeoutMs: 0 }));
    expect(await response.json()).toEqual(envelope);
    expect(mocks.evalJs).toHaveBeenCalledOnce();
    expect(mocks.evalJs.mock.calls[0][0]).not.toContain('new CustomEvent');
  });

  it('leaves a missing Browser request unavailable without dispatching a new open', async () => {
    const envelope = { ok: false, status: 'unavailable', requestId: 'missing-browser-request', automaticReplay: false, actionDispatched: null, reason: 'request-not-found' };
    mocks.evalJs.mockResolvedValue({ result: JSON.stringify(envelope) });
    const response = await POST(request('open', { requestId: envelope.requestId, timeoutMs: 0 }));
    expect(await response.json()).toEqual(envelope);
    expect(mocks.evalJs).toHaveBeenCalledOnce();
    expect(mocks.evalJs.mock.calls[0][0]).not.toContain('new CustomEvent');
  });
});
