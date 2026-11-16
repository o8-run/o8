import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixtures from '../../../tests/fixtures/lan-access/cases.json';
import { describe, expect, it } from 'vitest';
import { lanAccessEnabled, resolveListenHost } from './listen-host';

describe('resolveListenHost', () => {
  it('binds loopback by default', () => {
    expect(resolveListenHost({ O8_DATA_DIR: '/nonexistent/o8-lan-fixture' })).toBe('127.0.0.1');
    expect(lanAccessEnabled({ O8_DATA_DIR: '/nonexistent/o8-lan-fixture' })).toBe(false);
  });

  it.each(['', '0', 'false', 'no', 'off', 'lan', '0.0.0.0'])('stays on loopback for O8_LAN_ACCESS=%j', (value) => {
    expect(resolveListenHost({ O8_LAN_ACCESS: value })).toBe('127.0.0.1');
  });

  it.each(['1', 'true', 'TRUE', ' yes ', 'on'])('binds all interfaces for O8_LAN_ACCESS=%j', (value) => {
    expect(lanAccessEnabled({ O8_LAN_ACCESS: value })).toBe(true);
    expect(resolveListenHost({ O8_LAN_ACCESS: value })).toBe('0.0.0.0');
  });
});


describe('shared phone network fixtures', () => {
  it.each(fixtures)('$name', fixture => {
    const dir = mkdtempSync(join(tmpdir(), 'o8-lan-'));
    try {
      if (fixture.file !== null) writeFileSync(join(dir, 'phone-network'), fixture.file);
      const env = { O8_DATA_DIR: dir, ...(fixture.env !== null ? { O8_LAN_ACCESS: fixture.env } : {}) };
      expect(lanAccessEnabled(env)).toBe(fixture.enabled);
      expect(resolveListenHost(env)).toBe(fixture.enabled ? '0.0.0.0' : '127.0.0.1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('fails closed for an unreadable setting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'o8-lan-'));
    try {
      mkdirSync(join(dir, 'phone-network'));
      expect(lanAccessEnabled({ O8_DATA_DIR: dir })).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
