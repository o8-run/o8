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
    });
    expect(readFileSync(auditPath, 'utf8').trim()).toBe(tempRoot);
  });

  it('rejects malformed live limits so the runtime can fall back to durable local truth', () => {
    expect(() => parseCodexAppServerCapacity({ rateLimits: { primary: { usedPercent: '33' } } }))
      .toThrow('valid usage percentage');
  });
});
