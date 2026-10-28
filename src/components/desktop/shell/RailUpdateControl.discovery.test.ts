// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/components/shared/ConfirmToastHost', () => ({ toast: vi.fn() }));
let root: Root | undefined;
let resetBudget: (() => void) | undefined;
let budgetHolders: (() => string[]) | undefined;
const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
const tool = (runtimeId = 'codex', label = 'Fixture tool', status = 'update-available') => ({
  runtimeId, label, status, installedVersion: '1.0.0', latestVersion: '2.0.0',
  selectedPath: '/fixture/tool', updateUrl: 'https://example.test/tool',
});
beforeEach(() => {
  vi.resetModules();
  delete (globalThis as typeof globalThis & { __o8UpdateHub?: unknown }).__o8UpdateHub;
  localStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds);
    return controller.signal;
  });
});
afterEach(async () => {
  await act(async () => {
    for (const controller of streams.splice(0)) { try { controller.close(); } catch { /* already ended */ } }
    root?.unmount(); root = undefined;
  });
  resetBudget?.(); resetBudget = undefined;
  budgetHolders = undefined;
  document.body.innerHTML = '';
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const tick = async (milliseconds = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); }); };
const panel = () => document.querySelector('[aria-label="Updates and release notes"]')!;
async function openTools(discovery: (options: RequestInit | undefined) => Promise<Response>) {
  const fetcher = vi.fn((input: RequestInfo | URL, options?: RequestInit) => String(input).startsWith('/api/setup/cli-updates')
    ? discovery(options) : Promise.resolve(Response.json({ source: 'release', entries: [], summary: 'Fixture release' })));
  vi.stubGlobal('fetch', fetcher);
  window.fetch = fetcher as typeof fetch;
  const budget = await import('@/lib/connection-budget');
  resetBudget = budget.resetLongLivedFetchBudgetForTests;
  budgetHolders = budget.snapshotLongLivedFetchBudgetForTests;
  budget.installLongLivedFetchBudgetGuard();
  vi.stubGlobal('fetch', window.fetch);
  const { RailUpdateControl } = await import('./RailUpdateControl');
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(RailUpdateControl, { buttonStyle: {} })));
  expect(fetcher.mock.calls.filter(([input]) => String(input).startsWith('/api/setup/cli-updates'))).toHaveLength(0);
  await act(async () => host.querySelector('[aria-label="Updates"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
  expect(fetcher.mock.calls.filter(([input]) => String(input).startsWith('/api/setup/cli-updates'))).toHaveLength(0);
  await act(async () => panel().querySelector<HTMLButtonElement>('[aria-label="Tools updates"]')!.click());
  return fetcher;
}
function delayedReport(options: RequestInit | undefined, tools = [tool()], delay = 20_000) {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(Response.json({ tools })), delay);
    options?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal!.reason); }, { once: true });
  });
}
function stream(signal?: AbortSignal | null) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) {
    controller = value; streams.push(value);
    signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
  } });
  return { response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    send: (event: string, data: unknown) => controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
    end: () => controller.close() };
}
it.each(['stream', 'json'] as const)('shows all eleven installed tools from %s discovery with their versions and update states', async transport => {
  const runtimeIds = ['codex', 'claude-code', 'grok', 'opencode', 'antigravity', 'gemini', 'cursor', 'pi', '3code', 'copilot-cli', 'qoder'];
  const tools = runtimeIds.map((runtimeId, index) => ({ ...tool(runtimeId, `Installed tool ${index + 1}`,
    index % 3 === 0 ? 'current' : index % 3 === 1 ? 'update-available' : 'unknown'),
    installedVersion: `1.${index}.0`, latestVersion: `2.${index}.0` }));
  const report = [...tools, tool('absent-fixture', 'Absent tool', 'not-installed')];
  const result = transport === 'stream' ? stream() : null;
  const fetcher = await openTools(async () => result?.response ?? Response.json({ tools: report }));
  if (result) {
    await act(async () => {
      report.forEach((tool, index) => result.send('tool', { tool, completed: index + 1, total: report.length }));
      result.send('result', { tools: report }); result.end();
    });
  }
  await tick();
  const toolsToggle = panel().querySelector('[aria-label="Tools updates"]')!;
  expect(toolsToggle.getAttribute('aria-expanded')).toBe('true');
  expect([...panel().querySelectorAll('button')].some(button => button.textContent?.startsWith('Current CLIs'))).toBe(false);
  const toolsList = document.getElementById(toolsToggle.getAttribute('aria-controls')!)!;
  expect([...toolsList.querySelectorAll('[data-cli-update-row]')].map(row => row.getAttribute('data-cli-update-row'))).toEqual(runtimeIds);
  for (const tool of tools) {
    const row = panel().querySelector(`[data-cli-update-row="${tool.runtimeId}"]`)!;
    expect(row.textContent).toContain(tool.label);
    expect(row.textContent).toContain(tool.installedVersion);
    expect(row.getAttribute('aria-busy')).toBe('false');
    if (tool.status === 'current') expect(row.textContent).toContain('Current');
    else {
      expect(row.querySelector(`[aria-label="Update ${tool.label}"]`)).not.toBeNull();
      if (tool.status === 'update-available') expect(row.textContent).toContain(`→ ${tool.latestVersion}`);
    }
  }
  expect(panel().textContent).not.toContain('Absent tool');
  expect(fetcher.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
});
it('finishes the first Tools open when cold discovery takes longer than fifteen seconds', async () => {
  await openTools(options => delayedReport(options));
  await tick(15_100);
  expect(panel().querySelector('[role="alert"]')).toBeNull();
  expect(panel().textContent).toContain('Checking');
  await tick(5_000);
  expect(panel().textContent).toContain('Fixture tool');
  expect(panel().querySelector('[role="alert"]')).toBeNull();
});
it('keeps the first Tools open loading past the headers guard until slow discovery finishes', async () => {
  const fetcher = await openTools(options => delayedReport(options, [tool()], 48_800));
  await tick(45_300);
  expect(panel().querySelector('[role="alert"]')).toBeNull();
  expect(panel().textContent).toContain('Checking installed tools');
  await act(async () => panel().querySelector<HTMLButtonElement>('[aria-label="Tools updates"]')!.click());
  await act(async () => panel().querySelector<HTMLButtonElement>('[aria-label="Tools updates"]')!.click());
  await tick(3_500);
  expect(panel().textContent).toContain('Fixture tool');
  expect(panel().querySelector('[role="alert"]')).toBeNull();
  expect(fetcher.mock.calls.filter(([input]) => String(input).startsWith('/api/setup/cli-updates'))).toHaveLength(1);
  expect(budgetHolders?.()).toEqual([]);
});
it('fails discovery that never sends headers at its own five-minute deadline', async () => {
  await openTools(options => delayedReport(options, [tool()], 301_000));
  await tick(299_999);
  expect(panel().querySelector('[role="alert"]')).toBeNull();
  expect(panel().textContent).toContain('Checking installed tools');
  await tick(1);
  expect(panel().querySelector('[role="alert"]')).not.toBeNull();
  expect(panel().querySelector('[aria-label="Retry tool discovery"]')).not.toBeNull();
  expect(budgetHolders?.()).toEqual([]);
});
it('fails a stream that keeps sending progress without finishing within five minutes', async () => {
  let result!: ReturnType<typeof stream>;
  await openTools(async options => { result = stream(options?.signal); return result.response; });
  for (let elapsed = 0; elapsed < 299_000; elapsed += 1_000) {
    await act(async () => result.send('progress', { completed: 0, total: 1 }));
    await tick(1_000);
  }
  expect(panel().querySelector('[role="alert"]')).toBeNull();
  await tick(1_000);
  expect(panel().querySelector('[role="alert"]')).not.toBeNull();
  expect(budgetHolders?.()).toEqual([]);
});
it('streams found rows and discovery progress before the slowest tool finishes', async () => {
  const result = stream();
  await openTools(async () => result.response);
  await act(async () => { result.send('progress', { completed: 0, total: 2 });
    result.send('tool', { tool: tool('codex', 'First tool', 'current'), completed: 1, total: 2 }); });
  await tick();
  expect(panel().textContent).toContain('First tool');
  expect(panel().querySelector('[data-cli-update-row="codex"]')?.getAttribute('aria-busy')).toBe('false');
  expect(panel().querySelector('[aria-label="Tool discovery"]')?.getAttribute('aria-valuenow')).toBe('1');
  await tick(61_000);
  expect(panel().querySelector('[role="alert"]')).toBeNull();
  expect(panel().querySelector('[aria-label="Tool discovery"]')).not.toBeNull();
  await act(async () => { result.send('tool', { tool: tool('grok', 'Second tool'), completed: 2, total: 2 });
    result.send('result', { tools: [tool('codex', 'First tool', 'current'), tool('grok', 'Second tool')] }); result.end(); });
  await tick();
  expect(panel().textContent).toContain('Second tool');
  expect(panel().querySelector('[aria-label="Tool discovery"]')).toBeNull();
  expect(budgetHolders?.()).toEqual([]);
});
it('keeps partial rows and lets Retry finish a new cold discovery after a broken stream', async () => {
  const first = stream(); let requests = 0;
  await openTools(options => ++requests === 1 ? Promise.resolve(first.response) : delayedReport(options, [tool('codex', 'First tool'), tool('grok', 'Retried tool')]));
  await act(async () => { first.send('tool', { tool: tool('codex', 'First tool'), completed: 1, total: 2 }); first.end(); });
  await tick();
  expect(panel().textContent).toContain('First tool');
  expect(panel().querySelector('[role="alert"]')).not.toBeNull();
  expect(budgetHolders?.()).toEqual([]);
  await act(async () => panel().querySelector<HTMLButtonElement>('[aria-label="Retry tool discovery"]')!.click());
  await tick(20_100);
  expect(requests).toBe(2);
  expect(panel().textContent).toContain('Retried tool');
  expect(panel().querySelector('[role="alert"]')).toBeNull();
});
