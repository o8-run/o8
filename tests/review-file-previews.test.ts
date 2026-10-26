import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const scope = vi.hoisted(() => ({ root: '' }));
vi.mock('@/lib/llm/repo-scope', () => ({ getDefaultLlmRepoRoot: () => scope.root, resolveRegisteredRepoScope: async (path: string) => ({ repoRoot: path === scope.root ? scope.root : null, repo: null }) }));
import { GET as diff } from '@/app/api/panel/file-diff/route';
import { GET as serveImage } from '@/app/api/panel/serve-image/route';
import { GET as asset } from '@/app/api/panel/file-asset/route';
import { GET as content } from '@/app/api/v2/files/route';
const request = (endpoint: string, path: string, extra: Record<string, string> = {}, headers?: HeadersInit) => new NextRequest(`http://localhost/api/${endpoint}?${new URLSearchParams({ path, workspace: scope.root, ...extra })}`, { headers });
beforeEach(async () => {
  scope.root = await mkdtemp(join(tmpdir(), 'o8-review-preview-'));
  execFileSync('git', ['init', '-q', scope.root]); await writeFile(join(scope.root, 'source.txt'), 'before\n');
  execFileSync('git', ['add', '.'], { cwd: scope.root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Fixture'], { cwd: scope.root });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(scope.root, { recursive: true, force: true }); });
describe('bounded review and file previews', () => {
  it('distinguishes media, nested directories, full text, and oversized diffs', async () => {
    await writeFile(join(scope.root, 'clip.mp4'), Buffer.from([0, 1, 2])); await mkdir(join(scope.root, 'nested'));
    expect(await (await diff(request('panel/file-diff', 'clip.mp4'))).json()).toMatchObject({ kind: 'video', size: 3, diff: '', diffStatus: 'binary' });
    expect(await (await diff(request('panel/file-diff', 'nested'))).json()).toMatchObject({ kind: 'directory', diffStatus: 'directory' });
    await writeFile(join(scope.root, 'source.txt'), 'after\n');
    expect(await (await diff(request('panel/file-diff', 'source.txt'))).json()).toMatchObject({ kind: 'text', diff: expect.stringContaining('+after'), diffStatus: 'ready' });
    await writeFile(join(scope.root, 'source.txt'), 'line\n'.repeat(140_000));
    expect(await (await diff(request('panel/file-diff', 'source.txt'))).json()).toMatchObject({ diff: '', diffStatus: 'too_large', size: 700_000 });
  });
  it('refuses opaque byte ranges while retaining descriptor confinement', async () => {
    await writeFile(join(scope.root, 'clip.mp4'), Buffer.from('0123456789'));
    for (const Range of ['bytes=2-5', 'bytes=-3', 'bytes=99-']) {
      const response = await asset(request('panel/file-asset', 'clip.mp4', {}, { Range }));
      expect(response.status).toBe(415); expect(response.headers.get('Content-Range')).toBeNull();
      expect(await response.json()).toMatchObject({ code: 'binary_preview_refused' });
    }
    await symlink('/etc/passwd', join(scope.root, 'escape.mp4')); expect((await asset(request('panel/file-asset', 'escape.mp4'))).status).toBe(404);
    expect((await diff(request('panel/file-diff', '../escape'))).status).toBe(403);
  });
  it('refuses opaque formats across all binary aliases without changing stored bytes', async () => {
    const bytes = Buffer.from([99, 0, 255, 128, 13, 10, 42]).subarray(1, 6);
    await writeFile(join(scope.root, 'image.png'), bytes);
    const full = await asset(request('panel/file-asset', 'image.png'));
    const image = await serveImage(new Request(`http://localhost/api/panel/serve-image?${new URLSearchParams({ path: join(scope.root, 'image.png') })}`));
    vi.stubEnv('CORTEX_IDE_MEDIA_ROOT', scope.root);
    const { GET: mobileMedia } = await import('@/app/api/mobile/media/route');
    const mobile = await mobileMedia(request('mobile/media', join(scope.root, 'image.png')));
    const range = await asset(request('panel/file-asset', 'image.png', {}, { Range: 'bytes=1-3' }));
    for (const response of [full, image, mobile, range]) {
      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({ code: 'binary_preview_refused' });
    }
    expect(await readFile(join(scope.root, 'image.png'))).toEqual(bytes);
  });
  it('preserves inspected UTF-8 SVG bytes and attests the complete body before ignoring ranges', async () => {
    const text = '<svg xmlns="http://www.w3.org/2000/svg"><text>π</text></svg>';
    await writeFile(join(scope.root, 'public.svg'), text);
    const response = await asset(request('panel/file-asset', 'public.svg', {}, { Range: 'bytes=2-5' }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(text);
    expect(response.headers.get('Content-Length')).toBe(String(Buffer.byteLength(text)));
    expect(JSON.parse(response.headers.get('X-O8-Viewer-Redaction')!)).toEqual({ version: 1, offsetEncoding: 'utf-8', spans: [] });
  });
  it('bounds a read-only file preview without truncating the normal file API or changing disk contents', async () => {
    const original = 'readable line\n'.repeat(100_000); await writeFile(join(scope.root, 'large.txt'), original);
    const preview = await (await content(request('v2/files', 'large.txt', { preview: '1' }))).json();
    expect(preview.truncated).toBe(true); expect(Buffer.byteLength(preview.content)).toBe(1024 * 1024); expect(preview.size).toBe(Buffer.byteLength(original));
    const full = await (await content(request('v2/files', 'large.txt'))).json(); expect(full.content).toBe(original); expect(full.contentHash).toBeTruthy();
    expect(await readFile(join(scope.root, 'large.txt'), 'utf8')).toBe(original);
  });
  it('keeps comparison revisions and leading-dash filenames from becoming Git options', async () => {
    const output = join(scope.root, 'unexpected-output');
    expect((await diff(request('panel/file-diff', 'source.txt', { base: `--output=${output}` }))).status).toBe(400);
    await expect(readFile(`${output}...HEAD`)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(scope.root, '--notes.txt'), 'safe filename\n');
    expect(await (await diff(request('panel/file-diff', '--notes.txt'))).json()).toMatchObject({ diff: expect.stringContaining('+safe filename'), diffStatus: 'ready' });
  });
});
