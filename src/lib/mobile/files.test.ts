import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('@/lib/lane/registry', () => ({ findLaneBySession: vi.fn() }));
vi.mock('@/lib/mobile/orchestrator-thread-history', () => ({ readProjectedThread: vi.fn() }));
import { findLaneBySession } from '@/lib/lane/registry';
import { readProjectedThread } from '@/lib/mobile/orchestrator-thread-history';
import { isSecretFilePath, listMobileFiles, MOBILE_FILE_MAX_BYTES, MOBILE_FILE_MAX_ENTRIES, parseMobileFileLineRange, readMobileFile } from './files';
import { GET as listGET } from '@/app/api/mobile/files/list/route';
import { GET as contentGET } from '@/app/api/mobile/files/content/route';

let base: string;
let root: string;
beforeEach(async () => {
  vi.resetAllMocks();
  base = await mkdtemp(join(tmpdir(), 'mobile-files-'));
  root = join(base, 'checkout');
  await mkdir(root);
  execFileSync('git', ['init', '-q', root]);
  vi.mocked(readProjectedThread).mockReturnValue({ repoPath: root } as ReturnType<typeof readProjectedThread>);
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });
const file = (name: string, content: string | Buffer = 'text') => writeFile(join(root, name), content);
const request = (route: string, params: Record<string, string>) => new Request(`http://localhost/api/mobile/files/${route}?${new URLSearchParams(params)}`);

describe('mobile file listing', () => {
  it('lists one level, sorts directories first by name, supplies sizes and excludes .git', async () => {
    await Promise.all([mkdir(join(root, 'z-dir')), mkdir(join(root, 'a-dir')), file('z.txt'), file('a.txt', 'abc')]);
    await file('z-dir/nested');
    const response = await listGET(request('list', { threadId: 'thoughts-test' }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.entries.map((entry: { name: string }) => entry.name)).toEqual(['a-dir', 'z-dir', 'a.txt', 'z.txt']);
    expect(data.entries[2]).toEqual({ name: 'a.txt', path: 'a.txt', kind: 'file', size: 3 });
    expect(data.truncated).toBe(false);
    expect((await listMobileFiles(root, 'z-dir')).entries[0].path).toBe('z-dir/nested');
  });
  it('honors root and nested ignore rules, including negation, even for tracked files', async () => {
    await mkdir(join(root, 'src'));
    await file('.gitignore', '*.log\nbuild/\n!keep.log\n');
    await Promise.all([file('omit.log'), file('keep.log'), mkdir(join(root, 'build')), file('src/.gitignore', 'private.txt\n'), file('src/private.txt'), file('src/public.txt')]);
    execFileSync('git', ['add', '-f', 'omit.log'], { cwd: root });
    expect((await listMobileFiles(root)).entries.map(entry => entry.name)).toEqual(['src', '.gitignore', 'keep.log']);
    expect((await listMobileFiles(root, 'src')).entries.map(entry => entry.name)).toEqual(['.gitignore', 'public.txt']);
  });
  it('caps results and distinguishes exactly full from truncated', async () => {
    await Promise.all(Array.from({ length: MOBILE_FILE_MAX_ENTRIES }, (_, i) => file(`file-${String(i).padStart(4, '0')}`)));
    expect((await listMobileFiles(root)).truncated).toBe(false);
    await file('extra');
    const data = await listMobileFiles(root);
    expect(data.entries).toHaveLength(MOBILE_FILE_MAX_ENTRIES);
    expect(data.truncated).toBe(true);
  });
});

describe('mobile file content', () => {
  it('returns UTF-8 text, extension and language through the route', async () => {
    await file('source.ts', 'const label = "café";\n');
    const response = await contentGET(request('content', { threadId: 'thoughts-test', path: 'source.ts' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'text', binary: false, extension: 'ts', language: 'typescript', content: 'const label = "café";\n' });
  });
  it('permits the size boundary and reports too_large above it, even with a line range', async () => {
    await file('large.txt', 'a'.repeat(MOBILE_FILE_MAX_BYTES));
    expect((await readMobileFile(root, 'large.txt')).status).toBe('text');
    await file('large.txt', 'a'.repeat(MOBILE_FILE_MAX_BYTES + 1));
    expect(await readMobileFile(root, 'large.txt', { startLine: 1, endLine: 1 })).toMatchObject({ status: 'too_large', size: MOBILE_FILE_MAX_BYTES + 1, content: null });
  });
  it.each([Buffer.from([65, 0, 66]), Buffer.from([255, 254]), Buffer.from([1, 2, 3])])('returns binary metadata without bytes', async bytes => {
    await file('blob', bytes);
    expect(await readMobileFile(root, 'blob')).toMatchObject({ status: 'binary', binary: true, content: null });
  });
  it('selects inclusive 1-based lines and clamps the end', async () => {
    await file('lines.txt', 'one\r\ntwo\r\nthree');
    const response = await contentGET(request('content', { threadId: 'thoughts-test', path: 'lines.txt', startLine: '2', endLine: '9' }));
    expect(await response.json()).toMatchObject({ content: 'two\nthree', startLine: 2, endLine: 3, totalLines: 3 });
    expect((await readMobileFile(root, 'lines.txt', { endLine: 1 })).content).toBe('one');
    expect((await readMobileFile(root, 'lines.txt', { startLine: 9 })).content).toBe('');
  });
  it.each([{ startLine: '0' }, { endLine: '-1' }, { startLine: '2', endLine: '1' }, { startLine: '1.5' }, { endLine: 'NaN' }])('rejects invalid line range %j', params => {
    expect(() => parseMobileFileLineRange(new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => typeof entry[1] === 'string')))).toThrow('invalid_line_range');
  });
  it('lists secret names but hides contents, including a canonical secret directory alias', async () => {
    await file('.env.local', 'private');
    expect((await listMobileFiles(root)).entries.some(entry => entry.name === '.env.local')).toBe(true);
    expect(await readMobileFile(root, '.env.local')).toMatchObject({ status: 'hidden', content: null });
    await mkdir(join(root, '.env.secrets'));
    await file('.env.secrets/data.txt', 'private');
    await symlink(join(root, '.env.secrets'), join(root, 'alias'));
    expect(await readMobileFile(root, 'alias/data.txt')).toMatchObject({ status: 'hidden', content: null });
  });
});

describe('ignored files', () => {
  it('hides the contents of a git-ignored file asked for by path, directly or through an alias', async () => {
    await file('.gitignore', 'local-settings.json\nprivate/\n');
    await file('local-settings.json', '{"key":"value"}');
    await mkdir(join(root, 'private'));
    await file('private/notes.txt', 'private');
    await symlink(join(root, 'private'), join(root, 'shortcut'));
    await file('visible.txt', 'shown');
    expect(await readMobileFile(root, 'local-settings.json')).toMatchObject({ status: 'hidden', content: null });
    expect(await readMobileFile(root, 'private/notes.txt')).toMatchObject({ status: 'hidden', content: null });
    expect(await readMobileFile(root, 'shortcut/notes.txt')).toMatchObject({ status: 'hidden', content: null });
    expect(await readMobileFile(root, 'visible.txt')).toMatchObject({ status: 'text', content: 'shown' });
  });
});

describe('secret names', () => {
  it.each(['.env', '.env.local', 'src/.env.production', 'cert.pem', 'cert.KEY', 'id_rsa', 'id_rsa.pub', 'keys/id_ed25519_backup'])('hides %s', path => expect(isSecretFilePath(path)).toBe(true));
  it.each(['environment.ts', '.environment', 'key.ts', 'public.txt', 'id_rsx'])('allows %s', path => expect(isSecretFilePath(path)).toBe(false));
});

describe('checkout and path guards', () => {
  it('resolves session lanes using worktree before repo and falls back to repo', async () => {
    await file('note.txt');
    vi.mocked(findLaneBySession).mockReturnValue({ worktreePath: root, repoPath: base } as ReturnType<typeof findLaneBySession>);
    let response = await contentGET(request('content', { sessionKey: 'session', path: 'note.txt' }));
    expect(response.status).toBe(200);
    expect(findLaneBySession).toHaveBeenCalledWith('session');
    vi.mocked(findLaneBySession).mockReturnValue({ repoPath: root } as ReturnType<typeof findLaneBySession>);
    response = await contentGET(request('content', { sessionKey: 'session', path: 'note.txt' }));
    expect(response.status).toBe(200);
  });
  it('returns 404 for unknown threads, missing paths, and non-directory checkouts', async () => {
    for (const repoPath of [null, join(base, 'missing'), join(root, 'note')]) {
      await file('note');
      vi.mocked(readProjectedThread).mockReturnValue(repoPath === null ? null : { repoPath } as ReturnType<typeof readProjectedThread>);
      expect((await listGET(request('list', { threadId: 'thoughts-test' }))).status).toBe(404);
    }
    vi.mocked(findLaneBySession).mockReturnValue(null);
    expect((await listGET(request('list', { sessionKey: 'unknown' }))).status).toBe(404);
  });
  it('requires exactly one identifier and never takes a supplied workspace path', async () => {
    for (const params of [{ workspace: root }, { threadId: 'a', sessionKey: 'b' }, { threadId: '../a' }] as Record<string, string>[]) {
      expect((await listGET(request('list', params))).status).toBe(400);
    }
  });
  it.each(['../outside', 'src/../note', '/absolute', 'C:\\absolute', 'a\0b', '.git', '.git/config'])('rejects %j for both operations', async path => {
    expect((await listGET(request('list', { threadId: 'thoughts-test', path }))).status).toBe(400);
    expect((await contentGET(request('content', { threadId: 'thoughts-test', path }))).status).toBe(400);
  });
  it('refuses symlinks outside the checkout, including intermediate directories', async () => {
    await writeFile(join(base, 'outside.txt'), 'private');
    await symlink(base, join(root, 'escape'));
    await symlink(join(base, 'outside.txt'), join(root, 'escape.txt'));
    expect((await listGET(request('list', { threadId: 'thoughts-test', path: 'escape' }))).status).toBe(404);
    for (const path of ['escape/outside.txt', 'escape.txt']) {
      expect((await contentGET(request('content', { threadId: 'thoughts-test', path }))).status).toBe(403);
    }
    expect((await listMobileFiles(root)).entries).toEqual([]);
  });
  it('refuses aliases into git metadata', async () => {
    await symlink(join(root, '.git'), join(root, 'metadata'));
    expect((await listGET(request('list', { threadId: 'thoughts-test', path: 'metadata' }))).status).toBe(400);
    expect((await contentGET(request('content', { threadId: 'thoughts-test', path: 'metadata/config' }))).status).toBe(400);
  });
  it('returns structured errors for missing files and non-file targets', async () => {
    expect((await contentGET(request('content', { threadId: 'thoughts-test', path: 'missing' }))).status).toBe(404);
    await mkdir(join(root, 'folder'));
    expect((await contentGET(request('content', { threadId: 'thoughts-test', path: 'folder' }))).status).toBe(400);
  });
});
