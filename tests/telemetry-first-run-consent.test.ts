import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const originalDataDir = process.env.CORTEX_IDE_DATA_DIR;
const originalO8DataDir = process.env.O8_DATA_DIR;
const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-telemetry-consent-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const { GET, POST } = await import('@/app/api/panel/operator-defaults/route');

function request(body: unknown): Request {
  return new Request('http://127.0.0.1/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = originalDataDir;
  if (originalO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = originalO8DataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe.sequential('first-run telemetry consent — real operator-defaults route', () => {
  it('starts unanswered with usage unset and crash reports off', async () => {
    const response = await GET(new Request('http://127.0.0.1/api/panel/operator-defaults'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.values).toMatchObject({
      crashReportsEnabled: false,
      productTelemetryEnabled: null,
      telemetryConsentAnswered: false,
    });
  });

  it('rejects an answered marker unless both choices are in the same request', async () => {
    const response = await POST(request({
      crashReportsEnabled: false,
      telemetryConsentAnswered: true,
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Answering telemetry consent requires both productTelemetryEnabled and crashReportsEnabled.',
    });
  });

  it('persists an explicit decline for both choices and never appears unanswered again', async () => {
    const response = await POST(request({
      crashReportsEnabled: false,
      productTelemetryEnabled: false,
      telemetryConsentAnswered: true,
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.values).toMatchObject({
      crashReportsEnabled: false,
      productTelemetryEnabled: false,
      telemetryConsentAnswered: true,
    });

    const persisted = JSON.parse(readFileSync(join(dataDir, 'operator-defaults.json'), 'utf8')) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      crashReportsEnabled: false,
      productTelemetryEnabled: false,
      telemetryConsentAnswered: true,
    });

    const followUp = await GET(new Request('http://127.0.0.1/api/panel/operator-defaults'));
    await expect(followUp.json()).resolves.toMatchObject({
      values: { telemetryConsentAnswered: true },
    });
  });
});
