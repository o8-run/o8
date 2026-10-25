import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), open: vi.fn(), ensure: vi.fn() }));
vi.mock('@/lib/cloud/preview-authority', () => ({ resolveTaskPreview: mocks.resolve }));
vi.mock('@/lib/cloud/preview-server', () => ({ openPreviewServer: mocks.open, closePreviewServer: vi.fn() }));
vi.mock('@/lib/cloud/review-service-session', () => ({ ensureReviewServiceJob: mocks.ensure, stopReviewServiceJob: vi.fn() }));
const dataDir = mkdtempSync(join(tmpdir(), 'o8-native-preview-origin-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { POST } = await import('./route');
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 5, 1));
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ taskId: 'task-origin', jobId: 'job-origin', attempt: 1, service: { name: 'web' } });
  mocks.open.mockResolvedValue({ id: 'preview-origin', url: 'http://[::1]:4444/__o8_connect', expiresAt: '2026-10-02T13:00:00Z', close: vi.fn() });
});

function open(host: string | null, peer = '127.0.0.1', token = getOrCreateWsToken()) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-o8-client-addr': peer,
  };
  if (host !== null) headers.host = host;
  return POST(new NextRequest('http://0.0.0.0:4444/api/tasks/task-origin/preview', {
    method: 'POST', headers, body: JSON.stringify({ jobId: 'job-origin', attempt: 1 }),
  }), { params: Promise.resolve({ taskId: 'task-origin' }) });
}

describe('native preview origin in the bundled wildcard server', () => {
  it.each(['127.0.0.1:4444', 'localhost:4444', '[::1]:4444'])('opens through the requested loopback Host %s', async (host) => {
    expect((await open(host)).status).toBe(200);
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-origin' }), `http://${host}`);
  });

  it('refuses a non-loopback socket peer even with a loopback Host and operator token', async () => {
    expect((await open('127.0.0.1:4444', '192.0.2.1')).status).toBe(409);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it.each([null, '0.0.0.0:4444', 'example.invalid:4444', '127.0.0.1:4444/path', 'operator@127.0.0.1:4444', '127.0.0.1:4444?query=1'])('refuses missing, remote, or malformed Host %s', async (host) => {
    expect((await open(host)).status).toBe(409);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('still requires the operator credential on a local connection', async () => {
    expect((await open('127.0.0.1:4444', '127.0.0.1', '')).status).toBe(403);
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
