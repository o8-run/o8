import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  parseCodexAppServerCapacity,
  readLiveCodexRuntimeCapacity,
} from '@/lib/codex/live-capacity';

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-codex-capacity-'));
const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'codex-capacity-app-server.mjs');
const auditPath = path.join(tempRoot, 'audit.log');
const originalAudit = process.env.O8_CODEX_CAPACITY_AUDIT;
const originalAllow = process.env.O8_WORKER_ENV_ALLOW;
chmodSync(fixture, 0o755);

afterAll(() => {
  if (originalAudit === undefined) delete process.env.O8_CODEX_CAPACITY_AUDIT;
  else process.env.O8_CODEX_CAPACITY_AUDIT = originalAudit;
  if (originalAllow === undefined) delete process.env.O8_WORKER_ENV_ALLOW;
  else process.env.O8_WORKER_ENV_ALLOW = originalAllow;
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('Codex live capacity', () => {
  it('reads exact account limits through the real app-server process and selected home', async () => {
    process.env.O8_CODEX_CAPACITY_AUDIT = auditPath;
    // Worker children inherit only allowlisted names; the fixture reads this audit path.
    process.env.O8_WORKER_ENV_ALLOW = 'O8_CODEX_CAPACITY_AUDIT';
    const snapshot = await readLiveCodexRuntimeCapacity({
      binaryPath: fixture,
      configHome: tempRoot,
      identityId: 'identity-a',
      requestTimeoutMs: 2_000,
    });

    expect(snapshot).toMatchObject({
      runtime: 'codex',
      identityId: 'identity-a',
      status: 'available',
      source: 'app-server',
      confidence: 'exact',
      buckets: [{ id: 'primary', label: 'Weekly', usedRatio: 0.33 }],
      account: { organization: 'Example Workspace', resetsLeft: 3, credits: { amount: 120.5, currency: null } },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/private@example/);
    expect(readFileSync(auditPath, 'utf8').trim()).toBe(tempRoot);
  });

  it('leaves out account facts the app-server did not report', () => {
    const window = { usedPercent: 10, windowDurationMins: 10_080, resetsAt: 1_787_197_379 };
    expect(parseCodexAppServerCapacity({ rateLimits: { primary: window } }).account).toBeUndefined();
    expect(parseCodexAppServerCapacity({
      rateLimits: { primary: window, credits: { hasCredits: false, unlimited: false, balance: '0' } },
      rateLimitResetCredits: { availableCount: -1 },
    }, { accountRead: { account: { workspaceName: null } } }).account).toBeUndefined();
    expect(parseCodexAppServerCapacity({
      rateLimits: { primary: window, credits: { hasCredits: true, unlimited: false, balance: '1' } },
      rateLimitsByLimitId: { codex: { credits: { hasCredits: true, unlimited: false, balance: '7.25' } } },
      rateLimitResetCredits: { availableCount: 0 },
    }).account).toEqual({ resetsLeft: 0, credits: { amount: 7.25, currency: null } });
  });

  it('rejects malformed live limits so the runtime can fall back to durable local truth', () => {
    expect(() => parseCodexAppServerCapacity({ rateLimits: { primary: { usedPercent: '33' } } }))
      .toThrow('valid usage percentage');
  });
});
