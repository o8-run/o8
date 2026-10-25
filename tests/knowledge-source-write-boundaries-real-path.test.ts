import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs');
  const os = process.getBuiltinModule('node:os');
  const p = process.getBuiltinModule('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(p.join(os.tmpdir(), 'o8-source-writes-')));
  const data = p.join(root, 'data'); fs.mkdirSync(data);
  process.env.O8_DATA_DIR = data; process.env.CORTEX_IDE_DATA_DIR = data;
  return { root, data, beforeMissingGh: undefined as (() => Promise<void>) | undefined, cloneOrigin: null as string | null, fallbackClones: 0 };
});
vi.mock('node:os', async original => {
  const actual = await original<typeof import('node:os') & { default: typeof import('node:os') }>();
  return { ...actual, homedir: () => f.root, default: { ...actual.default, homedir: () => f.root } };
});
vi.mock('@/lib/cortex/knowledge/reconcile', () => ({ reconcileKnowledgeSources: async () => {} }));
vi.mock('@/lib/skeleton/autoscan', () => ({ triggerScan: vi.fn(), triggerScanIfStale: vi.fn(), startChangePolling: vi.fn(), stopChangePolling: vi.fn() }));
vi.mock('@/lib/providers/child-process', async original => {
  const actual = await original<typeof import('@/lib/providers/child-process')>();
  const { promisify } = await import('node:util');
  const native = promisify(actual.execFile);
  const execFile = (...args: Parameters<typeof actual.execFile>) => Reflect.apply(actual.execFile, undefined, args);
  Object.defineProperty(execFile, promisify.custom, { value: async (file: string, args: string[], options: object) => {
    if (file === 'gh' && f.beforeMissingGh) {
      await f.beforeMissingGh();
      throw Object.assign(new Error('offline fixture has no gh'), { code: 'ENOENT' });
    }
    if (file === 'git' && args[0] === 'clone' && f.cloneOrigin) {
      f.fallbackClones += 1;
      return native(file, [args[0], args[1], f.cloneOrigin, ...args.slice(3)], options);
    }
    return native(file, args, options);
  } });
  return { ...actual, execFile };
});

const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { addRepo, updateRepo, listRepos, listReposFresh, removeRepo } = await import('@/lib/repos/registry');
const { POST: send } = await import('@/app/api/codex/send/route');
const { POST: reposPost } = await import('@/app/api/panel/repos/route');
const { POST: save, GET: read } = await import('@/app/api/v2/files/route');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { closeDb } = await import('@/lib/db');
const token = getOrCreateWsToken();
let seq = 0;
function git(folder: string, ...args: string[]) { return execFileSync('git', args, { cwd: folder, encoding: 'utf8', stdio: 'pipe' }).trim(); }
function repo() {
  const folder = path.join(f.root, `repo-${++seq}`); mkdirSync(folder);
  git(folder, 'init', '-b', 'main');
  writeFileSync(path.join(folder, 'note.md'), '# Preserved notes\n');
  git(folder, 'add', '.'); git(folder, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  return folder;
}
async function source(folder: string) {
  await updateOperatorDefaults({ knowledgeSources: [{ id: crypto.randomUUID(), name: 'Notes', path: folder, include: ['**/*.md'], exclude: [] }] });
}
function request(endpoint: string, body: unknown) {
  return new NextRequest(`http://localhost${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
}
const binary = path.join(f.root, 'offline-codex.mjs');
writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) console.log('codex 1.0.0');
else { writeFileSync('note.md', 'CLI wrote here'); console.log(JSON.stringify({type:'turn.completed'})); }
`);
chmodSync(binary, 0o700);
vi.stubEnv('O8_CODEX_BIN', binary);

beforeEach(async () => {
  f.beforeMissingGh = undefined; f.cloneOrigin = null; f.fallbackClones = 0;
  await updateOperatorDefaults({ knowledgeSources: [] });
  for (const entry of await listRepos()) await removeRepo(entry.id);
});
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(f.root, { recursive: true, force: true }); });

const spellings = ['tilde', 'padded tilde', 'relative', 'symlink', 'symlink parent traversal', 'trailing separators', 'case alias'] as const;
const entries = ['send', 'registry add', 'registry update', 'clone', 'workspace save'] as const;
it.each(spellings.flatMap(spelling => entries.map(entry => [spelling, entry] as const)))(
  'excludes a source spelled with %s through %s', async (spelling, entry) => {
    const original = repo();
    const registered = await addRepo(original);
    const vault = repo();
    await source(vault);
    let input: string = vault;
    if (spelling === 'tilde') input = `~/${path.relative(f.root, vault)}`;
    if (spelling === 'padded tilde') input = `  ~/${path.relative(f.root, vault)}  `;
    if (spelling === 'relative') input = path.relative(process.cwd(), vault);
    if (spelling === 'symlink') { input = path.join(f.root, `alias-${++seq}`); symlinkSync(vault, input, 'dir'); }
    if (spelling === 'symlink parent traversal') {
      const nested = path.join(vault, 'nested'); mkdirSync(nested);
      const alias = path.join(f.root, `alias-${++seq}`); symlinkSync(nested, alias, 'dir');
      input = `${alias}/..`;
    }
    if (spelling === 'trailing separators') input = `${vault}///`;
    if (spelling === 'case alias') {
      const alias = path.join(path.dirname(vault), path.basename(vault).toUpperCase());
      if (existsSync(alias) && statSync(alias).ino === statSync(vault).ino) input = alias;
      else {
        // On case-sensitive volumes this is a distinct, writable sibling, not an alias.
        mkdirSync(alias);
        const writable = await addRepo(alias);
        expect(writable.localPath).toBe(alias);
        await removeRepo(writable.id);
      }
    }
    let response: Response;
    if (entry === 'send') response = await send(request('/api/codex/send', { cwd: input, message: 'fixture' }));
    else if (entry === 'registry add') response = await reposPost(request('/api/panel/repos', { action: 'add', localPath: input }));
    else if (entry === 'registry update') response = await reposPost(request('/api/panel/repos', { action: 'update', id: registered.id, localPath: input }));
    else if (entry === 'clone') {
      // Clone has no caller-supplied destination. Its fixed ~/Developer root
      // reaches this same source via a linked parent, including a missing child.
      const developer = path.join(f.root, 'Developer');
      rmSync(developer, { recursive: true, force: true });
      symlinkSync(vault, developer, 'dir');
      response = await reposPost(request('/api/panel/repos', { action: 'clone', cloneUrl: original, name: 'must-not-exist' }));
      expect(existsSync(path.join(vault, 'must-not-exist'))).toBe(false);
      rmSync(developer);
    } else {
      const registryPath = path.join(f.data, 'repos.json');
      const store = JSON.parse(readFileSync(registryPath, 'utf8'));
      store.repos.find((row: { id: string }) => row.id === registered.id).localPath = vault;
      writeFileSync(registryPath, JSON.stringify(store)); await listReposFresh();
      response = await save(request('/api/v2/files', { workspace: input, path: 'note.md', content: 'must not write' }));
    }
    const body = await response.text();
    expect(response.status, body).toBe(entry === 'workspace save' ? 403 : 400);
    expect(body).toContain('read-only');
    expect(readFileSync(path.join(vault, 'note.md'), 'utf8')).toBe('# Preserved notes\n');
    if (entry === 'registry add') expect((await listReposFresh()).map(row => row.id)).toEqual([registered.id]);
    if (entry === 'registry update') expect((await listReposFresh()).find(row => row.id === registered.id)?.localPath).toBe(original);
  },
);

it.each(['root', 'descendant', 'alias', 'resume'] as const)('refuses a direct %s send before an offline CLI can modify the source', async mode => {
  const folder = repo(); await source(folder);
  let cwd = folder;
  if (mode === 'descendant') { cwd = path.join(folder, 'child'); mkdirSync(cwd); writeFileSync(path.join(cwd, 'note.md'), '# Preserved notes\n'); }
  if (mode === 'alias') { cwd = path.join(f.root, `alias-${++seq}`); symlinkSync(folder, cwd, 'dir'); }
  const response = await send(request('/api/codex/send', { cwd, message: 'fixture', ...(mode === 'resume' ? { threadId: 'fixture-thread' } : {}) }));
  const body = await response.text();
  expect(readFileSync(path.join(cwd, 'note.md'), 'utf8')).toBe('# Preserved notes\n');
  expect(response.status, body).toBe(400);
  expect(body).toContain('read-only');
});

it.each(['route', 'registry'] as const)('refuses registry repoint through the %s entry point', async entry => {
  const original = repo(); const vault = repo();
  const registered = await addRepo(original); await source(vault);
  if (entry === 'route') {
    const response = await reposPost(request('/api/panel/repos', { action: 'update', id: registered.id, localPath: vault }));
    expect(response.status, await response.clone().text()).toBe(400);
  } else await expect(updateRepo(registered.id, { localPath: vault })).rejects.toThrow('read-only');
  expect((await listReposFresh()).find(entry => entry.id === registered.id)?.localPath).toBe(original);
});

it('refuses clone before creating any destination under a protected default clone root', async () => {
  const origin = repo(); const developer = path.join(f.root, 'Developer'); mkdirSync(developer);
  await source(developer);
  const response = await reposPost(request('/api/panel/repos', { action: 'clone', cloneUrl: origin, name: 'blocked-clone' }));
  expect(existsSync(path.join(developer, 'blocked-clone'))).toBe(false);
  expect(response.status, await response.clone().text()).toBe(400);
  expect(await listReposFresh()).toEqual([]);
});

it('rechecks source exclusion after missing gh before the real offline Git fallback', async () => {
  const origin = repo(); const developer = path.join(f.root, 'Developer'); mkdirSync(developer, { recursive: true });
  f.cloneOrigin = origin;
  f.beforeMissingGh = () => source(developer);
  const response = await reposPost(request('/api/panel/repos', { action: 'clone', cloneUrl: 'https://github.com/fixture/offline.git', name: 'fallback-clone' }));
  expect(f.fallbackClones).toBe(0);
  expect(existsSync(path.join(developer, 'fallback-clone'))).toBe(false);
  expect(response.status, await response.clone().text()).toBe(400);
});

it('refuses a writable hard-link alias of a protected note while retaining read access', async () => {
  const writable = repo(); const vault = repo(); await addRepo(writable); await source(vault);
  linkSync(path.join(vault, 'note.md'), path.join(writable, 'alias.md'));
  const response = await save(request('/api/v2/files', { workspace: writable, path: 'alias.md', content: 'must not change the vault inode' }));
  expect(readFileSync(path.join(vault, 'note.md'), 'utf8')).toBe('# Preserved notes\n');
  expect(response.status, await response.clone().text()).toBe(403);
  expect((await read(new NextRequest(`http://localhost/api/v2/files?workspace=${encodeURIComponent(writable)}&path=alias.md`))).status).toBe(200);
});

it.each(['note.md', 'new.md'])('refuses workspace save of %s even when a stale registered path already targets a source', async name => {
  const original = repo(); const vault = repo(); const registered = await addRepo(original); await source(vault);
  // A legacy persisted registration is authority neither to overwrite nor to create source files.
  const registryPath = path.join(f.data, 'repos.json');
  const store = JSON.parse(readFileSync(registryPath, 'utf8'));
  store.repos.find((entry: { id: string }) => entry.id === registered.id).localPath = vault;
  writeFileSync(registryPath, JSON.stringify(store)); await listReposFresh();
  const response = await save(request('/api/v2/files', { workspace: vault, path: name, content: 'must not be written' }));
  expect(response.status, await response.clone().text()).toBe(403);
  expect(readFileSync(path.join(vault, 'note.md'), 'utf8')).toBe('# Preserved notes\n');
  expect(existsSync(path.join(vault, 'new.md'))).toBe(false);
  const readable = await read(new NextRequest(`http://localhost/api/v2/files?workspace=${encodeURIComponent(vault)}&path=note.md`));
  expect(readable.status).toBe(200);
});

it('preserves literal whitespace in configured roots when guarding a default-workspace save', async () => {
  const folder = repo(); const vault = `${folder} `; renameSync(folder, vault); await source(vault);
  const nested = path.join(vault, 'nested'); mkdirSync(nested);
  writeFileSync(path.join(nested, 'note.md'), '# Preserved notes\n');
  const previous = process.env.CORTEX_IDE_REVIEW_REPO_ROOT;
  process.env.CORTEX_IDE_REVIEW_REPO_ROOT = nested;
  try {
    const response = await save(request('/api/v2/files', { path: 'note.md', content: 'must not write' }));
    expect(readFileSync(path.join(nested, 'note.md'), 'utf8')).toBe('# Preserved notes\n');
    expect(response.status, await response.text()).toBe(403);
  } finally {
    if (previous === undefined) delete process.env.CORTEX_IDE_REVIEW_REPO_ROOT;
    else process.env.CORTEX_IDE_REVIEW_REPO_ROOT = previous;
  }
});

it('retains normal writable repository sends, updates and file saves', async () => {
  const first = repo(); const second = repo(); const vault = repo(); await source(vault);
  const registered = await addRepo(first);
  const response = await send(request('/api/codex/send', { cwd: first, message: 'fixture' }));
  expect(response.status).toBe(200); await response.text();
  expect(readFileSync(path.join(first, 'note.md'), 'utf8')).toBe('CLI wrote here');
  await updateRepo(registered.id, { localPath: second });
  expect((await save(request('/api/v2/files', { workspace: second, path: 'note.md', content: 'permitted' }))).status).toBe(200);
  expect(readFileSync(path.join(second, 'note.md'), 'utf8')).toBe('permitted');
});
