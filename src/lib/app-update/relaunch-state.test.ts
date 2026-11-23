import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const publishChanged = vi.fn();
vi.mock('@/lib/realtime/publisher', () => ({ publishChanged }));

describe('update state notices', () => {
  beforeEach(() => {
    vi.resetModules();
    publishChanged.mockClear();
  });

  // The notice is sent from a lazily loaded module.
  const settled = () => new Promise(resolve => setTimeout(resolve, 0));

  it('tells windows once per visible change, not on every report', async () => {
    const state = await import('./relaunch-state');
    state.setAppUpdateState({ updatePending: true, version: '1.2.3', checkedAt: '2026-11-23T10:00:00.000Z' });
    await settled();
    expect(publishChanged).toHaveBeenCalledTimes(1);
    expect(publishChanged).toHaveBeenLastCalledWith('update');
    // The same report again: only its timestamp would differ.
    state.setAppUpdateState({ updatePending: true, version: '1.2.3', checkedAt: '2026-11-23T10:00:00.000Z' });
    await settled();
    expect(publishChanged).toHaveBeenCalledTimes(1);
    state.recordHeldUpdate({ phase: 'downloading', version: '1.2.3', error: null });
    await settled();
    expect(publishChanged).toHaveBeenCalledTimes(2);
    state.recordAppUpdateInstall({ outcome: 'failed', version: '1.2.3', error: 'disk full' });
    await settled();
    expect(publishChanged).toHaveBeenCalledTimes(3);
  });

  it('never fails an update report when the publisher is unavailable', async () => {
    vi.doMock('@/lib/realtime/publisher', () => ({}));
    const state = await import('./relaunch-state');
    expect(() => state.recordHeldUpdate({ phase: 'ready', version: '1.2.3', error: null })).not.toThrow();
    await settled();
    vi.doUnmock('@/lib/realtime/publisher');
  });
});
