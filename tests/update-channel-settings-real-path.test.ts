// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const edge = vi.hoisted(() => ({
  preference: { channel: 'beta', outcome: 'applied', revision: 1 },
  failSave: false,
  checks: 0,
  nextOutcome: 'after-install',
  holdNextRead: false,
  releaseRead: null as null | (() => void),
  writes: [] as string[],
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async (command: string, args?: { channel: string }) => {
  if (command === 'read_update_channel') return edge.preference.channel;
  if (command === 'read_update_channel_status') {
    const value = { ...edge.preference };
    if (edge.holdNextRead) {
      edge.holdNextRead = false;
      return new Promise(resolve => { edge.releaseRead = () => resolve(value); });
    }
    return value;
  }
  if (command === 'set_update_channel') {
    edge.writes.push(args!.channel);
    if (edge.failSave) throw new Error('Fixture preference save failed');
    edge.preference = { channel: args!.channel, outcome: edge.nextOutcome, revision: edge.preference.revision + 1 };
    return { ...edge.preference };
  }
  throw new Error(`Unexpected fixture command: ${command}`);
} }));
vi.mock('@/lib/app-update/check', () => ({ check: async () => { edge.checks++; throw new Error('Fixture check failed'); } }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  edge.preference = { channel: 'beta', outcome: 'applied', revision: 1 };
  edge.failSave = false; edge.checks = 0; edge.nextOutcome = 'after-install';
  edge.holdNextRead = false; edge.releaseRead?.(); edge.releaseRead = null;
  edge.writes = [];
});

async function mount() {
  const { UpdateChannelSection } = await import('@/components/desktop/settings/UpdateChannelSection');
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(UpdateChannelSection)));
  const select = host.querySelector('select')!;
  await vi.waitFor(() => expect(select.disabled).toBe(false));
  return { host, select, dispose: async () => { await act(async () => root.unmount()); host.remove(); } };
}
async function save(select: HTMLSelectElement, channel: string) {
  await act(async () => { select.value = channel; select.dispatchEvent(new Event('change', { bubbles: true })); });
}

it.each(['stable', 'beta'])('shows an unenrolled Preview build and preserves an explicit %s selection after reopening', async channel => {
  edge.preference = { channel: 'preview', outcome: 'applied', revision: 0 };
  edge.nextOutcome = 'applied';
  const view = await mount();
  try {
    expect(view.host.textContent).toContain('Preview build');
    expect(view.host.textContent).not.toContain('Beta is now active');
    expect(view.select.value).toBe('preview');
    expect(view.select.selectedOptions[0].textContent).toBe('Preview');
    expect([...view.select.options].map(option => option.value)).toEqual(['preview', 'stable', 'beta']);
    expect(edge.writes).toEqual([]);
    expect(edge.checks).toBe(0);
    await save(view.select, channel);
    expect(edge.writes).toEqual([channel]);
    expect(view.select.value).toBe(channel);
    expect(view.host.textContent).toContain(`${channel === 'stable' ? 'Stable' : 'Beta'} is now active.`);
  } finally { await view.dispose(); }
  const reopened = await mount();
  try {
    expect(reopened.select.value).toBe(channel);
    expect([...reopened.select.options].map(option => option.value)).toEqual(['stable', 'beta']);
    expect(reopened.host.textContent).not.toContain('Preview build');
    expect(edge.writes).toEqual([channel]);
  } finally { await reopened.dispose(); }
});

it('settings says Stable is saved for after this installation and confirms when it applies', async () => {
  const view = await mount();
  try {
    await save(view.select, 'stable');
    expect(view.select.value).toBe('stable');
    expect(view.host.textContent).toContain('Stable saved. It will take effect when this installation finishes.');
    expect(edge.checks, 'a held choice must not start a check in the old channel').toBe(0);
    edge.preference = { channel: 'stable', outcome: 'applied', revision: 3 };
    await vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
      expect(view.host.textContent).toContain('Stable is now active.');
    }, { timeout: 2500 });
    expect(edge.checks).toBe(1);
  } finally { await view.dispose(); }
});

it('settings reports a rejected channel save instead of calling it an update check failure', async () => {
  edge.failSave = true;
  const view = await mount();
  try {
    await save(view.select, 'stable');
    expect(view.select.value).toBe('beta');
    expect(view.host.textContent).toContain('The update channel could not be saved. Try again.');
    expect(view.host.textContent).not.toContain('update check could not finish');
  } finally { await view.dispose(); }
});

it('settings restores the durable held choice when reopened during installation', async () => {
  edge.preference = { channel: 'stable', outcome: 'after-install', revision: 2 };
  const view = await mount();
  try {
    expect(view.select.value).toBe('stable');
    expect(view.host.textContent).toContain('It will take effect when this installation finishes.');
  } finally { await view.dispose(); }
});

it('settings distinguishes a held preference storage retry from an installation or check failure', async () => {
  edge.preference = { channel: 'stable', outcome: 'waiting-for-save', revision: 2 };
  const view = await mount();
  try {
    expect(view.select.value).toBe('stable');
    expect(view.host.textContent).toContain('Stable saved. Applying the channel change will retry automatically.');
    expect(view.host.textContent).not.toContain('installation finishes');
  } finally { await view.dispose(); }
});

it('settings confirms a successful immediate save even if its background check fails', async () => {
  edge.nextOutcome = 'applied';
  const view = await mount();
  try {
    await save(view.select, 'stable');
    await vi.waitFor(() => expect(edge.checks).toBe(1));
    expect(view.host.textContent).toContain('Stable is now active.');
    expect(view.host.textContent).not.toContain('could not be saved');
  } finally { await view.dispose(); }
});

it('an older held-preference poll cannot replace a newer saved selection', async () => {
  edge.preference = { channel: 'stable', outcome: 'after-install', revision: 2 };
  const view = await mount();
  try {
    edge.holdNextRead = true;
    await vi.waitFor(() => expect(edge.releaseRead).not.toBeNull(), { timeout: 2500 });
    await save(view.select, 'beta');
    await act(async () => { edge.releaseRead!(); });
    expect(view.select.value).toBe('beta');
    expect(view.host.textContent).toContain('Beta saved. It will take effect when this installation finishes.');
  } finally { await view.dispose(); }
});
