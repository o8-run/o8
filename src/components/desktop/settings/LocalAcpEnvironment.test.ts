// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('./useModelSettings', () => ({ useModelSettings: () => ({ data: { dispatchableRuntimes: [], values: {}, sources: {} }, loading: false, updateField: vi.fn() }) }));
vi.mock('./APIKeysTab', () => ({ ApiKeysProviderList: () => null, NativeKeysList: () => null }));
vi.mock('./ModelsTab', () => ({ ModelDefaultsContent: () => null }));
vi.mock('./LocalModelsTab', () => ({ LocalModelsContent: () => null }));
vi.mock('./CliUpdatePrompt', () => ({ CliUpdatePrompt: () => null }));
import { ProvidersTab } from './ProvidersTab';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const fetcher = vi.fn();
const button = (text: string) => [...container.querySelectorAll('button')].find(x => x.textContent === text)!;
const field = (label: string) => container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
async function edit(label: string, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(label), value);
    field(label).dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(async () => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  fetcher.mockReset();
  fetcher.mockImplementation(async (url: string) => Response.json(url.includes('?environment=1')
    ? { connectionId: 'fixture', revision: 1, variables: [{ name: 'ACP_TOKEN', secret: true, configured: true }] }
    : url.includes('acp-connection') ? { connection: { name: 'Fixture', command: 'fixture-agent', args: [], useOpenRouter: false } }
      : url === '/api/v2/keys' ? { providers: [] } : { tools: [], capacities: [], identities: [], runtimes: [] }));
  vi.stubGlobal('fetch', fetcher);
  await act(async () => root.render(createElement(ProvidersTab, { section: 'Local ACP' })));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('masks saved secrets and preserves unsaved environment values when switching provider panes', async () => {
  expect(field('Environment value 1').type).toBe('password');
  expect(field('Environment value 1').value).toBe('');
  await edit('Environment value 1', 'synthetic-draft');
  await act(async () => container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Model defaults"]')!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Local ACP"]')!.click());
  expect(field('Environment value 1').value).toBe('synthetic-draft');
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
});

it('keeps a failed save retryable, clears secret drafts after success and saves removals', async () => {
  await edit('Environment value 1', 'synthetic-new');
  let attempts = 0;
  fetcher.mockImplementation(async (_url: string, options?: RequestInit) => {
    const body = JSON.parse(options?.body as string);
    expect(body.environment.variables).toEqual(attempts < 2 ? [{ name: 'ACP_TOKEN', secret: true, value: 'synthetic-new' }] : []);
    attempts += 1;
    return attempts === 1 ? Response.json({ error: 'Store unavailable' }, { status: 400 })
      : Response.json({ connectionId: 'fixture', revision: attempts, variables: attempts === 2 ? [{ name: 'ACP_TOKEN', secret: true, configured: true }] : [] });
  });
  await act(async () => button('Save environment').click());
  expect(container.textContent).toContain('Store unavailable');
  expect(field('Environment value 1').value).toBe('synthetic-new');
  await act(async () => button('Save environment').click());
  expect(field('Environment value 1').value).toBe('');
  await act(async () => button('Remove variable 1').click());
  await act(async () => button('Save environment').click());
  expect(attempts).toBe(3);
});

it('keeps the connection-change warning when an earlier save finishes later', async () => {
  await edit('Environment value 1', 'synthetic-pending');
  let settle!: (response: Response) => void;
  fetcher.mockImplementation(() => new Promise<Response>(resolve => { settle = resolve; }));
  await act(async () => button('Save environment').click());
  await act(async () => window.dispatchEvent(new Event('o8:acp-connection-changed')));
  await act(async () => settle(Response.json({ connectionId: 'fixture', revision: 2, variables: [] })));
  expect(container.textContent).toContain('connection changed');
  expect(field('Environment value 1').value).toBe('synthetic-pending');
  expect(button('Save environment').closest('fieldset')?.disabled).toBe(true);
});
