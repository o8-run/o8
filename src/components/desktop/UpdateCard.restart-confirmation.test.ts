// @vitest-environment jsdom

import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { install, invoke } = vi.hoisted(() => ({ install: vi.fn(), invoke: vi.fn() }));
vi.mock('@/lib/app-update/client-restart', async original => ({
  ...await original<typeof import('@/lib/app-update/client-restart')>(),
  installUpdateAndRestart: install,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => false, canUseTauriEvents: () => false }));

const { UpdateCard } = await import('./UpdateCard');
const { RailUpdateControl } = await import('./shell/RailUpdateControl');
const { ConfirmToastHost } = await import('@/components/shared/ConfirmToastHost');
const { invalidateOperatorDefaultsValuesSnapshot } = await import('@/lib/operator/operator-defaults-values-client');

const parked = { ok: true, idle: { idle: false, idleExceptParked: true,
  parkedLanes: [{ label: 'Saved review', status: 'reviewing' }], unavailable: [],
  active: { lanes: [{ label: 'Saved review', status: 'reviewing' }], terminalSessions: [], managedRuns: [],
    ownedSessions: [], cloudJobs: [], cliInstallers: [] } } };
const running = { ...parked, idle: { ...parked.idle, idleExceptParked: false,
  active: { ...parked.idle.active, terminalSessions: [{ name: 'Build terminal' }] } } };
const idle = { ok: true, idle: { ...parked.idle, idle: true, idleExceptParked: true,
  parkedLanes: [], active: { ...parked.idle.active, lanes: [] } } };

describe('explicit staged-update restart through the real rail and confirmation host', () => {
  let root: Root;
  let host: HTMLDivElement;
  let readiness: unknown;
  let reads: number;
  let defaults: () => Promise<Response>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.localStorage.clear();
    invalidateOperatorDefaultsValuesSnapshot();
    readiness = running;
    reads = 0;
    defaults = async () => Response.json({ values: { updateAutoApply: 'off' } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/panel/app/update-state')) return Response.json({ ok: true });
      if (url.startsWith('/api/panel/update/apply')) {
        reads += 1;
        return readiness === null ? new Response(null, { status: 503 }) : Response.json(readiness);
      }
      if (url.startsWith('/api/panel/operator-defaults')) return defaults();
      if (url.startsWith('/api/setup/cli-updates')) return Response.json({ tools: [] });
      return Response.json({ source: 'release', entries: [{ text: 'Fixture update' }], overview: 'Fixture update' });
    }));
    install.mockReset().mockResolvedValue({ installed: true, restartDeferred: true });
    invoke.mockReset().mockImplementation(async command => command === 'prepare_app_restart' ? 'fixture-reservation' : undefined);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    // A failed assertion must not leave a real confirmation queued for another test.
    await act(async () => button('Keep waiting')?.click());
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    invalidateOperatorDefaultsValuesSnapshot();
  });

  function button(label: string) {
    const scope = label === 'Restart anyway' || label === 'Keep waiting' ? '[aria-modal="true"] button' : 'button';
    return [...document.querySelectorAll<HTMLButtonElement>(scope)].find(row => row.textContent?.trim() === label);
  }

  async function mount(stage = true, showLegacy = false) {
    await act(async () => root.render(createElement(Fragment, null,
      createElement(UpdateCard, { quiet: !showLegacy }), createElement(RailUpdateControl, { buttonStyle: {} }),
      createElement(ConfirmToastHost))));
    await act(async () => { window.dispatchEvent(new CustomEvent('o8:update-found', {
      detail: { version: '0.1.801', currentVersion: '0.1.800' },
    })); });
    if (stage) await act(async () => { window.dispatchEvent(new Event('o8:install-app-update')); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Updates"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); });
  }

  async function clickRestart() {
    const restart = button('Restart now') ?? [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Updates and release notes"] button')].find(row => row.textContent?.trim() === 'Restart anyway');
    expect(restart, 'A staged update must retain its explicit restart action').toBeDefined();
    await act(async () => restart!.click());
  }

  it('keeps tool discovery out of launch and checks versions when Tools is opened', async () => {
    await mount(false);
    const toolReads = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith('/api/setup/cli-updates'));
    expect(toolReads()).toHaveLength(0);
    const tools = host.ownerDocument.querySelector<HTMLButtonElement>('[aria-label="Tools updates"]');
    expect(tools).not.toBeNull();
    await act(async () => tools!.click());
    expect(toolReads()).toHaveLength(1);
    expect(toolReads()[0]?.[0]).toBe('/api/setup/cli-updates?refresh=1');
    expect(toolReads()[0]?.[1]?.method).toBeUndefined();
  });

  it('keeps Restart now accessible with cached running work; cancellation never reserves or restarts', async () => {
    await mount();
    const before = reads;
    await clickRestart();
    await vi.waitFor(() => expect(button('Restart anyway')).toBeDefined());
    expect(reads).toBe(before + 1);
    expect(document.body.textContent).toContain('Build terminal');
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => button('Keep waiting')!.click());
    expect(button('Restart anyway')).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
    expect([...document.querySelectorAll<HTMLButtonElement>('[aria-label="Updates and release notes"] button')]
      .find(row => row.textContent === 'Restart anyway')?.disabled).toBe(false);
  });

  it('accepts one explicit interruption confirmation and retains native restart admission', async () => {
    await mount();
    await clickRestart();
    await vi.waitFor(() => expect(button('Restart anyway')).toBeDefined());
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => button('Restart anyway')!.click());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('restart_app', { reservationId: 'fixture-reservation' }));
    expect(invoke.mock.calls.map(row => row[0])).toEqual(['prepare_app_restart', 'restart_app']);
  });

  it('uses the same confirmation for the legacy card after installation is deferred', async () => {
    await mount(true, true);
    const legacy = document.querySelector<HTMLButtonElement>('[aria-label="Restart to install o8 v0.1.801"]');
    expect(legacy).not.toBeNull();
    await act(async () => legacy!.click());
    await vi.waitFor(() => expect(button('Restart anyway')).toBeDefined());
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => button('Restart anyway')!.click());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('restart_app', { reservationId: 'fixture-reservation' }));
  });

  it.each([['idle', idle], ['parked only', parked]])('refreshes stale live blockers and restarts directly when now %s', async (_name, fresh) => {
    await mount();
    readiness = fresh;
    const before = reads;
    await clickRestart();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('restart_app', { reservationId: 'fixture-reservation' }));
    expect(reads).toBe(before + 1);
    expect(button('Restart anyway')).toBeUndefined();
    expect(document.body.textContent).not.toContain('Build terminal');
  });

  it('requires confirmation when fresh work appeared after a parked-only snapshot', async () => {
    readiness = parked;
    await mount();
    readiness = running;
    await clickRestart();
    await vi.waitFor(() => expect(button('Restart anyway')).toBeDefined());
    expect(document.body.textContent).toContain('Build terminal');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('names unknown readiness and requires an explicit decision', async () => {
    await mount();
    readiness = null;
    await clickRestart();
    await vi.waitFor(() => expect(button('Restart anyway')).toBeDefined());
    expect(document.body.textContent).toContain('could not verify');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('prevents duplicate clicks from queuing another confirmation or native restart', async () => {
    await mount();
    const restart = button('Restart now') ?? [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Updates and release notes"] button')].find(row => row.textContent?.trim() === 'Restart anyway');
    expect(restart).toBeDefined();
    await act(async () => { restart!.click(); restart!.click(); });
    await vi.waitFor(() => expect(button('Restart anyway')).toBeDefined());
    expect([...document.querySelectorAll('[aria-modal="true"] button')].filter(row => row.textContent === 'Restart anyway')).toHaveLength(1);
    await act(async () => button('Restart anyway')!.click());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(button('Restart anyway')).toBeUndefined();
    expect(invoke.mock.calls.map(row => row[0])).toEqual(['prepare_app_restart', 'restart_app']);
  });

  it.each(['active', 'interrupted', 'unconfirmed'])('requires explicit consent to force past a %s CLI installer', async state => {
    readiness = { ...parked, idle: { ...parked.idle, idleExceptParked: false,
      active: { ...parked.idle.active, cliInstallers: [{ runtime: 'codex', state }] } } };
    await mount();
    await clickRestart();
    expect(button('Restart anyway')).toBeDefined();
    await act(async () => button('Restart anyway')!.click());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('prepare_app_restart', { force: true }));
    expect(document.body.textContent).toContain('CLI update');
  });

  it('preserves native installer refusal if ownership changes while confirmation is open', async () => {
    await mount();
    await clickRestart();
    await vi.waitFor(() => expect(button('Restart anyway')).toBeDefined());
    invoke.mockRejectedValueOnce('cli_operation_blocked: A CLI update started while confirming.');
    await act(async () => button('Restart anyway')!.click());
    expect(invoke).toHaveBeenCalledExactlyOnceWith('prepare_app_restart', { force: true });
    expect(button('Restart anyway')).toBeUndefined();
  });

  it.each(['reserved restart', 'unavailable installer ownership'])('requires explicit consent to force past %s', async blocker => {
    readiness = { ...parked, idle: { ...parked.idle, idleExceptParked: false,
      unavailable: blocker === 'unavailable installer ownership' ? ['cli-update-ownership'] : [],
      active: { ...parked.idle.active, restartPending: blocker === 'reserved restart' } } };
    await mount();
    await clickRestart();
    expect(button('Restart anyway')).toBeDefined();
    await act(async () => button('Restart anyway')!.click());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('prepare_app_restart', { force: true }));
  });

  it('keeps non-forced remote apply gated without a component-owned auto timer', async () => {
    await mount(false);
    expect(reads).toBe(0);
    await act(async () => { window.dispatchEvent(new CustomEvent('o8:realtime', { detail: { data: { events: [{ data: {
      mutation: { action: 'app-update-apply-requested', status: 'queued', mutationId: 'fixture-remote-apply' },
    } }] } } })); });
    expect(install).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(button('Restart anyway')).toBeUndefined();
  });
});
