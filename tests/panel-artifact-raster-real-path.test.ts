import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it } from 'vitest';

// Real `/api/panel/threads/artifact` GET handler driven against a persisted
// artifact record and its on-disk bytes. #4773 routed every artifact through the
// UTF-8 text viewer, so screenshot (raster) artifacts were refused with HTTP 415;
// this pins that a persisted screenshot PNG is served again while a record whose
// bytes are not a real image stays refused. The data dir is set before the route
// and store import so getDb()/getDataDir() resolve to the fixture.
const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-panel-artifact-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { GET } = await import('@/app/api/panel/threads/artifact/route');
const { recordArtifact, newArtifactId, artifactRelPath, ensureArtifactBucket, artifactAbsPath } =
  await import('@/lib/artifacts/store');

// A real 1x1 PNG; the route verifies its signature, header and trailer.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const NOT_AN_IMAGE = Buffer.from('this is plain text, not an image at all');

function persistScreenshot(bytes: Buffer): string {
  const id = newArtifactId();
  const relPath = artifactRelPath(null, id, 'png');
  ensureArtifactBucket(null);
  writeFileSync(artifactAbsPath(relPath), bytes);
  recordArtifact({ id, kind: 'screenshot', source: 'manual', relPath, mimeType: 'image/png' });
  return id;
}

// Loopback Host passes requirePanelAuth; no projectId means the scope check admits it.
function request(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/panel/threads/artifact?id=${encodeURIComponent(id)}`, {
    headers: { host: 'localhost' },
  });
}

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe('/api/panel/threads/artifact serves verified screenshot rasters', () => {
  it('serves a persisted screenshot PNG as image/png with hardened headers', async () => {
    const response = await GET(request(persistScreenshot(PNG)));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('refuses a screenshot record whose stored bytes are not a real image', async () => {
    const response = await GET(request(persistScreenshot(NOT_AN_IMAGE)));
    expect(response.status).toBe(415);
    expect((await response.json()).code).toBe('binary_preview_refused');
  });
});
