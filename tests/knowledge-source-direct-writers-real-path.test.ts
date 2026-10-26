import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs'); const p = process.getBuiltinModule('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(p.join(process.getBuiltinModule('node:os').tmpdir(), 'o8-source-writers-')));
  process.env.O8_DATA_DIR = p.join(root, 'data'); process.env.CORTEX_IDE_DATA_DIR = process.env.O8_DATA_DIR;
  return { root, launched: vi.fn(), claude: vi.fn(), spawned: vi.fn(), failGitProbe: false, gitCalls: 0 };
});
vi.mock('@/lib/skeleton/autoscan', () => ({ triggerScan: vi.fn() }));
vi.mock('@/lib/cortex/knowledge/reconcile', () => ({ reconcileKnowledgeSources: async () => {} }));
vi.mock('@/lib/runtime/actions', async original => ({ ...await original<typeof import('@/lib/runtime/actions')>(),
  launchRuntimeSurface: async (input: { cwd: string }) => {
    f.launched(input); writeFileSync(path.join(input.cwd, 'note.md'), 'runtime wrote');
    throw new Error('fixture runtime stopped after its write');
  },
}));
vi.mock('@/lib/claude-code/interactive-session', () => ({
  ensureSession: (_key: string, cwd: string) => { f.claude(cwd); writeFileSync(path.join(cwd, 'note.md'), 'Claude wrote'); return { sessionId: 'fixture', cwd }; },
  sendMessage: async () => {},
}));
vi.mock('@/lib/providers/child-process', async original => ({ ...await original<typeof import('@/lib/providers/child-process')>(),
  execFileSync: (...args: Parameters<typeof execFileSync>) => {
    if (args[0] === 'git') f.gitCalls += 1;
    if (f.failGitProbe && args[0] === 'git' && Array.isArray(args[1]) && args[1].includes('--git-common-dir')) throw Object.assign(new Error('fixture Git became unavailable'), { code: 'ENOENT' });
    return execFileSync(...args);
  },
  spawn: (_command: string, _args: string[], options: { cwd?: string }) => {
    if (!options.cwd?.startsWith(f.root + path.sep)) throw new Error('Unexpected fixture spawn target');
    f.spawned(options.cwd); writeFileSync(path.join(options.cwd, 'note.md'), 'child wrote');
    return Object.assign(new EventEmitter(), { pid: 0, killed: false, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end() {} }, unref() {} });
  },
}));
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { closeDb } = await import('@/lib/db');
const { addRepo, listRepos, removeRepo } = await import('@/lib/repos/registry');
const spec = await import('@/app/api/repo-spec/route');
const asset = await import('@/app/api/repo-spec/asset/route');
const editor = await import('@/app/api/panel/file-io/route');
const commit = await import('@/app/api/review/commit/route');
const branches = await import('@/app/api/panel/branches/route');
const checkout = await import('@/app/api/panel/branches/checkout/route');
const dev = await import('@/app/api/panel/dev-server/route');
const runtime = await import('@/app/api/runtime/launch/route');
const claude = await import('@/app/api/claude-code/send/route');
const token = getOrCreateWsToken();
const require = createRequire(import.meta.url);
const sourceRoot = process.cwd();
let sequence = 0;
function git(cwd: string, ...args: string[]) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim(); }
function repo() {
  const root = path.join(f.root, `repo-${++sequence}`); mkdirSync(root);
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(path.join(root, 'note.md'), 'retained'); writeFileSync(path.join(root, 'o8.md'), '# Retained\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'fixture'); git(root, 'branch', 'other');
  return root;
}
function req(url: string, body: unknown, method = 'POST') {
  return new NextRequest(`http://localhost${url}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
async function protect(root: string) {
  await updateOperatorDefaults({ knowledgeSources: [{ id: crypto.randomUUID(), name: 'Notes', path: root, include: ['**/*.md'], exclude: [] }] });
}
beforeEach(async () => {
  await updateOperatorDefaults({ knowledgeSources: [] });
  for (const entry of await listRepos()) await removeRepo(entry.id);
  f.launched.mockClear(); f.claude.mockClear(); f.spawned.mockClear();
  f.failGitProbe = false;
});
afterAll(() => { closeDb(); rmSync(f.root, { recursive: true, force: true }); });

it.each(['spec', 'annotation', 'asset', 'editor', 'commit', 'create branch', 'delete branch', 'checkout', 'dev server', 'Claude'] as const)(
  'refuses the direct %s writer while leaving source files and Git identity untouched', async writer => {
    const vault = repo(); await protect(vault); const before = git(vault, 'rev-parse', 'HEAD');
    const specUrl = `/api/repo-spec?repoPath=${encodeURIComponent(vault)}`;
    let response: Response;
    if (writer === 'spec') response = await spec.PUT(req(specUrl, { content: 'must not replace' }, 'PUT'));
    else if (writer === 'annotation') response = await spec.POST(req(`${specUrl}&action=comment`, { body: 'must not append' }));
    else if (writer === 'asset') response = await asset.POST(new NextRequest(`http://localhost/api/repo-spec/asset?repoPath=${encodeURIComponent(vault)}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' }, body: new Uint8Array([1, 2, 3]) }));
    else if (writer === 'editor') response = await editor.PUT(req('/api/panel/file-io', { path: path.join(vault, 'note.md'), content: 'must not edit' }, 'PUT'));
    else if (writer === 'commit') { writeFileSync(path.join(vault, 'new.md'), 'uncommitted'); response = await commit.POST(req('/api/review/commit', { workspace: vault, message: 'must not commit' })); }
    else if (writer === 'create branch') response = await branches.POST(req('/api/panel/branches', { path: vault, branch: 'new-branch' }));
    else if (writer === 'delete branch') response = await branches.DELETE(req('/api/panel/branches', { path: vault, branch: 'other', force: true }, 'DELETE'));
    else if (writer === 'checkout') response = await checkout.POST(req('/api/panel/branches/checkout', { repoPath: vault, branch: 'other' }));
    else if (writer === 'dev server') response = await dev.POST(req('/api/panel/dev-server', { repoPath: vault, command: 'fixture-not-executed' }));
    else response = await claude.POST(req('/api/claude-code/send', { cwd: vault, tabId: `fixture-${sequence}`, message: 'fixture' }));
    const body = await response.text();
    expect(readFileSync(path.join(vault, 'note.md'), 'utf8')).toBe('retained');
    expect(readFileSync(path.join(vault, 'o8.md'), 'utf8')).toBe('# Retained\n');
    expect(existsSync(path.join(vault, 'o8-assets'))).toBe(false);
    expect(git(vault, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(vault, 'branch', '--show-current')).toBe('main');
    expect(git(vault, 'branch', '--list', 'other')).toContain('other');
    expect(git(vault, 'branch', '--list', 'new-branch')).toBe('');
    expect(response.status, body).toBe(403); expect(body).toContain('read-only');
    expect(f.spawned).not.toHaveBeenCalled(); expect(f.claude).not.toHaveBeenCalled();
  },
);

it('refuses raw literal source paths before runtime launch normalization or idempotency binds a different checkout', async () => {
  const sibling = repo(); const original = repo(); const vault = `${sibling} `; renameSync(original, vault); await protect(vault);
  const response = await runtime.POST(req('/api/runtime/launch', { runtime: 'codex', cwd: vault, repoPath: vault, prompt: 'fixture', isolate: false, clientMutationId: crypto.randomUUID() }));
  expect(readFileSync(path.join(sibling, 'note.md'), 'utf8')).toBe('retained');
  expect(response.status, await response.text()).toBe(403);
  expect(f.launched).not.toHaveBeenCalled();
});

it('refuses a branch worktree destination inside a source even when its Git parent is writable', async () => {
  const writable = repo(); const destination = path.join(f.root, '.worktrees', 'protected-slot'); mkdirSync(destination, { recursive: true }); await protect(destination);
  const response = await branches.POST(req('/api/panel/branches', { path: writable, branch: 'protected-slot', worktree: true }));
  expect(existsSync(path.join(destination, '.git'))).toBe(false);
  expect(git(writable, 'branch', '--list', 'protected-slot')).toBe('');
  expect(response.status, await response.text()).toBe(403);
});

it.each(['registration', 'branch mutation', 'source admission'] as const)('guards shared Git storage during linked-worktree %s', async action => {
  const vault = repo(); const linked = path.join(f.root, `linked-${++sequence}`);
  git(vault, 'worktree', 'add', linked, 'other');
  if (action === 'source admission') {
    await addRepo(linked);
    await expect(protect(vault)).rejects.toThrow('separate');
  } else {
    await protect(vault);
    if (action === 'registration') await expect(addRepo(linked)).rejects.toThrow('read-only');
    else {
      const response = await branches.POST(req('/api/panel/branches', { path: linked, branch: 'unreviewed' }));
      expect(git(vault, 'branch', '--list', 'unreviewed')).toBe('');
      expect(response.status, await response.text()).toBe(403);
    }
  }
});

it('guards a separate Git directory inside a source from a writable external checkout', async () => {
  const vault = path.join(f.root, `metadata-${++sequence}`); mkdirSync(vault);
  const writable = path.join(f.root, `external-${sequence}`); mkdirSync(writable);
  git(writable, 'init', '-b', 'main', `--separate-git-dir=${path.join(vault, 'admin')}`);
  writeFileSync(path.join(writable, 'note.md'), 'retained');
  git(writable, 'add', '.'); git(writable, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  await protect(vault);
  const response = await branches.POST(req('/api/panel/branches', { path: writable, branch: 'unreviewed' }));
  expect(git(writable, 'branch', '--list', 'unreviewed')).toBe('');
  expect(response.status, await response.text()).toBe(403);
});

it('refuses a linked-worktree mutation when its Git storage probe becomes unavailable', async () => {
  const vault = repo(); const linked = path.join(f.root, `unverified-${++sequence}`); git(vault, 'worktree', 'add', linked, 'other');
  await protect(vault); f.failGitProbe = true;
  const response = await branches.POST(req('/api/panel/branches', { path: linked, branch: 'unreviewed' }));
  expect(git(vault, 'branch', '--list', 'unreviewed')).toBe('');
  expect(response.status, await response.text()).toBe(403);
});

it('guards default-cwd discard through a fresh server process running inside the source', async () => {
  const vault = repo(); await protect(vault); writeFileSync(path.join(vault, 'note.md'), 'uncommitted retained');
  const script = `const ns = await import(${JSON.stringify(pathToFileURL(path.join(sourceRoot, 'src/app/api/review/discard/route.ts')).href)});
    const response = await (ns.POST ?? ns.default.POST)(new Request('http://localhost/api/review/discard', {method:'POST',body:JSON.stringify({path:'note.md'})}));
    console.log('O8_DISCARD_RESULT '+JSON.stringify({status:response.status,body:await response.text()}));`;
  const output = execFileSync(process.execPath, ['--import', path.join(sourceRoot, 'scripts/register-server-only-stub.mjs'), '--import', require.resolve('tsx'), '--input-type=module', '-e', script], {
    cwd: vault, env: { ...process.env, TSX_TSCONFIG_PATH: path.join(sourceRoot, 'tsconfig.json') }, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = JSON.parse(/^O8_DISCARD_RESULT (.+)$/m.exec(output)![1]);
  expect(readFileSync(path.join(vault, 'note.md'), 'utf8')).toBe('uncommitted retained');
  expect(result.status, result.body).toBe(403);
});

it.each(['gitfile', 'relative core.worktree', 'GIT_DIR', 'GIT_WORK_TREE', 'both environment roots'] as const)(
  'refuses checkout redirected into protected notes by %s without changing any bytes', async mode => {
    const writable = repo();
    git(writable, 'checkout', 'other'); writeFileSync(path.join(writable, 'note.md'), 'replacement from other branch');
    git(writable, 'add', '.'); git(writable, 'commit', '-m', 'other branch'); git(writable, 'checkout', 'main');
    const vault = path.join(f.root, `worktree-notes-${++sequence}`); mkdirSync(vault);
    writeFileSync(path.join(vault, 'note.md'), 'retained'); writeFileSync(path.join(vault, 'o8.md'), '# Retained\n');
    await protect(vault);
    const alias = path.join(f.root, `git-alias-${sequence}`); mkdirSync(alias);
    const admin = path.join(writable, '.git');
    const oldGitDir = process.env.GIT_DIR, oldWorkTree = process.env.GIT_WORK_TREE;
    let cwd = alias;
    if (mode !== 'GIT_WORK_TREE') git(writable, 'config', 'core.worktree', mode === 'relative core.worktree' ? path.relative(admin, vault) : vault);
    if (mode === 'gitfile' || mode === 'relative core.worktree') writeFileSync(path.join(alias, '.git'), `gitdir: ${admin}\n`);
    if (mode === 'GIT_DIR' || mode === 'both environment roots') process.env.GIT_DIR = admin;
    if (mode === 'GIT_WORK_TREE' || mode === 'both environment roots') { process.env.GIT_WORK_TREE = vault; cwd = mode === 'GIT_WORK_TREE' ? writable : alias; }
    const retained = ['note.md', 'o8.md'].map(file => readFileSync(path.join(vault, file)));
    const head = readFileSync(path.join(admin, 'HEAD')), index = readFileSync(path.join(admin, 'index'));
    try {
      const response = await checkout.POST(req('/api/panel/branches/checkout', { repoPath: cwd, branch: 'other', force: true }));
      expect.soft(readFileSync(path.join(vault, 'note.md'))).toEqual(retained[0]);
      expect.soft(readFileSync(path.join(vault, 'o8.md'))).toEqual(retained[1]);
      expect.soft(readFileSync(path.join(admin, 'HEAD'))).toEqual(head);
      expect.soft(readFileSync(path.join(admin, 'index'))).toEqual(index);
      expect(response.status, await response.text()).toBe(403);
    } finally {
      if (oldGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = oldGitDir;
      if (oldWorkTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = oldWorkTree;
    }
  },
);

it('allows an external gitfile checkout whose effective worktree is separate from the source', async () => {
  const writable = repo();
  git(writable, 'checkout', 'other'); writeFileSync(path.join(writable, 'note.md'), 'permitted replacement');
  git(writable, 'add', '.'); git(writable, 'commit', '-m', 'other branch'); git(writable, 'checkout', 'main');
  const worktree = path.join(f.root, `allowed-worktree-${++sequence}`); mkdirSync(worktree);
  writeFileSync(path.join(worktree, 'note.md'), 'retained'); writeFileSync(path.join(worktree, 'o8.md'), '# Retained\n');
  const vault = repo(); await protect(vault);
  git(writable, 'config', 'core.worktree', worktree);
  const alias = path.join(f.root, `allowed-alias-${sequence}`); mkdirSync(alias);
  writeFileSync(path.join(alias, '.git'), `gitdir: ${path.join(writable, '.git')}\n`);
  const response = await checkout.POST(req('/api/panel/branches/checkout', { repoPath: alias, branch: 'other', force: true }));
  expect(response.status, await response.text()).toBe(200);
  expect(readFileSync(path.join(worktree, 'note.md'), 'utf8')).toBe('permitted replacement');
  expect(readFileSync(path.join(vault, 'note.md'), 'utf8')).toBe('retained');
});

it('refuses a commit whose environment redirects Git objects into protected notes', async () => {
  const writable = repo(), vault = repo();
  const objects = path.join(vault, 'objects'); mkdirSync(objects); await protect(vault);
  writeFileSync(path.join(writable, 'note.md'), 'new object bytes');
  const note = readFileSync(path.join(vault, 'note.md'));
  const oldObjects = process.env.GIT_OBJECT_DIRECTORY, oldAlternates = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  process.env.GIT_OBJECT_DIRECTORY = objects;
  process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = path.join(writable, '.git', 'objects');
  try {
    const response = await commit.POST(req('/api/review/commit', { workspace: writable, message: 'must not write objects' }));
    expect.soft(readFileSync(path.join(vault, 'note.md'))).toEqual(note);
    expect.soft(readdirSync(objects)).toEqual([]);
    expect(response.status, await response.text()).toBe(403);
  } finally {
    if (oldObjects === undefined) delete process.env.GIT_OBJECT_DIRECTORY; else process.env.GIT_OBJECT_DIRECTORY = oldObjects;
    if (oldAlternates === undefined) delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES; else process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = oldAlternates;
  }
});

it('refuses caller Git overrides even when they point at unrelated writable storage', async () => {
  const writable = repo(), vault = repo(); await protect(vault);
  const original = process.env.GIT_OBJECT_DIRECTORY;
  process.env.GIT_OBJECT_DIRECTORY = path.join(writable, '.git', 'objects');
  try {
    const response = await editor.PUT(req('/api/panel/file-io', { path: path.join(writable, 'note.md'), content: 'permitted editor update' }, 'PUT'));
    expect(response.status, await response.text()).toBe(403);
    expect(readFileSync(path.join(writable, 'note.md'), 'utf8')).toBe('retained');
    expect(readFileSync(path.join(vault, 'note.md'), 'utf8')).toBe('retained');
  } finally {
    if (original === undefined) delete process.env.GIT_OBJECT_DIRECTORY; else process.env.GIT_OBJECT_DIRECTORY = original;
  }
});


it.each(['refs', 'refs/heads', 'logs', 'logs/refs/heads', 'packed-refs', 'index', 'objects', 'objects/pack', 'objects/info', 'worktrees', 'worktrees/redirected'] as const)(
  'refuses symlinked Git %s storage before branch writes can touch protected notes', async storage => {
    const writable = repo(); const vault = path.join(f.root, `symlink-notes-${++sequence}`); mkdirSync(vault);
    const note = path.join(vault, 'note.md'); writeFileSync(note, 'retained notes\n'); await protect(vault);
    const target = path.join(writable, '.git', storage); mkdirSync(path.dirname(target), { recursive: true });
    const file = storage === 'index' || storage === 'packed-refs';
    const destination = file ? note : vault;
    if (existsSync(target)) renameSync(target, path.join(vault, 'retained-storage'));
    if (storage === 'packed-refs') writeFileSync(note, '# pack-refs with: peeled fully-peeled sorted \n');
    if (storage === 'index') writeFileSync(note, readFileSync(path.join(vault, 'retained-storage')));
    if (storage === 'objects') {
      for (const name of readdirSync(path.join(vault, 'retained-storage'))) renameSync(path.join(vault, 'retained-storage', name), path.join(vault, name));
    }
    symlinkSync(destination, target, file ? 'file' : 'dir');
    const retained = readFileSync(note); const names = readdirSync(vault).sort();
    const branch = storage === 'logs/refs/heads' ? 'note.md' : 'unreviewed';
    const response = await branches.POST(req('/api/panel/branches', { path: writable, branch }));
    expect.soft(readFileSync(note), 'protected note bytes changed').toEqual(retained);
    expect.soft(readdirSync(vault).sort(), 'Git created files inside protected notes').toEqual(names);
    expect(response.status, await response.text()).toBe(403);
  },
);

it.each(['GIT_TRACE', 'GIT_TRACE_SETUP', 'GIT_TRACE_PERFORMANCE', 'GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT', 'GIT_PAGER'])(
  'refuses inherited %s before the guard itself can run Git or modify notes', async name => {
    const writable = repo(); const vault = path.join(f.root, `trace-notes-${++sequence}`); mkdirSync(vault);
    const note = path.join(vault, 'note.md'); writeFileSync(note, '# Retained trace canary\n'); await protect(vault);
    // The old guard ultimately refuses this worktree, but its earlier probe
    // must not append trace output on the way to that refusal.
    git(writable, 'config', 'core.worktree', vault);
    const retained = readFileSync(note); const previous = process.env[name];
    process.env[name] = note; f.gitCalls = 0;
    try {
      const response = await checkout.POST(req('/api/panel/branches/checkout', { repoPath: writable, branch: 'other', force: true }));
      expect.soft(readFileSync(note)).toEqual(retained);
      expect.soft(f.gitCalls, 'a guard probe inherited caller-controlled Git behavior').toBe(0);
      expect(response.status, await response.text()).toBe(403);
    } finally {
      if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    }
  },
);

it('keeps guard probes read-only when local Git config enables trace2 output', async () => {
  const writable = repo(); const vault = path.join(f.root, `config-trace-${++sequence}`); mkdirSync(vault);
  const note = path.join(vault, 'note.md'); writeFileSync(note, '# Retained configuration trace canary\n'); await protect(vault);
  git(writable, 'config', 'core.worktree', vault);
  git(writable, 'config', 'trace2.eventTarget', note);
  const retained = readFileSync(note);
  const response = await checkout.POST(req('/api/panel/branches/checkout', { repoPath: writable, branch: 'other', force: true }));
  expect.soft(readFileSync(note)).toEqual(retained);
  expect(response.status, await response.text()).toBe(403);
});

it.each(['refs/heads', 'logs/refs/heads'])('refuses source admission when a registered repo redirects %s into it', async storage => {
  const writable = repo(); const vault = path.join(f.root, `admission-notes-${++sequence}`); mkdirSync(vault);
  const note = path.join(vault, 'note.md'); writeFileSync(note, '# Retained admission canary\n');
  const target = path.join(writable, '.git', storage); renameSync(target, `${target}-retained`); symlinkSync(vault, target, 'dir');
  await addRepo(writable);
  const sourceApi = await import('@/app/api/cortex/sources/route');
  const retained = readFileSync(note);
  const response = await sourceApi.POST(req('/api/cortex/sources', { action: 'add', path: vault }));
  expect.soft(readFileSync(note)).toEqual(retained);
  expect(response.status, await response.text()).toBe(400);
});

it.each(['refs/heads', 'logs/refs/heads'])('allows Git %s symlinks whose physical storage remains separate from knowledge sources', async storage => {
  const writable = repo(); const vault = repo(); await protect(vault);
  const target = path.join(writable, '.git', storage); const external = path.join(f.root, `permitted-storage-${++sequence}`);
  renameSync(target, external); symlinkSync(external, target, 'dir');
  const retained = readFileSync(path.join(vault, 'note.md'));
  const response = await branches.POST(req('/api/panel/branches', { path: writable, branch: 'allowed-new' }));
  expect(response.status, await response.text()).toBe(200);
  expect(readFileSync(path.join(vault, 'note.md'))).toEqual(retained);
  expect(existsSync(path.join(external, 'allowed-new'))).toBe(true);
});

it('keeps an unrelated editor file writable without caller Git overrides', async () => {
  const writable = repo(), vault = repo(); await protect(vault);
  const response = await editor.PUT(req('/api/panel/file-io', { path: path.join(writable, 'note.md'), content: 'permitted editor update' }, 'PUT'));
  expect(response.status, await response.text()).toBe(200);
  expect(readFileSync(path.join(writable, 'note.md'), 'utf8')).toBe('permitted editor update');
  expect(readFileSync(path.join(vault, 'note.md'), 'utf8')).toBe('retained');
});

it('resolves parent traversal after intermediate symlinks before Git reflog writes', async () => {
  const writable = repo(); const vault = path.join(f.root, `traversal-notes-${++sequence}`);
  const outside = path.join(f.root, `traversal-outside-${sequence}`);
  mkdirSync(path.join(vault, 'heads'), { recursive: true }); mkdirSync(path.join(vault, 'child'));
  mkdirSync(path.join(outside, 'heads'), { recursive: true });
  const note = path.join(vault, 'heads', 'note.md'); writeFileSync(note, 'retained notes\n'); await protect(vault);
  symlinkSync(path.join(vault, 'child'), path.join(outside, 'hop'));
  const logs = path.join(writable, '.git', 'logs', 'refs', 'heads'); rmSync(logs, { recursive: true });
  symlinkSync(`${outside}/hop/../heads`, logs);
  const retained = readFileSync(note);
  const response = await branches.POST(req('/api/panel/branches', { path: writable, branch: 'note.md' }));
  expect.soft(readFileSync(note)).toEqual(retained);
  expect(response.status, await response.text()).toBe(403);
});
