// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsentScenario, createConsentPreviewRequest, FirstRunPreview } from './FirstRunPreview';

const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settle(milliseconds = 80) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
}

describe('first-run preview route surface', () => {
  it.each(['unanswered', 'one-choice'] as const)('keeps %s unsaved', async (state) => {
    const request = vi.fn(createConsentPreviewRequest(state));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => root.render(createElement(ConsentScenario, { state, request })));
    expect(container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(state === 'one-choice' ? 1 : 0);
    const save = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Save privacy choices');
    expect(save?.disabled).toBe(state === 'unanswered');
    expect(request.mock.calls.filter(([init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it.each(['saving', 'error'] as const)('reaches %s with one fixture save when timed clicks batch before React commits', async (state) => {
    vi.useFakeTimers();
    const request = vi.fn(createConsentPreviewRequest(state));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => root.render(createElement(ConsentScenario, { state, request })));
    // All old timer callbacks run before React can commit either selection.
    await act(async () => vi.advanceTimersByTime(100));

    expect(container.textContent).toContain(state === 'saving'
      ? 'Saving choices…' : 'Preview: choices could not be saved.');
    const writes = () => request.mock.calls.filter(([init]) => init?.method === 'POST');
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(String(writes()[0][0]?.body))).toEqual({
      crashReportsEnabled: true,
      productTelemetryEnabled: null,
      telemetryConsentAnswered: true,
    });
    await act(async () => vi.advanceTimersByTime(100));
    expect(writes()).toHaveLength(1);
  });

  it('does not drive another scenario while its own choices are still loading', async () => {
    vi.useFakeTimers();
    let releaseRead!: (response: Response) => void;
    const delayedRequest = vi.fn(() => new Promise<Response>((resolve) => { releaseRead = resolve; }));
    const unansweredRequest = vi.fn(createConsentPreviewRequest('unanswered'));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => root.render(createElement('div', null,
      createElement(ConsentScenario, { state: 'saving', request: delayedRequest, key: 'loading' }),
      createElement(ConsentScenario, { state: 'unanswered', request: unansweredRequest, key: 'unanswered' }),
    )));
    await act(async () => vi.advanceTimersByTime(100));
    const selected = container.querySelectorAll('[aria-pressed="true"]');
    expect(selected).toHaveLength(0);
    expect(unansweredRequest.mock.calls.filter(([init]) => init?.method === 'POST')).toHaveLength(0);

    // Replace the loading scenario before its response arrives, as a reset does.
    await act(async () => root.render(createElement(ConsentScenario, {
      state: 'unanswered', request: unansweredRequest, key: 'replacement',
    })));
    await act(async () => {
      releaseRead(Response.json({ values: { telemetryConsentAnswered: false } }));
      vi.advanceTimersByTime(100);
    });
    expect(container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    expect(unansweredRequest.mock.calls.filter(([init]) => init?.method === 'POST')).toHaveLength(0);
    expect(delayedRequest).toHaveBeenCalledTimes(1);
  });

  it('renders the real consent card and drives its saving state from the harness', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => { root.render(createElement(FirstRunPreview)); });
    await settle();
    const surface = document.querySelector('[aria-label="First-run surface"]') as HTMLSelectElement;
    surface.value = 'consent';
    await act(async () => { surface.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
    expect(document.querySelector('[aria-labelledby="telemetry-consent-title"]')).not.toBeNull();

    const statePicker = document.querySelector('[aria-label="Consent state"]') as HTMLSelectElement;
    statePicker.value = 'saving';
    await act(async () => { statePicker.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle(160);

    expect(document.body.textContent).toContain('Saving choices…');
    expect(document.body.textContent).toContain('isolated state');
  });

  it('jumps through the real onboarding flow without a live API', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => { root.render(createElement(FirstRunPreview)); });
    await settle();

    const surfacePicker = document.querySelector('[aria-label="First-run surface"]') as HTMLSelectElement;
    surfacePicker.value = 'onboarding';
    await act(async () => { surfacePicker.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
    expect(document.body.textContent).toContain('Open a project');

    const stepPicker = document.querySelector('[aria-label="Onboarding step"]') as HTMLSelectElement;
    stepPicker.value = 'dispatch';
    await act(async () => { stepPicker.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
    expect(document.body.textContent).toContain('Choose your agent');
  });
});
