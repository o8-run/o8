import { describe, expect, it, vi } from 'vitest';
import { createEdgeTtsEnsurer } from './ensure-edge-tts';

describe('Edge voice version gate (injected Python/pip runner)', () => {
  it.each(['7.3.1', '7.3.2', '8.0.0'])('keeps compatible %s without pip', async version => {
    const run = vi.fn(async () => ({ ok: true, detail: version }));
    const gate = createEdgeTtsEnsurer(run);
    await gate.ensure();
    expect(gate.status()).toBe('ready');
    expect(run).toHaveBeenCalledExactlyOnceWith(['-c', "import importlib.metadata as m; print(m.version('edge-tts'))"], 10_000);
  });

  it.each(['7.2.8', '7.3.0', '7.3.1rc1', null])('upgrades or installs %s with the minimum version', async version => {
    const run = vi.fn()
      .mockResolvedValueOnce({ ok: version !== null, detail: version ?? 'PackageNotFoundError' })
      .mockResolvedValueOnce({ ok: true, detail: '' })
      .mockResolvedValueOnce({ ok: true, detail: '7.3.1' });
    const gate = createEdgeTtsEnsurer(run);
    await gate.ensure();
    expect(run.mock.calls[1]).toEqual([['-m', 'pip', 'install', '--upgrade', '--quiet', 'edge-tts>=7.3.1'], 300_000]);
    expect(gate.status()).toBe('ready');
  });

  it('preserves the managed-Python and user retries and verifies the result', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ ok: true, detail: '7.2.8' })
      .mockResolvedValueOnce({ ok: false, detail: 'externally-managed-environment' })
      .mockResolvedValueOnce({ ok: false, detail: 'Permission denied' })
      .mockResolvedValueOnce({ ok: true, detail: '' })
      .mockResolvedValueOnce({ ok: true, detail: '7.2.8' });
    const gate = createEdgeTtsEnsurer(run);
    await gate.ensure();
    expect(run.mock.calls[2][0]).toContain('--break-system-packages');
    expect(run.mock.calls[3][0]).toEqual(expect.arrayContaining(['--user', '--break-system-packages', 'edge-tts>=7.3.1']));
    expect(gate.status()).toBe('update_required');
  });

  it('rechecks after a 403, coalesces in-flight work, and never rejects', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, detail: '7.3.1' });
    const gate = createEdgeTtsEnsurer(run);
    await Promise.all([gate.ensure(), gate.ensure()]);
    await gate.ensure();
    expect(run).toHaveBeenCalledTimes(1);
    run.mockRejectedValue(new Error('python unavailable'));
    await expect(gate.ensure('forbidden')).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
    expect(gate.status()).toBe('unavailable');
  });
});
