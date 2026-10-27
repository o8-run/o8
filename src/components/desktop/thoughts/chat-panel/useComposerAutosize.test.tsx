// @vitest-environment jsdom
import { act, createElement, useCallback, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useComposerAutosize } from './useComposerAutosize';

let host: HTMLDivElement; let root: Root; let width: number; let measuredHeight: number; let resize: () => void;
function Harness({ value, active = true }: { value: string; active?: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const bind = useCallback((node: HTMLTextAreaElement | null) => { input.current = node; }, []);
  useComposerAutosize(input, value, active);
  return <textarea ref={bind} value={value} readOnly />;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); width = 440; measuredHeight = 52;
  vi.spyOn(HTMLTextAreaElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width }) as DOMRect);
  vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => measuredHeight);
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('grows an inserted draft, remeasures narrower panes and shrinks after sending', async () => {
  await act(async () => root.render(createElement(Harness, { value: '' })));
  const input = host.querySelector('textarea')!;
  measuredHeight = 140;
  await act(async () => root.render(createElement(Harness, { value: 'Inserted multiline draft' })));
  expect(input.style.height).toBe('140px');
  width = 300; measuredHeight = 320;
  await act(async () => resize()); expect(input.style.height).toBe('200px');
  measuredHeight = 52;
  await act(async () => root.render(createElement(Harness, { value: '' })));
  expect(input.style.height).toBe('52px');
});
it('bounds text on short screens and remeasures a hidden composer when shown', async () => {
  measuredHeight = 360; width = 0;
  await act(async () => root.render(createElement(Harness, { value: 'Restored draft', active: false })));
  vi.stubGlobal('innerHeight', 400); width = 320;
  await act(async () => root.render(createElement(Harness, { value: 'Restored draft' })));
  expect(Number.parseFloat(host.querySelector('textarea')!.style.height)).toBeCloseTo(112);
});
it('reuses unchanged composer geometry when a retained session returns', async () => {
  measuredHeight = 140;
  await act(async () => root.render(createElement(Harness, { value: 'Retained draft' })));
  const input = host.querySelector('textarea')!;
  const geometry = vi.mocked(HTMLTextAreaElement.prototype.getBoundingClientRect);
  geometry.mockClear();
  await act(async () => root.render(createElement(Harness, { value: 'Retained draft', active: false })));
  await act(async () => root.render(createElement(Harness, { value: 'Retained draft' })));
  expect(input.style.height).toBe('140px');
  expect(geometry).not.toHaveBeenCalled();
  width = 280; measuredHeight = 180;
  await act(async () => resize());
  expect(input.style.height).toBe('180px');
});

it('remeasures a changed hidden draft and falls back when resize observation is unavailable', async () => {
  await act(async () => root.render(createElement(Harness, { value: '' })));
  await act(async () => root.render(createElement(Harness, { value: 'Changed while hidden', active: false })));
  measuredHeight = 170;
  await act(async () => root.render(createElement(Harness, { value: 'Changed while hidden' })));
  expect(host.querySelector('textarea')!.style.height).toBe('170px');
  await act(async () => root.render(createElement(Harness, { value: 'Changed while hidden', active: false })));
  vi.stubGlobal('ResizeObserver', undefined);
  measuredHeight = 190;
  await act(async () => root.render(createElement(Harness, { value: 'Changed while hidden' })));
  expect(host.querySelector('textarea')!.style.height).toBe('190px');
});
