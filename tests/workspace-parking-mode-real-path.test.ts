import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-workspace-parking-mode-'));
const originalDataDir = process.env.CORTEX_IDE_DATA_DIR;
const originalO8DataDir = process.env.O8_DATA_DIR;
const originalMode = process.env.O8_WORKSPACE_PARKING_MODE;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
delete process.env.O8_WORKSPACE_PARKING_MODE;

const { GET, POST } = await import('@/app/api/panel/operator-defaults/route');

function post(body: unknown): Request {
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
  if (originalMode === undefined) delete process.env.O8_WORKSPACE_PARKING_MODE;
  else process.env.O8_WORKSPACE_PARKING_MODE = originalMode;
  rmSync(dataDir, { recursive: true, force: true });
});

describe.sequential('workspace parking mode real Settings path', () => {
  it('defaults to on-settle parking and persists pressure mode through POST, GET, and TOML', async () => {
    expect((await (await GET(new Request('http://127.0.0.1/api/panel/operator-defaults'))).json()).values.workspaceParkingMode).toBe('settled');

    const response = await POST(post({ workspaceParkingMode: 'pressure' }));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.values.workspaceParkingMode).toBe('pressure');
    expect(payload.sources.workspaceParkingMode).toBe('file');
    expect((await (await GET(new Request('http://127.0.0.1/api/panel/operator-defaults'))).json()).values.workspaceParkingMode).toBe('pressure');
    expect(readFileSync(join(dataDir, 'settings.toml'), 'utf8'))
      .toContain('workspace_parking_mode = "pressure"');
  }, 15_000);

  it('rejects an unknown mode without changing the durable selection', async () => {
    const response = await POST(post({ workspaceParkingMode: 'automatic' }));
    expect(response.status).toBe(400);
    expect((await (await GET(new Request('http://127.0.0.1/api/panel/operator-defaults'))).json()).values.workspaceParkingMode).toBe('pressure');
  }, 15_000);
});
