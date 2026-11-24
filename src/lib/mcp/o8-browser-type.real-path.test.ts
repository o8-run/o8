// @vitest-environment jsdom
import { act, createElement, useState, type FormEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserAgent } from '@/lib/browser-agent/page-agent';
import { createO8WebviewBrowserHandlers } from './o8-webview-browser-tools';

const transport = vi.hoisted(() => ({ evalJs: vi.fn() }));
vi.mock('./o8-webview-client', () => ({ O8WebviewClient: class { evalJs = transport.evalJs; } }));
vi.mock('@/lib/browser-engine/engine', () => ({ getBrowserEngine: () => ({ hasSession: () => false }) }));
vi.mock('@/lib/lane/events', () => ({ recordLaneEvent: vi.fn() }));
vi.mock('@/lib/lane/registry', () => ({ findLatestLaneByPacket: vi.fn(() => null) }));
const { POST } = await import('@/app/api/browser/agent/route');

let root: Root | null = null;
let page: Document;
let events: Array<{ type: string; value: string }>;
const handler = createO8WebviewBrowserHandlers().o8_browser_type;

function ControlledField({ multiline }: { multiline: boolean }) {
  const [value, setValue] = useState('original value');
  const change = (event: FormEvent<HTMLInputElement | HTMLTextAreaElement>) => setValue(event.currentTarget.value);
  return createElement('form', null,
    createElement(multiline ? 'textarea' : 'input', { id: 'field', value, onInput: change, onChange: change }),
    createElement('output', { id: 'observed' }, value));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  events = [];
  const frame = document.createElement('iframe');
  frame.dataset.o8Browser = 'canvas'; frame.dataset.o8Active = 'true';
  document.body.append(frame); page = frame.contentDocument!;
  installBrowserAgent();
  transport.evalJs.mockReset().mockImplementation(async (code: string) => ({ result: window.eval(code) }));
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => POST(new NextRequest('http://localhost/api/browser/agent', {
    method: 'POST', body: String(init.body),
  }))));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null; delete window.__o8BrowserAgent;
  delete (globalThis as { __o8BrowserAgentClient?: unknown }).__o8BrowserAgentClient;
  document.body.replaceChildren(); vi.unstubAllGlobals();
});

async function renderField(multiline: boolean) {
  root = createRoot(page.body);
  await act(async () => root!.render(createElement(ControlledField, { multiline })));
  const field = page.querySelector<HTMLInputElement | HTMLTextAreaElement>('#field')!;
  for (const type of ['input', 'change']) field.addEventListener(type, () => events.push({ type, value: field.value }));
  return field;
}

describe('Browser typing through MCP, the HTTP route and the installed page agent', () => {
  it.each(['', '   ', '  exact spaces  ', 'first line\n  second line\n'])('preserves textarea value %j and controlled input events', async (text) => {
    const field = await renderField(true);
    let result: Awaited<ReturnType<typeof handler>>;
    await act(async () => { result = await handler({ selector: '#field', text, surface: 'canvas' }); });
    expect(result!.isError).not.toBe(true);
    expect(JSON.parse((result!.content[0] as { text: string }).text)).toMatchObject({ ok: true, typed: text.length, into: '#field' });
    expect(field.value).toBe(text); expect(page.querySelector('#observed')!.textContent).toBe(text);
    expect(events).toEqual([{ type: 'input', value: text }, { type: 'change', value: text }]);
    expect(fetch).toHaveBeenCalledOnce(); expect(transport.evalJs).toHaveBeenCalledOnce();
  });

  it('fills and then clears the same controlled input', async () => {
    const field = await renderField(false);
    await act(async () => { await handler({ selector: '#field', text: '  populated  ', surface: 'canvas' }); });
    expect(field.value).toBe('  populated  ');
    await act(async () => { await handler({ selector: '#field', text: '', surface: 'canvas' }); });
    expect(field.value).toBe(''); expect(page.querySelector('#observed')!.textContent).toBe('');
  });

  it.each([undefined, null, 0, false, {}])('rejects a non-string value %j before routing', async (text) => {
    const result = await handler({ selector: '#field', text });
    expect(result.isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['', '   ', undefined])('keeps selector validation strict for %j', async (selector) => {
    const result = await handler({ selector, text: '' });
    expect(result.isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
  });
});
