import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('node:net', () => ({ createConnection: h.connect }));
vi.mock('node:os', () => ({ networkInterfaces: () => ({ en0: [
  { address: '192.168.1.2', family: 'IPv4', internal: false },
  { address: '127.0.0.1', family: 'IPv4', internal: true },
] }), homedir: () => '/unused' }));
vi.mock('./api-port', () => ({ resolvePortInfo: () => ({ apiPort: 47100, wsPort: 47105 }) }));
import { runningPhoneNetwork } from './mobile-network';
it('requires both real port probes through a network interface', async () => {
  let wsReachable = false;
  h.connect.mockImplementation(({ port }) => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn() });
    queueMicrotask(() => socket.emit(port === 47100 || wsReachable ? 'connect' : 'error'));
    return socket;
  });
  expect(await runningPhoneNetwork()).toBe(false);
  wsReachable = true;
  expect(await runningPhoneNetwork()).toBe(true);
  expect(h.connect.mock.calls.map(([options]) => options)).toEqual([
    { host: '192.168.1.2', port: 47100 }, { host: '192.168.1.2', port: 47105 },
    { host: '192.168.1.2', port: 47100 }, { host: '192.168.1.2', port: 47105 },
  ]);
});
