import { describe, expect, it } from 'vitest';
import { lanAccessEnabled, resolveListenHost } from './listen-host';

describe('resolveListenHost', () => {
  it('binds loopback by default', () => {
    expect(resolveListenHost({})).toBe('127.0.0.1');
    expect(lanAccessEnabled({})).toBe(false);
  });

  it.each(['', '0', 'false', 'no', 'off', 'lan', '0.0.0.0'])('stays on loopback for O8_LAN_ACCESS=%j', (value) => {
    expect(resolveListenHost({ O8_LAN_ACCESS: value })).toBe('127.0.0.1');
  });

  it.each(['1', 'true', 'TRUE', ' yes ', 'on'])('binds all interfaces for O8_LAN_ACCESS=%j', (value) => {
    expect(lanAccessEnabled({ O8_LAN_ACCESS: value })).toBe(true);
    expect(resolveListenHost({ O8_LAN_ACCESS: value })).toBe('0.0.0.0');
  });
});
