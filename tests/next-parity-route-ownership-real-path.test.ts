import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';

const browser = [process.env.O8_PARITY_BROWSER, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome'].find(path => path && existsSync(path));

it.each(['normal', 'pending', 'disposed', 'unavailable'])(
  'handles each Settings request once with overlapping routes (%s)', mode => {
    expect(browser, 'Install the parity browser').toBeTruthy();
    const root = mkdtempSync(join(tmpdir(), 'o8-parity-routes-'));
    const receipt = join(root, 'receipt.json');
    try {
      const result = spawnSync(process.execPath, [resolve('tests/fixtures/next-parity-route-ownership.mjs'), mode, browser!, receipt],
        { encoding: 'utf8', timeout: 30_000 });
      const data = JSON.parse(readFileSync(receipt, 'utf8')) as {
        overlap: number; forwarded: number; blockedForwarded: number; errors: string[];
        upstream: Array<{ method: string; path: string; authorized: boolean }>;
        requests: Array<{ path: string; method: string; attempts: number; fulfilled: number; continued: number; status: number | null }>;
      };
      expect(data.requests.length, result.stderr).toBe(4);
      expect(data.overlap).toBe(4);
      expect(data.requests.map(request => request.attempts), result.stderr).toEqual([1, 1, 1, 1]);
      expect(data.requests.map(request => request.continued)).toEqual([0, 0, 0, 0]);
      expect(data.forwarded, JSON.stringify(data.upstream)).toBe(mode === 'unavailable' ? 1 : 3);
      expect(data.upstream.every(request => request.authorized), JSON.stringify(data.upstream)).toBe(true);
      expect(data.blockedForwarded).toBe(0);
      if (mode === 'disposed') {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Fetch response has been disposed');
        expect(result.stderr).not.toContain('Route is already handled');
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(data.errors).toEqual([]);
        expect(data.requests.map(request => request.fulfilled)).toEqual([1, 1, 1, 1]);
        const status = mode === 'unavailable' ? 503 : 200;
        expect(data.requests.filter(request => request.method === 'GET').map(request => request.status)).toEqual([status, status]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 40_000,
);
