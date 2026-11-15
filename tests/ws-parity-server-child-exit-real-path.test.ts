import { afterEach, expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('prints the WS child exit code and stderr when it dies after startup', async () => {
  const printed: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { printed.push(args.map(String).join(' ')); });
  const server = await startParityReference({ entry: 'tests/fixtures/ws-parity-exit-entry.mjs' });
  try {
    await vi.waitFor(() => expect(server.diagnostics().code).toBe(3), { timeout: 10_000 });
    const report = printed.find(line => line.includes('WS child exited unexpectedly'));
    expect(report, 'no exit report was printed').toBeTruthy();
    expect(report).toContain('code 3');
    expect(report).toContain('fixture listener failure: simulated crash');
  } finally {
    await server.stop();
  }
});

it('stays quiet when the test stops the child', async () => {
  const printed: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { printed.push(args.map(String).join(' ')); });
  // The child inherits this: its own exit timer cannot fire before the test stops it.
  vi.stubEnv('FIXTURE_EXIT_DELAY_MS', '60000');
  const server = await startParityReference({ entry: 'tests/fixtures/ws-parity-exit-entry.mjs' });
  await server.stop();
  expect(server.diagnostics().exitAfterStop).toBe(true);
  expect(printed.filter(line => line.includes('WS child exited unexpectedly'))).toEqual([]);
});
