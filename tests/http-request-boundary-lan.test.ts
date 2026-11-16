import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { isAllowedLocalHost, isShellHost } from '../scripts/lib/http-request-boundary.cjs';

const on = { O8_LAN_ACCESS: '1' };
const off = { O8_DATA_DIR: '/nonexistent/o8-lan-fixture' };

it('refuses a network address as Host while local network access is off', () => {
  expect(isAllowedLocalHost('192.168.1.20:47100', 47100, off)).toBe(false);
  expect(isAllowedLocalHost('127.0.0.1:47100', 47100, off)).toBe(true);
});

it('accepts this machine by IPv4 address on the listening port when local network access is on', () => {
  expect(isAllowedLocalHost('192.168.1.20:47100', 47100, on)).toBe(true);
  expect(isAllowedLocalHost('100.64.0.7:47100', 47100, on)).toBe(true);
  expect(isAllowedLocalHost('127.0.0.1:47100', 47100, on)).toBe(true);
});

it.each([
  'untrusted.invalid:47100', '192.168.1.20.untrusted.invalid:47100', '192.168.1.20:47101', '192.168.1.20',
  '192.168.1.256:47100', '192.168.01.20:47100', '3232235796:47100', '0x7f.0.0.1:47100', '[fe80::1]:47100',
  '192.168.1.20:47100@untrusted.invalid', ' 192.168.1.20:47100',
])('still refuses %s when local network access is on', host => {
  expect(isAllowedLocalHost(host, 47100, on)).toBe(false);
});

it('never treats a network address as a host that can carry loopback trust', () => {
  process.env.O8_LAN_ACCESS = '1';
  try { expect(isShellHost('192.168.1.20:47100', 47100)).toBe(false); } finally { delete process.env.O8_LAN_ACCESS; }
  expect(isShellHost('localhost:47100', 47100)).toBe(true);
});

it('uses the saved choice without granting loopback host trust', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o8-lan-boundary-'));
  try {
    writeFileSync(join(dir, 'phone-network'), 'on\n');
    expect(isAllowedLocalHost('192.168.1.20:47100', 47100, { O8_DATA_DIR: dir })).toBe(true);
    expect(isShellHost('192.168.1.20:47100', 47100)).toBe(false);
    writeFileSync(join(dir, 'phone-network'), 'off\n');
    expect(isAllowedLocalHost('192.168.1.20:47100', 47100, { O8_DATA_DIR: dir })).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
