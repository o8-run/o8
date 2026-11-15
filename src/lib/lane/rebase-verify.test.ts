import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./rebase-typecheck', () => ({ runLaneRebaseTypecheck: vi.fn() }));
vi.mock('./rebase-lint', () => ({ runLaneRebaseLint: vi.fn() }));
vi.mock('./rebase-tests', () => ({ runLaneRebaseTests: vi.fn() }));
vi.mock('@/lib/operator/defaults', () => ({ resolveMergeTestReplayEnabledSync: vi.fn() }));

import { resolveMergeTestReplayEnabledSync } from '@/lib/operator/defaults';
import { runLaneRebaseLint } from './rebase-lint';
import { runLaneRebaseTests } from './rebase-tests';
import { runLaneRebaseTypecheck } from './rebase-typecheck';
import { runLaneRebaseVerify } from './rebase-verify';

const typecheck = vi.mocked(runLaneRebaseTypecheck);
const lint = vi.mocked(runLaneRebaseLint);
const tests = vi.mocked(runLaneRebaseTests);
const setting = vi.mocked(resolveMergeTestReplayEnabledSync);

const input = { cwd: '/tmp/x', installRoot: '/tmp/repo', baseRef: 'main', actualBranch: 'branch', logPrefix: 'test' };

beforeEach(() => {
  vi.clearAllMocks();
  lint.mockResolvedValue({ ok: true });
});

describe('runLaneRebaseVerify', () => {
  it('fails with kind:typecheck and never runs tests when typecheck fails', async () => {
    typecheck.mockResolvedValue({ ok: false, output: 'TS1005' });
    const result = await runLaneRebaseVerify(input);
    expect(result).toEqual({
      ok: false,
      kind: 'typecheck',
      output: 'TS1005',
      checks: [
        { name: 'typecheck', verdict: 'fail', detail: 'TS1005' },
        { name: 'lint', verdict: 'skipped', detail: 'Not run because typecheck failed.' },
      ],
    });
    expect(lint).not.toHaveBeenCalled();
    expect(tests).not.toHaveBeenCalled();
  });

  it('is opt-in: with the setting off, tests never run even if they would fail', async () => {
    typecheck.mockResolvedValue({ ok: true });
    setting.mockReturnValue(false);
    const result = await runLaneRebaseVerify(input);
    expect(result).toEqual({
      ok: true,
      checks: [
        { name: 'typecheck', verdict: 'pass' },
        { name: 'lint', verdict: 'pass' },
      ],
    });
    expect(tests).not.toHaveBeenCalled();
  });

  it('runs the test replay when the setting is on and passes it through on success', async () => {
    typecheck.mockResolvedValue({ ok: true });
    setting.mockReturnValue(true);
    tests.mockResolvedValue({ ok: true, skipped: false });
    const result = await runLaneRebaseVerify(input);
    expect(result).toEqual({
      ok: true,
      checks: [
        { name: 'typecheck', verdict: 'pass' },
        { name: 'lint', verdict: 'pass' },
      ],
    });
    expect(tests).toHaveBeenCalledOnce();
  });

  it('fails with kind:tests when the replay fails', async () => {
    typecheck.mockResolvedValue({ ok: true });
    setting.mockReturnValue(true);
    tests.mockResolvedValue({ ok: false, output: 'boom' });
    const result = await runLaneRebaseVerify(input);
    expect(result).toEqual({
      ok: false,
      kind: 'tests',
      output: 'boom',
      checks: [
        { name: 'typecheck', verdict: 'pass' },
        { name: 'lint', verdict: 'pass' },
      ],
    });
  });

  it('defaults to off (no test run) when the settings read throws', async () => {
    typecheck.mockResolvedValue({ ok: true });
    setting.mockImplementation(() => {
      throw new Error('settings unavailable');
    });
    const result = await runLaneRebaseVerify(input);
    expect(result).toEqual({
      ok: true,
      checks: [
        { name: 'typecheck', verdict: 'pass' },
        { name: 'lint', verdict: 'pass' },
      ],
    });
    expect(tests).not.toHaveBeenCalled();
  });

  it('fails with kind:lint and keeps typecheck next to the lint blocker', async () => {
    typecheck.mockResolvedValue({ ok: true });
    lint.mockResolvedValue({ ok: false, output: 'src/bad.ts:1:unused-disable unused directive' });

    const result = await runLaneRebaseVerify(input);

    expect(result).toEqual({
      ok: false,
      kind: 'lint',
      output: 'src/bad.ts:1:unused-disable unused directive',
      checks: [
        { name: 'typecheck', verdict: 'pass' },
        {
          name: 'lint',
          verdict: 'fail',
          detail: 'src/bad.ts:1:unused-disable unused directive',
        },
      ],
    });
    expect(tests).not.toHaveBeenCalled();
  });

  it('reports lint timeout and unavailable projects as skipped checks', async () => {
    typecheck.mockResolvedValue({ ok: true, skipped: 'no tsconfig.json' });
    lint.mockResolvedValue({ ok: true, skipped: 'ESLint exceeded the 90 s timeout' });

    const result = await runLaneRebaseVerify(input);

    expect(result).toEqual({
      ok: true,
      checks: [
        { name: 'typecheck', verdict: 'skipped', detail: 'no tsconfig.json' },
        { name: 'lint', verdict: 'skipped', detail: 'ESLint exceeded the 90 s timeout' },
      ],
    });
  });
});
