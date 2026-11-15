import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHONE_CODE_TOOL_NAMES, PHONE_O8_TOOL_NAMES } from '@/lib/voice/realtime-session-config';
import { PHONE_TOOL_CATALOG } from '@/lib/symon/execution/catalog';
import { PHONE_TOOL_SAFETY_CLASSES, toolSafetyClass, toolTimeoutMs } from '@/lib/symon/execution/policy';
import { symonToolTimeoutMs } from '@/lib/mobile/symon-tool-relay';
import parity from './fixtures/phone-tool-catalog/rust-parity.json';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

const phoneNames = [...new Set([...PHONE_CODE_TOOL_NAMES, ...PHONE_O8_TOOL_NAMES])].sort();

describe('server phone tool catalog and policy', () => {
  it('covers exactly both phone packs with no duplicates or extra policies', () => {
    expect(phoneNames).toHaveLength(42);
    expect(PHONE_TOOL_CATALOG).toHaveLength(42);
    expect(PHONE_TOOL_CATALOG.map(tool => tool.name).sort()).toEqual(phoneNames);
    expect(Object.keys(PHONE_TOOL_SAFETY_CLASSES).sort()).toEqual(phoneNames);
    expect(Object.keys(parity.tools).sort()).toEqual(phoneNames);
    for (const tool of PHONE_TOOL_CATALOG) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters.type).toBe('object');
      expect(['read-only', 'reversible', 'destructive']).toContain(toolSafetyClass(tool.name));
    }
  });

  it('matches the reviewed Rust schema fingerprints and safety classes', () => {
    for (const tool of PHONE_TOOL_CATALOG) {
      expect({
        schemaSha256: sha256(JSON.stringify(canonical(tool))),
        safetyClass: toolSafetyClass(tool.name),
      }, tool.name).toEqual(parity.tools[tool.name]);
    }
  });

  it('requires a fresh parity review whenever the classic Rust sources change', () => {
    // Once the classic shell is removed, the fixture remains the migration baseline.
    if (!existsSync(resolve('src-tauri'))) return;
    for (const [path, expected] of Object.entries(parity.sourceFiles)) {
      expect(sha256(readFileSync(resolve(path))), path).toBe(expected);
    }
  });

  it('defaults every unlisted name to destructive, including prototype keys and MCP', () => {
    for (const name of ['', 'unknown', 'mcp__fixture__echo', 'toString', '__proto__', 'constructor']) {
      expect(toolSafetyClass(name)).toBe('destructive');
    }
  });

  it('reuses relay timeouts for all phone tools and unknown names', () => {
    expect(toolTimeoutMs).toBe(symonToolTimeoutMs);
    for (const name of [...phoneNames, 'unknown']) {
      expect(toolTimeoutMs(name)).toBe(symonToolTimeoutMs(name));
    }
  });
});
