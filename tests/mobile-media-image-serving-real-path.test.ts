import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Real files served through the real `/api/mobile/media` GET handler. Since #4773
// routed media through the UTF-8 text viewer, every raster image was refused with
// HTTP 415; these cases pin that valid rasters are served again while corrupt,
// disguised, script-capable, oversized, and out-of-root requests stay refused.

const root = mkdtempSync(join(tmpdir(), 'o8-media-root-'));
const outside = mkdtempSync(join(tmpdir(), 'o8-media-outside-'));
vi.stubEnv('CORTEX_IDE_MEDIA_ROOT', root);

const { GET } = await import('@/app/api/mobile/media/route');

// Minimal 1x1 images, one per supported raster type. PNG, GIF and WebP are real
// encoded files; JPEG is a hand-built SOI/SOF0/EOI header (a long real JPEG is a
// high-entropy blob the secret scanner flags), which is what the route verifies.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([
  0xff, 0xd8, // SOI
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, // SOF0: 1x1, 1 component
  0xff, 0xd9, // EOI
]);
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');

function write(name: string, bytes: Buffer): string {
  const path = join(root, name);
  writeFileSync(path, bytes);
  return path;
}

async function request(path: string): Promise<Response> {
  return GET(new NextRequest(`http://localhost/api/mobile/media?path=${encodeURIComponent(path)}`));
}

beforeAll(() => {
  write('valid.png', PNG);
  write('valid.jpg', JPEG);
  write('valid.gif', GIF);
  write('valid.webp', WEBP);
  write('corrupt.png', PNG.subarray(0, PNG.length - 16)); // Truncated past the IEND trailer.
  write('disguised.png', Buffer.from('this is plain text, not an image at all')); // Non-image renamed .png.
  write('mismatch.jpg', PNG); // A real PNG under a .jpg extension: cross-format type confusion.
  write('vector.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
  // A tiny PNG whose IHDR claims 65535x65535 (~4.3e9 px) but whose body is trivial.
  const bomb = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]), Buffer.from('IHDR'),
    Buffer.from([0xff, 0xff, 0x00, 0x00]), Buffer.from([0xff, 0xff, 0x00, 0x00]),
    Buffer.alloc(9), // Remaining IHDR payload + CRC (unverified by the sniffer).
    Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  ]);
  // Correct the IHDR width/height into the right byte positions (16..23).
  bomb.writeUInt32BE(0x0000ffff, 16);
  bomb.writeUInt32BE(0x0000ffff, 20);
  write('bomb.png', bomb);
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('/api/mobile/media verified image serving', () => {
  it('serves a persisted PNG as image/png with the original bytes and hardened headers', async () => {
    const response = await request(join(root, 'valid.png'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it.each([
    ['valid.jpg', 'image/jpeg', JPEG],
    ['valid.gif', 'image/gif', GIF],
    ['valid.webp', 'image/webp', WEBP],
  ])('serves a valid %s as %s with the original bytes', async (name, type, bytes) => {
    const response = await request(join(root, name));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe(type);
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it.each([
    ['corrupt.png', 'a truncated image'],
    ['disguised.png', 'a non-image renamed .png'],
    ['mismatch.jpg', 'a real PNG whose extension claims JPEG'],
    ['vector.svg', 'a script-capable SVG'],
    ['bomb.png', 'an image whose dimensions exceed the pixel limit'],
  ])('refuses %s (%s) with binary_preview_refused', async name => {
    const response = await request(join(root, name));
    expect(response.status).toBe(415);
    expect((await response.json()).code).toBe('binary_preview_refused');
  });

  it('refuses a real PNG that lives outside the media roots', async () => {
    writeFileSync(join(outside, 'escape.png'), PNG);
    const response = await request(join(outside, 'escape.png'));
    expect(response.status).toBe(404);
  });

  it('refuses a traversal path that escapes the media root', async () => {
    const parent = dirname(root);
    writeFileSync(join(parent, 'o8-media-traversal.png'), PNG);
    try {
      const response = await request(join(root, '..', 'o8-media-traversal.png'));
      expect(response.status).toBe(404);
    } finally {
      rmSync(join(parent, 'o8-media-traversal.png'), { force: true });
    }
  });
});
