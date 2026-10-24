// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KnowledgeSourcesSection } from './KnowledgeSourcesSection';
let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function fill(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
it('adds a read-only folder with its patterns, renders indexing state, and removes its derived facts', async () => {
  let sources: Array<Record<string, unknown>> = [];
  const mutations: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); mutations.push(body);
      sources = body.action === 'add' ? [{ ...body, id: 'source-one', name: 'Notes', state: 'indexing', facts: 0 }] : [];
    }
    return Response.json({ sources });
  }));
  await act(async () => root.render(createElement(KnowledgeSourcesSection)));
  expect(container.textContent).toContain('Sources never become workspaces');
  act(() => { fill('Knowledge folder path', '/notes'); fill('Knowledge exclude patterns', 'archive/**, attachments/**'); });
  const add = [...container.querySelectorAll('button')].find(b => b.textContent === 'Add knowledge folder')!;
  await act(async () => add.click());
  expect(mutations[0]).toEqual({ action: 'add', path: '/notes', include: ['**/*.md'], exclude: ['archive/**', 'attachments/**'] });
  expect(container.textContent).toContain('indexing');
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove Notes and its facts"]')!.click());
  expect(mutations[1]).toEqual({ action: 'remove', id: 'source-one' });
  expect(container.textContent).not.toContain('indexing');
});
it('retains the typed path and reports a refused add without claiming success', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ error: 'Choose a real folder.' }, { status: 400 }) : Response.json({ sources: [] })));
  await act(async () => root.render(createElement(KnowledgeSourcesSection)));
  act(() => fill('Knowledge folder path', '/linked-notes'));
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Add knowledge folder')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Choose a real folder.');
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Knowledge folder path"]')!.value).toBe('/linked-notes');
});
