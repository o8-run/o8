import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Real-path test (reachability rule): drive the ACTUAL operator-defaults route
 * with a constructed Request and assert the observable effect the three Sentry
 * layers depend on — resolveCrashReportsEnabledSync() (the exact function the
 * node beforeSend read, and the same
 * ~/.o8/operator-defaults.json file the Rust before_send re-reads) reflects the
 * persisted toggle. Testing updateOperatorDefaults() in isolation would prove
 * the writer works but not that a real POST reaches it (the evaporation class).
 */

// Isolated data dir BEFORE importing the route / defaults (both read the dir at
// call time — getOperatorDefaultsSync never memoizes).
const dir = mkdtempSync(join(os.tmpdir(), 'o8-crash-toggle-'));
process.env.CORTEX_IDE_DATA_DIR = dir;
process.env.O8_DATA_DIR = dir;

const { POST, GET } = await import('@/app/api/panel/operator-defaults/route');
const { resolveCrashReportsEnabledSync } = await import('@/lib/operator/defaults');

function postReq(body: unknown): Request {
  return new Request('http://127.0.0.1/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('crash reports toggle — real route round-trip', () => {
  it('defaults OFF, persists changes through the real POST, and the shared sync resolver sees them', async () => {
    expect(resolveCrashReportsEnabledSync()).toBe(false); // privacy-preserving default

    const res = await POST(postReq({ crashReportsEnabled: false }));
    const payload = await res.json();
    expect(res.status).toBe(200);
    expect(payload.values.crashReportsEnabled).toBe(false);
    expect(payload.sources.crashReportsEnabled).toBe('file');

    // The exact resolver every node layer + the webview config route read.
    expect(resolveCrashReportsEnabledSync()).toBe(false);

    const getRes = await GET(new Request('http://127.0.0.1/api/panel/operator-defaults'));
    const getPayload = await getRes.json();
    expect(getPayload.values.crashReportsEnabled).toBe(false);

    // Explicitly opt in — proves the toggle is reversible end-to-end.
    const res2 = await POST(postReq({ crashReportsEnabled: true }));
    const payload2 = await res2.json();
    expect(payload2.values.crashReportsEnabled).toBe(true);
    expect(resolveCrashReportsEnabledSync()).toBe(true);
  });

  it('rejects a non-boolean through the real route (400)', async () => {
    const res = await POST(postReq({ crashReportsEnabled: 'yes' }));
    expect(res.status).toBe(400);
  });
});
