import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Real files served through the real panel preview routes. #4773 routed every
// image through the UTF-8 text viewer, so panel raster previews (serve-image,
// file-preview, file-asset) were refused with HTTP 415. These cases pin that
// valid PNGs are served again while a non-image renamed .png stays refused and
// the SVG text path is unchanged.

// file-preview and file-asset read from the registered repo root; serve-image
// confines to HOME/tmp, so its fixture lives under HOME to pass on macOS and CI.
const repoRoot = mkdtempSync(join(tmpdir(), 'o8-panel-repo-'));
const homeRoot = mkdtempSync(join(homedir(), '.o8-panel-serve-'));

vi.mock('@/lib/llm/repo-scope', () => ({
  getDefaultLlmRepoRoot: () => repoRoot,
  resolveRegisteredRepoScope: async (path: string) => ({ repoRoot: path === repoRoot ? repoRoot : null, repo: null }),
}));

const { GET: serveImage } = await import('@/app/api/panel/serve-image/route');
const { GET: filePreview } = await import('@/app/api/panel/file-preview/route');
const { GET: fileAsset } = await import('@/app/api/panel/file-asset/route');

// A real 1x1 PNG; the routes verify its signature, header and trailer.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
const NOT_AN_IMAGE = Buffer.from('this is plain text, not an image at all');

function writeBoth(name: string, bytes: Buffer): void {
  writeFileSync(join(repoRoot, name), bytes);
  writeFileSync(join(homeRoot, name), bytes);
}

beforeAll(() => {
  writeBoth('valid.png', PNG);
  writeBoth('disguised.png', NOT_AN_IMAGE);
  writeBoth('vector.svg', SVG);
});

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(homeRoot, { recursive: true, force: true });
});

function repoRequest(endpoint: string, name: string): NextRequest {
  return new NextRequest(`http://localhost/api/${endpoint}?${new URLSearchParams({ path: name, workspace: repoRoot })}`);
}
function serveRequest(name: string): Request {
  return new Request(`http://localhost/api/panel/serve-image?${new URLSearchParams({ path: join(homeRoot, name) })}`);
}

describe('panel routes serve verified raster images', () => {
  it('serve-image returns a persisted PNG as image/png with hardened headers', async () => {
    const response = await serveImage(serveRequest('valid.png'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('file-asset returns a persisted PNG as image/png with the original bytes', async () => {
    const response = await fileAsset(repoRequest('panel/file-asset', 'valid.png'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('file-preview returns a persisted PNG as image/png with the original bytes', async () => {
    const response = await filePreview(repoRequest('panel/file-preview', 'valid.png'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('refuses a non-image renamed .png through every raster route', async () => {
    const responses = [
      await serveImage(serveRequest('disguised.png')),
      await fileAsset(repoRequest('panel/file-asset', 'disguised.png')),
      await filePreview(repoRequest('panel/file-preview', 'disguised.png')),
    ];
    for (const response of responses) {
      expect(response.status).toBe(415);
      expect((await response.json()).code).toBe('binary_preview_refused');
    }
  });

  it('keeps the SVG text path unchanged (not routed through the raster verifier)', async () => {
    // serve-image serves SVG as inspected UTF-8 text; file-preview returns it as JSON.
    const served = await serveImage(serveRequest('vector.svg'));
    expect(served.status).toBe(200);
    expect(served.headers.get('Content-Type')).toContain('image/svg+xml');
    const previewed = await filePreview(repoRequest('panel/file-preview', 'vector.svg'));
    expect(previewed.status).toBe(200);
    expect((await previewed.json()).type).toBe('svg');
  });
});
