/**
 * Real-path guard for the parity harness web server (scripts/parity/web-server.ts).
 *
 * #4882: since #4814 ("serve the app only to loopback host names") the app's
 * loopback gate compares the request Host header's port to `request.nextUrl.port`
 * and answers 421 when they disagree. The harness launches Next behind a custom
 * `createServer`, so Next stamped its default port (3000) into `nextUrl.port`
 * while the real socket ran on a random port — every capture warmed `/dashboard`
 * and got 421. The fix hands Next the real listen port via `next({ port })` so
 * `nextUrl.port` matches the socket.
 *
 * This test pins that contract without booting (and compiling) the real app:
 * the harness must pass the loopback hostname and its real listen port to Next,
 * and advertise that same port, so the two can never drift apart again. It fails
 * on the pre-fix server, which called `next({ dev, dir })` with no port.
 */
import { afterEach, expect, it, vi } from 'vitest';

type NextOptions = { dev?: boolean; dir?: string; hostname?: string; port?: number };
const prepare = vi.fn(async () => {});
const getRequestHandler = vi.fn(() => vi.fn());
const close = vi.fn(async () => {});
const nextFactory = vi.fn((_options?: NextOptions) => ({ prepare, getRequestHandler, close }));

vi.mock('next', () => ({ default: nextFactory }));

let shutdown: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (shutdown) await shutdown();
  shutdown = undefined;
  vi.clearAllMocks();
});

it('hands Next the real loopback port it serves on, so the #4814 gate accepts capture requests', async () => {
  const { main } = await import('../../scripts/parity/web-server');
  const result = await main();
  shutdown = result.shutdown;

  // Next must be told the loopback hostname and a concrete numeric port, not left
  // to assume its default — that assumption is what produced the 421.
  expect(nextFactory).toHaveBeenCalledTimes(1);
  const options = nextFactory.mock.calls[0][0] ?? {};
  expect(options.dev).toBe(true);
  expect(options.hostname).toBe('127.0.0.1');
  expect(typeof options.port).toBe('number');

  // The port advertised to the capture harness is the same one handed to Next,
  // so the Host header and nextUrl.port can never drift apart.
  expect(result.webOrigin).toBe(`http://127.0.0.1:${options.port}`);
  expect(result.port).toBe(options.port);
});
