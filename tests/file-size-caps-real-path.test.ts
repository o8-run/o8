import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, ftruncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The native editor opens files up to 128 MiB for editing and larger ones
// read-only (#5310). The server routes it reads through must serve that much.
vi.mock('@/lib/auth/principal', () => ({ resolveRequestPrincipal: () => 'operator' }));

const ORIGINAL_REPO_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT;
const MiB = 1024 * 1024;
let root = '';

function request(url: string, method = 'GET', body?: Record<string, unknown>) {
  return new NextRequest(url, {
    method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
}

/** About `bytes` of source text, one numbered line at a time. */
function source(bytes: number) {
  const lines: string[] = [];
  let size = 0;
  for (let n = 1; size < bytes; n++) {
    const line = `line ${n} of a large file served to the editor\n`;
    lines.push(line);
    size += line.length;
  }
  return lines.join('');
}

describe('file routes serve files up to the editor cap', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'o8-file-size-caps-'));
    process.env.CORTEX_IDE_REVIEW_REPO_ROOT = root;
    vi.resetModules();
  });
  afterEach(() => {
    if (ORIGINAL_REPO_ROOT === undefined) delete process.env.CORTEX_IDE_REVIEW_REPO_ROOT;
    else process.env.CORTEX_IDE_REVIEW_REPO_ROOT = ORIGINAL_REPO_ROOT;
    rmSync(root, { recursive: true, force: true });
    vi.doUnmock('@/lib/fs/file-size-caps');
    vi.resetModules();
  });

  it('previews a 3 MB workspace file whole', async () => {
    const content = source(3 * MiB);
    writeFileSync(join(root, 'large.ts'), content);
    const { GET } = await import('@/app/api/v2/files/route');
    const response = await GET(request('http://localhost/api/v2/files?path=large.ts&preview=1'));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.truncated).toBe(false);
    expect(body.size).toBe(content.length);
    expect(body.content).toBe(content);
  });

  it('truncates a preview above the cap and reads only the cap', async () => {
    vi.doMock('@/lib/fs/file-size-caps', () => ({ FILE_EDIT_MAX_BYTES: MiB }));
    const content = source(3 * MiB);
    writeFileSync(join(root, 'larger.ts'), content);
    const { GET } = await import('@/app/api/v2/files/route');
    const body = await (await GET(request('http://localhost/api/v2/files?path=larger.ts&preview=1'))).json();
    expect(body.truncated).toBe(true);
    expect(body.size).toBe(content.length);
    expect(body.content).toBe(content.slice(0, MiB));
  });

  it('opens and saves a 3 MB absolute file for editing', async () => {
    const path = join(root, 'absolute.ts');
    const content = source(3 * MiB);
    writeFileSync(path, content);
    const { GET, PUT } = await import('@/app/api/panel/file-io/route');
    const url = `http://localhost/api/panel/file-io?path=${encodeURIComponent(path)}`;
    const opened = await GET(request(url));
    const body = await opened.json();
    expect(opened.status).toBe(200);
    expect(body.content).toBe(content);
    const edited = `${content}edited\n`;
    const saved = await PUT(request(url, 'PUT', { path, content: edited, expectedMtimeMs: body.mtimeMs }));
    expect(saved.status).toBe(200);
    expect(readFileSync(path, 'utf8')).toBe(edited);
  });

  it('still refuses to open an absolute file above the cap for editing', async () => {
    const path = join(root, 'huge.log');
    const fd = openSync(path, 'w');
    ftruncateSync(fd, 128 * MiB + 1); // Sparse: no 128 MiB written to disk.
    closeSync(fd);
    const { GET } = await import('@/app/api/panel/file-io/route');
    const response = await GET(request(`http://localhost/api/panel/file-io?path=${encodeURIComponent(path)}`));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toContain('Too large to edit');
  });
});
