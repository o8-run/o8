// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelThinkingChip } from './ModelThinkingChip';

describe('ModelThinkingChip Claude Code carrier truth', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('does not read a different provider profile for a static worker label', async () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    await act(async () => root.render(createElement(ModelThinkingChip, { modelLabel: 'Muse Code Agent default', activeBackend: 'muse', effort: 'high', adaptiveEnabled: false })));
    expect(request).not.toHaveBeenCalled(); expect(container.querySelector('button')?.disabled).toBe(true);
  });

  it('names the Fable the Fable backend runs for a saved Fable 5.1 pick', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) } as Response)));
    await act(async () => {
      root.render(createElement(ModelThinkingChip, {
        modelLabel: 'Fable 5.1',
        modelId: 'claude-fable-5-1',
        activeBackend: 'fable',
        effort: 'high',
        adaptiveEnabled: true,
        onEffortChange: () => {},
      }));
    });
    expect(container.textContent).toContain('Fable 5.2');
    expect(container.textContent).not.toContain('Fable 5.1');
  });

  it('shows the effective Codex model instead of the stale native Claude selection', async () => {
    const fetchProfile = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        profile: { source: 'codex-subscription' },
        effectiveModel: 'gpt-5.6-sol',
      }),
    } as Response));
    vi.stubGlobal('fetch', fetchProfile);

    await act(async () => {
      root.render(createElement(ModelThinkingChip, {
        modelLabel: 'Opus 4.8',
        modelId: 'claude-opus-4-8',
        activeBackend: 'claude',
        effort: 'high',
        adaptiveEnabled: true,
        onEffortChange: () => {},
      }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    expect(fetchProfile).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Sol');
    expect(container.textContent).not.toContain('Opus 4.8');
  });

  it('shows the effective API-carried model instead of the stale native selection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        profile: { source: 'openrouter' },
        effectiveModel: 'provider/frontier-model',
      }),
    } as Response)));

    await act(async () => {
      root.render(createElement(ModelThinkingChip, {
        modelLabel: 'Opus 4.8',
        modelId: 'claude-opus-4-8',
        activeBackend: 'claude',
        effort: 'high',
        adaptiveEnabled: true,
        onEffortChange: () => {},
      }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    expect(container.textContent).toContain('provider/frontier-model');
    expect(container.textContent).not.toContain('Opus 4.8');
  });

  it('offers Astra without clearing an explicit ultra effort', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input) => String(input).includes('operator-defaults')
      ? { ok: true, json: async () => ({ dispatchableRuntimes: [{ id: 'codex', label: 'Codex', available: true, unavailableReason: null, detail: '', fix: '' }] }) } as Response
      : { ok: false } as Response));
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    const onModelChange = vi.fn();
    const onEffortChange = vi.fn();

    await act(async () => {
      root.render(createElement(ModelThinkingChip, {
        modelLabel: 'Sol',
        modelId: 'gpt-5.6-sol',
        activeBackend: 'codex',
        effort: 'ultra',
        adaptiveEnabled: true,
        onModelChange,
        onEffortChange,
      }));
    });
    const trigger = container.querySelector('button[aria-haspopup="menu"]');
    await act(async () => { trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const astra = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find((button) => button.textContent?.includes('GPT-6 Astra'));
    expect(astra).toBeTruthy();

    await act(async () => { astra?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onModelChange).toHaveBeenCalledWith('gpt-6-astra');
    expect(onEffortChange).not.toHaveBeenCalledWith('max');
  });
});
