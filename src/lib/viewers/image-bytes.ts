import { viewerJson } from './response';
import type { ViewerRedaction } from './route-types';

/**
 * Serve raster image bytes only after confirming the file really is a supported
 * image. #4773 routed all media through {@link import('./bytes').viewerBytes},
 * which refuses every non-UTF-8 asset, so valid PNG/JPEG/GIF/WebP previews were
 * refused with HTTP 415. This path restores those four raster types while keeping
 * that refusal for everything else: the declared type must match the file's magic
 * bytes, the header must parse into real dimensions (catching corrupt or renamed
 * files), and both byte size and pixel count stay inside fixed bounds. SVG and any
 * other script-capable or opaque format are intentionally not served here.
 */
const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MiB on the wire.
const MAX_IMAGE_PIXELS = 100_000_000; // Bound decoded size against decompression bombs.

type Dimensions = { width: number; height: number };

function refuse(message: string): Response {
  return viewerJson({ error: message, code: 'binary_preview_refused' }, { status: 415 });
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function parsePng(bytes: Buffer): Dimensions | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  // The first chunk is always IHDR with a 13-byte payload.
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  // A complete PNG ends with the IEND chunk; a truncated file is refused.
  if (!bytes.subarray(bytes.length - 12).equals(PNG_IEND)) return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1) return null;
  return { width, height };
}

function parseGif(bytes: Buffer): Dimensions | null {
  if (bytes.length < 10) return null;
  const header = bytes.toString('ascii', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') return null;
  // A complete GIF terminates with the 0x3b trailer byte.
  if (bytes[bytes.length - 1] !== 0x3b) return null;
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  if (width < 1 || height < 1) return null;
  return { width, height };
}

function parseJpeg(bytes: Buffer): Dimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  // A complete JPEG ends with the EOI marker; a truncated file is refused.
  if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    // Skip any 0xff fill bytes preceding the marker code.
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break; // EOI, or SOS (entropy data follows).
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // Standalone markers.
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (length < 7) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width < 1 || height < 1) return null;
      return { width, height };
    }
    offset += length;
  }
  return null;
}

function parseWebp(bytes: Buffer): Dimensions | null {
  if (bytes.length < 30) return null;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
  // The RIFF size must fit inside the buffer; a short file is refused.
  if (bytes.readUInt32LE(4) + 8 > bytes.length) return null;
  const format = bytes.toString('ascii', 12, 16);
  if (format === 'VP8 ') {
    // Lossy keyframe: start code 9d 01 2a precedes 14-bit width/height.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const width = bytes.readUInt16LE(26) & 0x3fff;
    const height = bytes.readUInt16LE(28) & 0x3fff;
    if (width < 1 || height < 1) return null;
    return { width, height };
  }
  if (format === 'VP8L') {
    // Lossless: signature byte 0x2f then 14-bit (width-1) and (height-1).
    if (bytes[20] !== 0x2f) return null;
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (format === 'VP8X') {
    // Extended: 24-bit (width-1) and (height-1), little-endian.
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return { width, height };
  }
  return null;
}

export function viewerImageBytes(bytes: Buffer, mimeType: string, init?: ResponseInit): Response {
  const mime = mimeType.split(';')[0].trim().toLowerCase();
  if (!RASTER_TYPES.has(mime)) return refuse('Preview unavailable for this file type');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return refuse('Image exceeds the preview size limit');

  const dimensions =
    mime === 'image/png' ? parsePng(bytes) :
    mime === 'image/jpeg' ? parseJpeg(bytes) :
    mime === 'image/gif' ? parseGif(bytes) :
    parseWebp(bytes);
  if (!dimensions) return refuse('Preview requires a valid image');
  if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) return refuse('Image exceeds the preview size limit');

  // Confirmed raster image: serve the original bytes under the same hardened
  // headers the text viewer uses. nosniff plus a sandboxed, source-free CSP keep
  // the response inert even though the body is now opaque binary.
  const redaction: ViewerRedaction = { version: 1, offsetEncoding: 'utf-8', spans: [] };
  const headers = new Headers(init?.headers);
  for (const name of ['Content-Range', 'Accept-Ranges', 'Content-Encoding', 'Content-Disposition']) headers.delete(name);
  headers.set('Content-Type', mime);
  headers.set('Content-Length', String(bytes.length));
  headers.set('Cache-Control', 'no-store, max-age=0');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "sandbox; default-src 'none'");
  headers.set('X-O8-Viewer-Redaction', JSON.stringify(redaction));
  // A Node Buffer (and an ArrayBufferLike-backed view) is not a BodyInit in the
  // DOM lib types; copy into a plain ArrayBuffer-backed Uint8Array for the body.
  const body = new Uint8Array(bytes);
  return new Response(body, { ...init, status: 200, headers });
}
