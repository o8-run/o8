import { describe, expect, it } from 'vitest';

import {
  O8_CLIENT_ADDR_HEADER,
  headersIndicateLoopback,
  isLoopbackAddress,
  isLoopbackHostname,
} from './loopback-request';
import {
  headersIndicateWebMachineRelay,
  O8_RELAY_FORWARD_HEADER,
  O8_RELAY_FORWARD_MARKER,
  O8_RELAY_SURFACE_HEADER,
  O8_WEB_MACHINE_SURFACE,
} from '@/lib/connect/web-machine-surface';

describe('isLoopbackAddress', () => {
  it('accepts IPv4 loopback', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.0.0.53')).toBe(true);
  });

  it('accepts IPv6 loopback and the IPv4-mapped form Node sockets report', () => {
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects LAN and public addresses', () => {
    expect(isLoopbackAddress('192.168.1.50')).toBe(false);
    expect(isLoopbackAddress('10.0.0.7')).toBe(false);
    expect(isLoopbackAddress('::ffff:192.168.1.50')).toBe(false);
    expect(isLoopbackAddress('8.8.8.8')).toBe(false);
  });

  it('rejects empty / garbage input', () => {
    expect(isLoopbackAddress('')).toBe(false);
    expect(isLoopbackAddress('localhost')).toBe(false);
    expect(isLoopbackAddress('not-an-ip')).toBe(false);
  });
});

describe('isLoopbackHostname', () => {
  it('accepts localhost and loopback IPs', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
  });

  it('rejects LAN hostnames and undefined', () => {
    expect(isLoopbackHostname('192.168.1.50')).toBe(false);
    expect(isLoopbackHostname('mac-studio.local')).toBe(false);
    expect(isLoopbackHostname(undefined)).toBe(false);
  });
});

describe('headersIndicateLoopback', () => {
  const headerGetter = (entries: Record<string, string>) =>
    (name: string) => entries[name.toLowerCase()] ?? null;

  it('trusts the socket-truth header when it carries a loopback address', () => {
    expect(
      headersIndicateLoopback(headerGetter({ host: 'localhost:3001', [O8_CLIENT_ADDR_HEADER]: '127.0.0.1' })),
    ).toBe(true);
  });

  it('refuses when the socket-truth header carries a LAN address — even with a loopback Host', () => {
    expect(
      headersIndicateLoopback(
        headerGetter({
          [O8_CLIENT_ADDR_HEADER]: '192.168.1.50',
          host: 'localhost:3001',
        }),
      ),
    ).toBe(false);
  });

  it('falls back to the Host header only when the socket header is absent', () => {
    expect(headersIndicateLoopback(headerGetter({ host: 'localhost:3001' }))).toBe(true);
    expect(headersIndicateLoopback(headerGetter({ host: '[::1]:3001' }))).toBe(true);
    expect(headersIndicateLoopback(headerGetter({ host: '192.168.1.50:3001' }))).toBe(false);
    expect(headersIndicateLoopback(headerGetter({}))).toBe(false);
  });
});

describe('headersIndicateWebMachineRelay', () => {
  const headerGetter = (entries: Record<string, string>) =>
    (name: string) => entries[name.toLowerCase()] ?? null;
  const relayHeaders: Record<string, string> = {
    [O8_CLIENT_ADDR_HEADER]: O8_RELAY_FORWARD_MARKER,
    [O8_RELAY_FORWARD_HEADER]: '1',
    [O8_RELAY_SURFACE_HEADER]: O8_WEB_MACHINE_SURFACE,
  };

  it('requires every server-canonicalized web-machine marker', () => {
    expect(headersIndicateWebMachineRelay(headerGetter(relayHeaders))).toBe(true);
    for (const key of Object.keys(relayHeaders)) {
      const missing = { ...relayHeaders };
      delete missing[key];
      expect(headersIndicateWebMachineRelay(headerGetter(missing))).toBe(false);
    }
  });

  it('rejects a web-machine surface marker on an ordinary loopback request', () => {
    expect(headersIndicateWebMachineRelay(headerGetter({
      [O8_CLIENT_ADDR_HEADER]: '127.0.0.1',
      [O8_RELAY_SURFACE_HEADER]: O8_WEB_MACHINE_SURFACE,
    }))).toBe(false);
  });
});
