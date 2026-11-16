import { mkdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { createConnection } from 'node:net';
import { dataDir, savedLanAccess } from '../../../scripts/lib/lan-access.cjs';
import { resolvePortInfo } from './api-port';

export { savedLanAccess };

export function savePhoneNetwork(enabled: boolean): void {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, 'phone-network');
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, enabled ? 'on\n' : 'off\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(250, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Probe both real listeners through this machine's network interface, not loopback. */
export async function runningPhoneNetwork(): Promise<boolean> {
  const { apiPort, wsPort } = resolvePortInfo();
  const hosts = Object.values(networkInterfaces()).flatMap(list => list ?? [])
    .filter(address => address.family === 'IPv4' && !address.internal)
    .map(address => address.address);
  const states = await Promise.all(hosts.map(async host => {
    const results = await Promise.all([reachable(host, apiPort), reachable(host, wsPort)]);
    return results.every(Boolean);
  }));
  return states.some(Boolean);
}
