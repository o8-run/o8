#!/usr/bin/env node
// Exports the desktop installer's icons (src-tauri/icons) from the Ring masters in brand/.
// Nothing is drawn here: every file is a raster of a brand SVG. Run from the repository root:
//   node brand/src/tauri_icons.mjs
// Default icon (brand v1.1): paper tile, ink Ring, soft colour edge. Alternates stay in brand/app-icon/.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const out = 'src-tauri/icons';
const render = (svg, size) => sharp(svg, { density: 72 * Math.max(1, size / 100) })
  .resize(size, size).png({ compressionLevel: 9 }).toBuffer();

// macOS tile (Apple grid, transparent margin): bundle PNGs used by macOS and Linux.
const tile = 'brand/app-icon/icon-light-edge.svg';
for (const [name, size] of [['32x32', 32], ['128x128', 128], ['128x128@2x', 256], ['icon', 512]]) {
  writeFileSync(`${out}/${name}.png`, await render(tile, size));
}

// icon.icns from the same master (macOS only: iconutil).
if (process.platform === 'darwin') {
  const iconset = path.join(mkdtempSync(path.join(tmpdir(), 'o8-icon-')), 'o8.iconset');
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    writeFileSync(path.join(iconset, `icon_${size}x${size}.png`), await render(tile, size));
    writeFileSync(path.join(iconset, `icon_${size}x${size}@2x.png`), await render(tile, size * 2));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', `${out}/icon.icns`]);
  rmSync(path.dirname(iconset), { recursive: true, force: true });
}

// Square full-bleed tile: Windows store logos and icon.ico.
const square = 'brand/app-icon/icon-light-square.svg';
for (const size of [30, 44, 71, 89, 107, 142, 150, 284, 310]) {
  writeFileSync(`${out}/Square${size}x${size}Logo.png`, await render(square, size));
}
writeFileSync(`${out}/StoreLogo.png`, await render(square, 50));

// icon.ico: PNG-compressed entries, the sizes the previous file carried.
const sizes = [32, 16, 24, 48, 64, 256];
const images = await Promise.all(sizes.map(size => render(square, size)));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, index) => {
  const at = 6 + 16 * index;
  header.writeUInt8(size === 256 ? 0 : size, at);
  header.writeUInt8(size === 256 ? 0 : size, at + 1);
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(images[index].length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += images[index].length;
});
writeFileSync(`${out}/icon.ico`, Buffer.concat([header, ...images]));

// Menu-bar template image: the one-colour Ring (orange dropped, cut kept), 22pt at 2x.
writeFileSync(`${out}/tray-template.png`, await render('brand/ring/ring-mono-ink.svg', 44));
