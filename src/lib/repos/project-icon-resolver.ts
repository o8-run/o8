/**
 * Adapted from T3 Code (https://github.com/pingdotgg/t3code),
 * apps/server/src/project/ProjectFaviconResolver.ts,
 * apps/server/src/project/T3ProjectFileLoader.ts,
 * packages/shared/src/schemaJson.ts, packages/contracts/src/t3ProjectFile.ts,
 * commit f58fad04162165653bf06f0c987bbfb0074a8a4b.
 * Copyright (c) 2026 T3 Tools Inc. MIT; see licenses/t3code-MIT.txt.
 * Adaptation: Node promises, rooted o8 file handles and bounded image reads.
 */
import 'server-only';
import { realpath, stat, type FileHandle } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { openWorkspaceFile } from '@/lib/fs/workspace-file';

export const PROJECT_ICON_MAX_BYTES = 1024 * 1024;
const CAPACITY = 512;
const POSITIVE_TTL = 10 * 60_000;
const NEGATIVE_TTL = 60_000;
const CANDIDATES = [
  'favicon.svg', 'favicon.ico', 'favicon.png',
  'public/favicon.svg', 'public/favicon.ico', 'public/favicon.png',
  'app/favicon.ico', 'app/favicon.png', 'app/icon.svg', 'app/icon.png', 'app/icon.ico',
  'src/favicon.ico', 'src/favicon.svg', 'src/app/favicon.ico', 'src/app/icon.svg', 'src/app/icon.png',
  'assets/icon.svg', 'assets/icon.png', 'assets/logo.svg', 'assets/logo.png',
  '.idea/icon.svg', 'Resources/AppIcon.icns', 'AppIcon.icns',
];
const SOURCES = [
  'index.html', 'public/index.html', 'app/routes/__root.tsx', 'src/routes/__root.tsx',
  'app/root.tsx', 'src/root.tsx', 'src/index.html',
];
const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.icns': 'image/icns',
};
const LINK_ICON_HTML_RE = /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const ICON_REL_RE = /\brel\s*:\s*["'](?:icon|shortcut icon)["']/i;
const ICON_HREF_RE = /\bhref\s*:\s*["']([^"'?]+)/i;
function extractIconHref(source: string): string | null {
  const html = source.match(LINK_ICON_HTML_RE);
  if (html?.[1]) return html[1];
  for (const run of source.split('}')) {
    if (!ICON_REL_RE.test(run)) continue;
    const match = run.match(ICON_HREF_RE);
    if (match?.[1]) return match[1];
  }
  return null;
}
function configuredIconPath(source: string): string | null {
  // Preserve quoted strings (including URLs) while accepting T3's JSONC form.
  let stripped = source.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match, literal: string | undefined) => literal ? match : ' ');
  stripped = stripped.replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g,
    (match, literal: string | undefined, bracket: string | undefined) => literal ? match : bracket ?? '');
  const config = JSON.parse(stripped) as unknown;
  if (!config || typeof config !== 'object' || !('iconPath' in config) || typeof config.iconPath !== 'string') return null;
  const iconPath = config.iconPath.trim();
  return iconPath.length > 0 && iconPath.length <= 1024 ? iconPath : null;
}
function missing(error: unknown) {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
}
function within(root: string, file: string) {
  const rel = relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
async function rootedFile(root: string, file: string) {
  let canonical: string;
  try { canonical = await realpath(resolve(root, file)); }
  catch (error) { if (missing(error)) return null; throw error; }
  if (!within(root, canonical)) return null;
  const info = await stat(canonical).catch(error => { if (missing(error)) return null; throw error; });
  return info?.isFile() ? { canonical, info } : null;
}
async function iconFile(root: string, file: string) {
  const candidate = await rootedFile(root, file);
  if (!candidate || !MIME[extname(candidate.canonical).toLowerCase()]
    || candidate.info.size > PROJECT_ICON_MAX_BYTES) return null;
  return candidate;
}
async function readBounded(handle: FileHandle): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= PROJECT_ICON_MAX_BYTES) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, PROJECT_ICON_MAX_BYTES + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (!bytesRead) return Buffer.concat(chunks, total);
    total += bytesRead; chunks.push(chunk.subarray(0, bytesRead));
  }
  throw new Error('Project icon exceeds 1 MiB.');
}
async function readRooted(root: string, file: string) {
  const candidate = await rootedFile(root, file);
  if (!candidate) return null;
  const opened = await openWorkspaceFile(root, relative(root, candidate.canonical), 'read');
  try {
    return { bytes: await opened.handle.readFile(), canonical: opened.realPath, info: opened.stat };
  } finally { await opened.handle.close(); }
}
// Start probes together, but consume in precedence order. Later failures cannot
// defeat an earlier hit; converting rejections also prevents orphan rejections.
async function firstInOrder(items: string[], probe: (item: string) => Promise<string | null>) {
  const pending = items.map(item => probe(item).then(value => ({ value }), error => ({ error })));
  for (const task of pending) {
    const result = await task;
    if ('error' in result) throw result.error;
    if (result.value) return result.value;
  }
  return null;
}
async function discover(cwd: string, faviconPath: string | null) {
  const root = await realpath(cwd);
  const find = async (file: string) => await iconFile(root, file) ? resolve(root, file) : null;
  if (faviconPath) { const found = await find(faviconPath); if (found) return found; }
  // Like T3ProjectFileLoader: missing, invalid or unreadable t3.json is optional.
  const config = await readRooted(root, 't3.json').then(value => value ? configuredIconPath(value.bytes.toString('utf8')) : null).catch(() => null);
  if (config) {
    const found = await find(config); if (found) return found;
  }
  const wellKnown = await firstInOrder(CANDIDATES, find);
  if (wellKnown) return wellKnown;
  return firstInOrder(SOURCES, async source => {
    const file = await readRooted(root, source);
    const href = file ? extractIconHref(file.bytes.toString('utf8')) : null;
    if (!href) return null;
    const clean = href.replace(/^\//, '');
    return firstInOrder([`public/${clean}`, clean], find);
  });
}

type Entry = { value: Promise<string | null>; expires: number };
export class ProjectIconResolver {
  private readonly cache = new Map<string, Entry>();
  invalidate(cwd: string) {
    for (const key of this.cache.keys()) if (key.slice(key.indexOf('\0') + 1) === cwd) this.cache.delete(key);
  }
  async resolvePath(cwd: string, faviconPath: string | null = null): Promise<string | null> {
    const key = `${faviconPath ?? ''}\0${cwd}`;
    let entry = this.cache.get(key);
    if (entry && entry.expires <= Date.now()) { this.cache.delete(key); entry = undefined; }
    if (entry) {
      this.cache.delete(key); this.cache.set(key, entry);
      try {
        const cached = await entry.value;
        if (cached === null || await iconFile(await realpath(cwd), cached)) return cached;
      } catch (error) { this.cache.delete(key); throw error; }
      this.cache.delete(key);
    }
    const fresh: Entry = { value: Promise.resolve(null), expires: Infinity };
    fresh.value = discover(cwd, faviconPath).then(value => {
      fresh.expires = Date.now() + (value === null ? NEGATIVE_TTL : POSITIVE_TTL);
      return value;
    }, error => { if (this.cache.get(key) === fresh) this.cache.delete(key); throw error; });
    this.cache.set(key, fresh);
    if (this.cache.size > CAPACITY) this.cache.delete(this.cache.keys().next().value!);
    return fresh.value;
  }
}
export const projectIconResolver = new ProjectIconResolver();

export async function validateProjectIconPath(cwd: string, file: string): Promise<boolean> {
  return Boolean(await iconFile(await realpath(cwd), file));
}
export async function projectIconResource(cwd: string, faviconPath: string | null) {
  const selected = await projectIconResolver.resolvePath(cwd, faviconPath);
  if (!selected) return null;
  const root = await realpath(cwd);
  const candidate = await iconFile(root, selected);
  return candidate ? { path: selected, version: `${candidate.info.mtimeMs}-${candidate.info.size}` } : null;
}
export async function readProjectIcon(cwd: string, faviconPath: string | null) {
  const selected = await projectIconResolver.resolvePath(cwd, faviconPath);
  if (!selected) return null;
  const root = await realpath(cwd);
  const image = await iconFile(root, selected);
  if (!image) return null;
  const opened = await openWorkspaceFile(root, relative(root, image.canonical), 'read');
  try {
    if (opened.stat.size > PROJECT_ICON_MAX_BYTES) throw new Error('Project icon exceeds 1 MiB.');
    const mime = MIME[extname(opened.realPath).toLowerCase()];
    return mime ? { bytes: await readBounded(opened.handle), mime } : null;
  } finally { await opened.handle.close(); }
}
