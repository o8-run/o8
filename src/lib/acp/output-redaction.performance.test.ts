import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each([{ size: 512 * 1024, bound: 3_000 }, { size: 4 * 1024 * 1024, bound: 8_000 }])(
  'scans $size benign escaped bytes with literal-escape secrets within $bound ms', ({ size, bound }) => {
    // A synchronous regression must not freeze the runner indefinitely.
    const probe = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../../tests/fixtures/acp-redaction-performance.mjs', import.meta.url)), String(size)], {
      encoding: 'utf8', timeout: 12_000, maxBuffer: 16_384, env: { ...process.env, NODE_ENV: 'test' },
    });
    const error = probe.error as NodeJS.ErrnoException | undefined;
    process.stdout.write(`[acp-escape-performance] ${probe.stdout || JSON.stringify({ size, cutoffMs: 12_000, error: error?.code })}\n`);
    expect(error?.code, `matcher exceeded its 12s process cutoff for ${size} bytes`).toBeUndefined();
    expect(probe.status, probe.stderr).toBe(0);
    const receipt = JSON.parse(probe.stdout) as { size: number; unchanged: boolean; wallMs: number; cpuMs: number };
    expect(receipt.size).toBe(size);
    expect(receipt.unchanged).toBe(true);
    expect(receipt.wallMs).toBeLessThan(bound);
  }, 15_000,
);
