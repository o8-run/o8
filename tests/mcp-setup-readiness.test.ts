/**
 * Settings→MCP readiness gate. Only the bundled operator server can block
 * Connect, and only while a packaged app is still finishing first launch.
 * The codebase index binary is no longer part of setup, so a missing or
 * failed download never blocks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getMcpSetupReadiness } from '@/lib/mcp/setup-readiness';

const ENV_KEYS = ['O8_PACKAGED_APP', 'O8_BUNDLED_MCP_PATH', 'O8_CODEBASE_MEMORY_BIN'] as const;

let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'o8-readiness-'));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('getMcpSetupReadiness', () => {
  it('dev (not packaged) is always ready', () => {
    delete process.env.O8_PACKAGED_APP;
    expect(getMcpSetupReadiness()).toEqual({ ready: true, reason: null, detail: null });
  });

  it('packaged without the bundled server blocks (genuine first-launch)', () => {
    process.env.O8_PACKAGED_APP = '1';
    delete process.env.O8_BUNDLED_MCP_PATH;
    const r = getMcpSetupReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('bundled_mcp_not_ready');
  });

  it('packaged with the bundled server is ready whatever the index binary state', () => {
    const bundled = join(dir, 'operator-mcp-server.mjs');
    writeFileSync(bundled, '// bundled');
    process.env.O8_PACKAGED_APP = '1';
    process.env.O8_BUNDLED_MCP_PATH = bundled;
    process.env.O8_CODEBASE_MEMORY_BIN = '';
    expect(getMcpSetupReadiness()).toEqual({ ready: true, reason: null, detail: null });
  });
});
