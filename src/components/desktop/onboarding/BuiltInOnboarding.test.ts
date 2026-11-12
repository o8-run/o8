// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { OnboardingDispatchStep } from './OnboardingDispatchStep';
import { previewBuiltInAgent } from '../../../../tests/fixtures/onboarding/built-in-agent-fixture';
import { recommendRuntimeSetup, type SetupRuntime } from '@/lib/setup/runtime-recommendation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; });
const cli = { id: 'codex', label: 'Codex', available: true, unavailableReason: null, detail: 'Ready', fix: '' } satisfies SetupRuntime;
const activity = { codex: 0, claude: 0, complete: true };
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === name)!;

async function mount(inventory: SetupRuntime[], delayScan = false) {
  const builtInAgent = inventory.find((item) => item.builtIn) ?? null;
  let finishScan: (() => void) | undefined;
  const scanGate = delayScan ? new Promise<void>((resolve) => { finishScan = resolve; }) : Promise.resolve();
  const request = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (String(input).includes('include=setup-built-in')) return Response.json({ builtInAgent });
    await scanGate;
    return Response.json({ values: {}, sources: {}, dispatchableRuntimes: inventory, setupRecommendation: recommendRuntimeSetup({ inventory, activity }) });
  });
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(OnboardingDispatchStep, {
    request, onContinue: vi.fn(), onSkip: vi.fn(),
    renderButton: (props) => createElement('button', { onClick: props.onClick, disabled: props.disabled }, props.label),
  })));
  return { request, finishScan };
}

it('selects the built-in agent without a CLI and offers the ready setup', async () => {
  await mount([previewBuiltInAgent()]);
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Built-in agent (Pi): Ready"]')?.getAttribute('aria-pressed')).toBe('true');
  expect(document.body.textContent).toContain('π');
  expect(document.body.textContent).toContain('Uses the configured runtime');
  expect(document.body.textContent).toContain('Uses the configured model connection');
  expect(document.body.textContent).not.toMatch(/daily|weekly|allowance|upgrade/i);
  expect(document.body.textContent).not.toContain('Connect a coding tool');
  expect(button('Use this setup').disabled).toBe(false);
});

it('keeps a detected CLI selected and allows the built-in choice without forcing it', async () => {
  const { request } = await mount([previewBuiltInAgent('pro'), cli]);
  const builtIn = document.querySelector<HTMLButtonElement>('[aria-label="Built-in agent (Pi): Ready"]')!;
  expect(builtIn.getAttribute('aria-pressed')).toBe('false');
  expect(document.body.textContent).toContain('Uses the configured model connection');
  expect(document.body.textContent).not.toMatch(/daily|weekly|allowance|upgrade/i);
  await act(async () => builtIn.click());
  expect(builtIn.getAttribute('aria-pressed')).toBe('true');
  await act(async () => button('Use this setup').click());
  expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true);
});

it('shows the Windows reason while blocking selection and saving', async () => {
  await mount([previewBuiltInAgent('free', 'win32')]);
  const builtIn = document.querySelector<HTMLButtonElement>('[aria-label="Built-in agent (Pi): Unavailable"]')!;
  expect(builtIn.disabled).toBe(true);
  expect(builtIn.getAttribute('aria-pressed')).toBe('false');
  expect(document.body.textContent).toContain('Windows support is not available yet.');
  expect(button('Use this setup').disabled).toBe(true);
});

it('renders built-in readiness before the unrelated CLI scan settles', async () => {
  const { finishScan } = await mount([previewBuiltInAgent(), cli], true);
  expect(document.querySelector('[aria-label="Built-in agent (Pi): Ready"]')).not.toBeNull();
  expect(document.body.textContent).not.toContain('Not installed');
  expect(button('Use this setup').disabled).toBe(true);
  await act(async () => finishScan!());
  expect(button('Use this setup').disabled).toBe(false);
});
