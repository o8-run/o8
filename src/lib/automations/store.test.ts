import { beforeEach, expect, it, vi } from 'vitest';
import { updateAutomationRow } from './store';
import { getDb } from '@/lib/db';
import { cancelAutomationFires } from './fire-store';
vi.mock('@/lib/db', () => ({ getDb: vi.fn() }));
vi.mock('./fire-store', () => ({ cancelAutomationFires: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
it.each([true, false])('updates persisted enabled=%s and cancels only on disable', enabled => {
  const row = { id: 'auto_1', enabled };
  const set = vi.fn();
  const run = vi.fn();
  const db = {
    select: () => ({ from: () => ({ where: () => ({ get: () => row }) }) }),
    update: () => ({ set: (patch: unknown) => { set(patch); return { where: () => ({ run }) }; } }),
  };
  vi.mocked(getDb).mockReturnValue(db as never);
  expect(updateAutomationRow(row.id, { enabled })).toEqual(row);
  expect(set).toHaveBeenCalledWith({ enabled });
  expect(run).toHaveBeenCalledOnce();
  if (enabled) expect(cancelAutomationFires).not.toHaveBeenCalled();
  else expect(cancelAutomationFires).toHaveBeenCalledWith(row.id);
});
it('does not write missing rows', () => {
  const update = vi.fn();
  vi.mocked(getDb).mockReturnValue({ select: () => ({ from: () => ({ where: () => ({ get: () => undefined }) }) }), update } as never);
  expect(updateAutomationRow('missing', { enabled: false })).toBeNull();
  expect(update).not.toHaveBeenCalled();
  expect(cancelAutomationFires).not.toHaveBeenCalled();
});
it('fails closed when storage is unavailable', () => {
  vi.mocked(getDb).mockReturnValue(null);
  expect(() => updateAutomationRow('auto_1', { enabled: true })).toThrow('db unavailable');
});
