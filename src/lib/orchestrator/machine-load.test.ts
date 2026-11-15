import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { machineLoadBlocker } from './machine-load';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('ignores high real load unless a test explicitly supplies a reader', () => {
  vi.spyOn(os, 'loadavg').mockReturnValue([999, 999, 999]);
  expect(machineLoadBlocker({ runningWorkers: 1 })).toBeNull();
});
it('uses five-minute load, available parallelism and an explicit ratio', () => {
  vi.spyOn(os, 'availableParallelism').mockReturnValue(4);
  expect(machineLoadBlocker({ runningWorkers: 1, readLoad: () => [999, 5, 999], ratio: 1.5 })).toBeNull();
  expect(machineLoadBlocker({ runningWorkers: 1, readLoad: () => [0, 7, 0], ratio: 1.5 })).toContain('Machine busy');
});
it('admits idle machines, zero threshold and explicit force', () => {
  const readLoad = () => [999, 999, 999];
  expect(machineLoadBlocker({ runningWorkers: 0, readLoad })).toBeNull();
  expect(machineLoadBlocker({ runningWorkers: 1, readLoad, ratio: 0 })).toBeNull();
  expect(machineLoadBlocker({ runningWorkers: 1, readLoad, force: true })).toBeNull();
});

it.each(['', '   ', 'junk'])('uses saved load setting when env is %j', async value => {
  const defaults = await import('@/lib/operator/defaults');
  const resolved = defaults.getOperatorDefaultsSync();
  vi.spyOn(defaults, 'getOperatorDefaultsSync').mockReturnValue({ ...resolved, values: { ...resolved.values, dispatchLoadPerCore: 2 } });
  vi.stubEnv('O8_DISPATCH_LOAD_PER_CORE', value);
  vi.spyOn(os, 'availableParallelism').mockReturnValue(4);
  expect(machineLoadBlocker({ runningWorkers: 1, readLoad: () => [0, 7, 0] })).toBeNull();
  expect(machineLoadBlocker({ runningWorkers: 1, readLoad: () => [0, 7, 0], ratio: 1 })).toContain('Machine busy');
});
