import { execFileSync } from 'node:child_process';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { captureWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { createPinnedWorkspaceBinding } from '@/lib/worktree/materialization-leaf-io';
import { validateDependencyCloneGraph } from '@/lib/workspace/dependency-clone-validation';
import { materializeDependencyInstall as materialize, type DependencyMaterializerOptions } from '@/lib/workspace/dependency-materializer';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

function materializeDependencyInstall(workspace: string, command: string, options: DependencyMaterializerOptions) {
  return materialize(workspace, command, {
    run: async () => { throw new Error('Unexpected installer fallback'); }, ...options,
  });
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function installBaseline(source: string, command = 'npm ci --ignore-scripts') {
  await materializeDependencyInstall(source, command, { platform: 'darwin', resolveVersion: async () => '11.8.0',
    env: { O8_APFS_DEPENDENCY_IMAGES: '0' }, run: async () => {} });
}

async function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-directory-clone-')));
  roots.push(root);
  const source = path.join(root, 'source');
  const workspace = path.join(root, 'workspace');
  mkdirSync(source);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(source, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(source, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  const packages = { 'node_modules/fixture': { version: '1.0.0' } };
  writeFileSync(path.join(source, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  mkdirSync(path.join(source, 'tools'));
  writeFileSync(path.join(source, 'tools/package.json'), '{"name":"unrelated-tool"}');
  git('add', '.');
  git('-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'fixture');
  git('clone', '--local', '-q', source, workspace);
  mkdirSync(path.join(source, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(path.join(source, 'node_modules', 'fixture'));
  writeFileSync(path.join(source, 'node_modules', 'fixture', 'package.json'), '{"name":"fixture","version":"1.0.0","bin":"../tool.js"}');
  writeFileSync(path.join(source, 'node_modules', '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  writeFileSync(path.join(source, 'node_modules', 'tool.js'), 'private\n');
  symlinkSync('../tool.js', path.join(source, 'node_modules', '.bin', 'tool'));
  await installBaseline(source);
  return { root, source, workspace };
}

it('materializes the matching recipe privately without an install on APFS, with the native fallback elsewhere', async () => {
  const { source, workspace } = await fixture();
  const persisted = vi.fn();
  const run = vi.fn(async () => {
    mkdirSync(path.join(workspace, 'node_modules'));
    writeFileSync(path.join(workspace, 'node_modules', 'tool.js'), 'fallback\n');
  });
  const identity = await captureWorktreeMaterializationIdentity(workspace);
  const result = await materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
    cloneSourceWorkspace: source, materializationIdentity: identity,
    resolveVersion: async () => '11.8.0', env: { O8_APFS_DEPENDENCY_IMAGES: '0' },
    persistReceipt: persisted, run,
  });
  expect(result.receipt).toMatchObject({ mode: 'native', status: 'mounted', workspaceInode: identity.inode });
  expect(persisted).toHaveBeenCalledWith(result.receipt);
  if (process.platform === 'darwin') {
    expect(run).not.toHaveBeenCalled();
    expect(result.installReceipt).toBeNull();
    expect(readFileSync(path.join(workspace, 'node_modules', '.bin', 'tool'), 'utf8')).toBe('private\n');
  } else {
    expect(run).toHaveBeenCalledOnce();
  }
  expect(lstatSync(path.join(workspace, 'node_modules', 'tool.js')).ino)
    .not.toBe(lstatSync(path.join(source, 'node_modules', 'tool.js')).ino);
  writeFileSync(path.join(workspace, 'node_modules', 'tool.js'), 'worker\n');
  expect(readFileSync(path.join(source, 'node_modules', 'tool.js'), 'utf8')).toBe('private\n');
});

it('forces a fresh install after payload refusal even when image reuse is enabled', async () => {
  const { source, workspace } = await fixture();
  execFileSync('git', ['rm', '-qr', 'tools'], { cwd: source });
  execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'single root manifest'], { cwd: source });
  execFileSync('git', ['pull', '-q', '--ff-only'], { cwd: workspace });
  symlinkSync(path.join(source, 'node_modules/tool.js'), path.join(source, 'node_modules/.cache-link'));
  const probeApfs = vi.fn(async () => false);
  const selected = vi.fn();
  const persisted = vi.fn();
  const result = await materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
    cloneSourceWorkspace: source, platform: 'darwin', resolveVersion: async () => '11.8.0',
    env: { O8_APFS_DEPENDENCY_IMAGES: '1' }, probeApfs, onSelection: selected, persistReceipt: persisted,
    run: async () => {
      mkdirSync(path.join(workspace, 'node_modules'));
      writeFileSync(path.join(workspace, 'node_modules/tool.js'), 'fresh\n');
    },
  });
  expect(probeApfs).not.toHaveBeenCalled();
  expect(selected).toHaveBeenCalledWith({ path: 'native-install', reason: 'payload-absolute-link' });
  expect(result.receipt.source).toBeUndefined();
  expect(persisted).toHaveBeenCalledWith(result.receipt);
});

it.skipIf(process.platform !== 'darwin')('clones identical dependency inputs across different committed source trees', async () => {
  const { source, workspace } = await fixture();
  writeFileSync(path.join(source, 'README.md'), 'new donor commit\n');
  execFileSync('git', ['add', 'README.md'], { cwd: source });
  execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'docs only'], { cwd: source });
  const run = vi.fn(async () => { throw new Error('Unexpected installer fallback'); });
  const result = await materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
    cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0',
    env: { O8_APFS_DEPENDENCY_IMAGES: '0' }, run,
  });
  expect(result.receipt.source).toBe('directory-clone');
  expect(run).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== 'darwin').each(['config', 'patch', 'lifecycle', 'undeclared-lifecycle'])(
  'refuses cross-tree cloning for a changed or unbounded %s input', async (kind) => {
    const { source, workspace } = await fixture();
    const manifest = { name: 'fixture', version: '1.0.0', scripts: { postinstall: 'node setup.js' },
      ...(kind === 'undeclared-lifecycle' ? {} : { o8DependencyClone: { lifecycleInputs: ['setup.js'] } }) };
    for (const dir of [source, workspace]) {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
      writeFileSync(path.join(dir, 'setup.js'), '// original setup\n');
      execFileSync('git', ['add', 'package.json', 'setup.js'], { cwd: dir });
      execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'setup'], { cwd: dir });
    }
    const changed = kind === 'config' ? '.npmrc' : kind === 'patch' ? 'extra.patch' : kind === 'lifecycle' ? 'setup.js' : 'README.md';
    writeFileSync(path.join(source, changed), kind === 'config' ? 'legacy-peer-deps=true\n' : '// changed\n');
    execFileSync('git', ['add', changed], { cwd: source });
    execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'donor change'], { cwd: source });
    const run = vi.fn(async () => { mkdirSync(path.join(workspace, 'node_modules')); });
    const result = await materializeDependencyInstall(workspace, 'npm ci', {
      cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0',
      env: { O8_APFS_DEPENDENCY_IMAGES: '0' }, run,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(result.receipt.source).toBeUndefined();
  },
);

it.skipIf(process.platform !== 'darwin')('requires a complete lifecycle declaration for dependency-generated workspace output', async () => {
  const { source, workspace } = await fixture();
  writeFileSync(path.join(source, 'node_modules/fixture/package.json'), JSON.stringify({
    name: 'fixture', version: '1.0.0', bin: '../tool.js', scripts: { postinstall: 'generate-from-workspace-schema' },
  }));
  for (const dir of [source, workspace]) {
    const lock = JSON.parse(readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/fixture'].hasInstallScript = true;
    writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
    execFileSync('git', ['add', 'package-lock.json'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'dependency lifecycle'], { cwd: dir });
    if (dir === source) writeFileSync(path.join(dir, 'node_modules/.package-lock.json'), JSON.stringify(lock));
  }
  writeFileSync(path.join(source, 'node_modules/fixture/generated.js'), 'donor schema output');
  writeFileSync(path.join(source, 'schema.txt'), 'changed donor schema');
  execFileSync('git', ['add', 'schema.txt'], { cwd: source });
  execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'schema'], { cwd: source });
  const run = vi.fn(async () => { mkdirSync(path.join(workspace, 'node_modules')); });
  const result = await materializeDependencyInstall(workspace, 'npm ci', {
    cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0',
    env: { O8_APFS_DEPENDENCY_IMAGES: '0' }, run,
  });
  expect(run).toHaveBeenCalledOnce();
  expect(result.receipt.source).toBeUndefined();
});

it.each(['../outside', '/absolute', 'missing.js', 'tools', 'setup-link.js'])(
  'refuses unsafe lifecycle input %s through materialization', async (input) => {
    const { source, workspace } = await fixture();
    const manifest = { name: 'fixture', version: '1.0.0', o8DependencyClone: { lifecycleInputs: [input] } };
    writeFileSync(path.join(workspace, 'package.json'), JSON.stringify(manifest));
    symlinkSync('package.json', path.join(workspace, 'setup-link.js'));
    execFileSync('git', ['add', 'package.json', 'setup-link.js'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'declared inputs'], { cwd: workspace });
    const run = vi.fn();
    await expect(materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
      cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0', run,
    })).rejects.toThrow(/Dependency (clone lifecycle inputs|recipe input)/);
    expect(run).not.toHaveBeenCalled();
  },
);

it('falls back for a changed source recipe instead of cloning stale dependencies', async () => {
  const { source, workspace } = await fixture();
  writeFileSync(path.join(source, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
  const selected = vi.fn();
  const run = vi.fn(async () => {
    expect(selected).toHaveBeenCalledWith({ path: 'native-install', reason: process.platform === 'darwin' ? 'source-inputs-mismatch' : 'ineligible-recipe' });
    mkdirSync(path.join(workspace, 'node_modules'));
  });
  await materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
    cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0',
    env: { O8_APFS_DEPENDENCY_IMAGES: '0' }, run, onSelection: selected,
  });
  expect(run).toHaveBeenCalledOnce();
});

it('falls back for stale installed versions even when the source recipe is unchanged', async () => {
  const { source, workspace } = await fixture();
  writeFileSync(path.join(source, 'node_modules', 'fixture', 'package.json'), '{"name":"fixture","version":"0.9.0"}');
  const run = vi.fn(async () => { mkdirSync(path.join(workspace, 'node_modules')); });
  await materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
    cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0',
    env: { O8_APFS_DEPENDENCY_IMAGES: '0' }, run,
  });
  expect(run).toHaveBeenCalledOnce();
});

it('falls back for an unlisted nested package that would shadow the locked resolution', async () => {
  const { source, workspace } = await fixture();
  const nested = path.join(source, 'node_modules', 'fixture', 'node_modules', 'stale');
  mkdirSync(nested, { recursive: true });
  writeFileSync(path.join(nested, 'package.json'), '{"name":"stale","version":"0.9.0"}');
  const run = vi.fn(async () => { mkdirSync(path.join(workspace, 'node_modules')); });
  await materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
    cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0',
    env: { O8_APFS_DEPENDENCY_IMAGES: '0' }, run,
  });
  expect(run).toHaveBeenCalledOnce();
});

it.skipIf(process.platform !== 'darwin')('refuses incompatible native bindings before recording a clone receipt', async () => {
  const { source, workspace } = await fixture();
  writeFileSync(path.join(source, 'node_modules', 'fixture', 'binding.node'), 'incompatible native artifact');
  await installBaseline(source);
  const persisted = vi.fn();
  await expect(materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
    cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0',
    env: { O8_APFS_DEPENDENCY_IMAGES: '0' }, persistReceipt: persisted,
  })).rejects.toThrow(/dlopen/);
  expect(persisted).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== 'darwin')('preserves a competing destination instead of overwriting it during publication', async () => {
  const { source, workspace } = await fixture();
  const identity = await captureWorktreeMaterializationIdentity(workspace);
  await expect(createPinnedWorkspaceBinding(workspace, identity, 'node_modules', {
    mode: 'clone-tree', source: path.join(source, 'node_modules'),
  }, async (segment) => {
    if (segment !== 'clone-source') return;
    mkdirSync(path.join(workspace, 'node_modules'));
    writeFileSync(path.join(workspace, 'node_modules', 'sentinel'), 'preserve');
  })).rejects.toThrow();
  expect(readFileSync(path.join(workspace, 'node_modules', 'sentinel'), 'utf8')).toBe('preserve');
});

it.skipIf(process.platform !== 'darwin')('runs root lifecycle output after cloning instead of silently skipping setup', async () => {
  const { source, workspace } = await fixture();
  const lifecycle = { scripts: { postinstall: 'fixture-generate' } };
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', ...lifecycle }));
  execFileSync('git', ['add', 'package.json'], { cwd: source });
  execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'lifecycle'], { cwd: source });
  execFileSync('git', ['pull', '-q', '--ff-only'], { cwd: workspace });
  await installBaseline(source, 'npm ci');
  const run = vi.fn(async (invocation: { args: string[] }) => {
    expect(invocation.args).toEqual(['rebuild', '.']);
    writeFileSync(path.join(workspace, 'generated.txt'), 'workspace output\n');
  });
  const result = await materializeDependencyInstall(workspace, 'npm ci', {
    cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0',
    env: { O8_APFS_DEPENDENCY_IMAGES: '0' }, run,
  });
  expect(result.receipt.source).toBe('directory-clone');
  expect(run).toHaveBeenCalledOnce();
  expect(readFileSync(path.join(workspace, 'generated.txt'), 'utf8')).toBe('workspace output\n');
});

it.skipIf(process.platform !== 'darwin')('falls back to a private install after a donor acquires external hardlinks', async () => {
  const { root, source, workspace } = await fixture();
  linkSync(path.join(source, 'node_modules', 'tool.js'), path.join(root, 'shared'));
  const selected = vi.fn();
  const result = await materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
    cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0', onSelection: selected,
    env: { O8_APFS_DEPENDENCY_IMAGES: '0' }, run: async () => {
      mkdirSync(path.join(workspace, 'node_modules'));
      writeFileSync(path.join(workspace, 'node_modules/tool.js'), 'private\n');
    },
  });
  expect(result.receipt.source).toBeUndefined();
  expect(selected).toHaveBeenCalledWith({ path: 'native-install', reason: 'payload-shared-hardlink' });
  writeFileSync(path.join(workspace, 'node_modules', 'tool.js'), 'worker');
  expect(readFileSync(path.join(root, 'shared'), 'utf8')).toBe('private\n');
});

it.skipIf(process.platform !== 'darwin').each(['clone-source', 'clone-receipted', 'clone-created'])(
  'refuses a replaced %s directory without writing into the replacement', async (step) => {
    const { source, workspace } = await fixture();
    const identity = await captureWorktreeMaterializationIdentity(workspace);
    await expect(createPinnedWorkspaceBinding(workspace, identity, 'node_modules', {
      mode: 'clone-tree', source: path.join(source, 'node_modules'),
    }, async (segment) => {
      if (segment !== step) return;
      const target = path.join(step === 'clone-source' ? source : workspace, 'node_modules');
      renameSync(target, `${target}-admitted`);
      mkdirSync(target);
      writeFileSync(path.join(target, 'sentinel'), 'preserve\n');
    })).rejects.toThrow(/Pinned clone (source|target) changed/);
    const target = path.join(step === 'clone-source' ? source : workspace, 'node_modules');
    expect(readFileSync(path.join(target, 'sentinel'), 'utf8')).toBe('preserve\n');
  },
);

it('validates graph metadata without walking ordinary package payloads', async () => {
  const { source } = await fixture();
  const payload = path.join(source, 'node_modules/fixture/assets/deep');
  mkdirSync(payload, { recursive: true });
  writeFileSync(path.join(payload, 'payload.js'), 'payload must not be read');
  await installBaseline(source);
  const io = await import('node:fs/promises');
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).readdir;
  const visited: string[] = [];
  const spy = vi.mocked(io.readdir).mockImplementation(async (...args) => {
    visited.push(String(args[0]));
    if (String(args[0]).includes('/assets')) throw new Error('Dependency payload walk');
    return original(...args);
  });
  try {
    expect(await validateDependencyCloneGraph(source)).not.toBeNull();
    expect(visited.some((name) => name.includes('/assets'))).toBe(false);
  } finally { spy.mockImplementation(original); }
});

it.skipIf(process.platform !== 'darwin')('checks a manifest-declared native binding outside conventional build paths', async () => {
  const { source, workspace } = await fixture();
  mkdirSync(path.join(source, 'node_modules/fixture/custom'));
  writeFileSync(path.join(source, 'node_modules/fixture/custom/fixture.node'), 'incompatible');
  writeFileSync(path.join(source, 'node_modules/fixture/package.json'), JSON.stringify({version:'1.0.0', main:'custom/fixture.node', bin:'../tool.js'}));
  await installBaseline(source);
  const persistReceipt = vi.fn();
  const run = vi.fn(async () => { throw new Error('Unexpected installer fallback'); });
  await expect(materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
    cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0',
    env: { O8_APFS_DEPENDENCY_IMAGES: '0' }, persistReceipt, run,
  })).rejects.toThrow(/dlopen/);
  expect(persistReceipt).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== 'darwin').each(['hasInstallScript', 'binding.gyp', 'prebuilds', 'platform'])(
  'checks custom deep native output selected by %s metadata', async (marker) => {
    const { source, workspace } = await fixture();
    if (marker === 'hasInstallScript') {
      for (const relative of ['package-lock.json', 'node_modules/.package-lock.json']) {
        const lock = JSON.parse(readFileSync(path.join(source, relative), 'utf8'));
        lock.packages['node_modules/fixture'].hasInstallScript = true;
        writeFileSync(path.join(source, relative), JSON.stringify(lock));
      }
      execFileSync('git', ['add', 'package-lock.json'], { cwd: source });
      execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'native metadata'], { cwd: source });
      execFileSync('git', ['pull', '-q', '--ff-only'], { cwd: workspace });
    } else if (marker === 'binding.gyp') {
      writeFileSync(path.join(source, 'node_modules/fixture/binding.gyp'), '{"targets":[]}');
    } else if (marker === 'prebuilds') {
      mkdirSync(path.join(source, 'node_modules/fixture/prebuilds'));
    } else {
      const manifest = JSON.parse(readFileSync(path.join(source, 'node_modules/fixture/package.json'), 'utf8'));
      writeFileSync(path.join(source, 'node_modules/fixture/package.json'), JSON.stringify({...manifest, os:[process.platform], cpu:[process.arch]}));
    }
    mkdirSync(path.join(source, 'node_modules/fixture/custom/deep'), {recursive:true});
    writeFileSync(path.join(source, 'node_modules/fixture/custom/deep/addon.node'), 'incompatible custom addon');
    await installBaseline(source);
    const persistReceipt = vi.fn();
    await expect(materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
      cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0',
      env: { O8_APFS_DEPENDENCY_IMAGES: '0' }, persistReceipt,
    })).rejects.toThrow(/dlopen/);
    expect(persistReceipt).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform !== 'darwin')('checks native output after the root lifecycle has replaced it', async () => {
  const { source, workspace } = await fixture();
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({name:'fixture', version:'1.0.0', scripts:{postinstall:'generate'}}));
  execFileSync('git', ['add', 'package.json'], { cwd: source });
  execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'lifecycle'], { cwd: source });
  execFileSync('git', ['pull', '-q', '--ff-only'], { cwd: workspace });
  await installBaseline(source, 'npm ci');
  const persistReceipt = vi.fn();
  const run = vi.fn(async () => { writeFileSync(path.join(workspace, 'node_modules/fixture/late.node'), 'incompatible lifecycle output'); });
  await expect(materializeDependencyInstall(workspace, 'npm ci', {
    cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0',
    env:{O8_APFS_DEPENDENCY_IMAGES:'0'}, persistReceipt, run,
  })).rejects.toThrow(/dlopen/);
  expect(run).toHaveBeenCalledOnce();
  expect(persistReceipt).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== 'darwin').each(['lockfile', 'package-directory', 'deep-native', 'committed-tree'])(
  'discards the exact clone and falls back when the source %s changes', async (mutation) => {
    const { source, workspace } = await fixture();
    if (mutation === 'deep-native') {
      writeFileSync(path.join(source, 'node_modules/fixture/binding.gyp'), '{"targets":[]}');
      mkdirSync(path.join(source, 'node_modules/fixture/custom/deep'), {recursive:true});
      writeFileSync(path.join(source, 'node_modules/fixture/custom/deep/addon.node'), 'before');
    }
    await installBaseline(source);
    const run = vi.fn(async () => {
      expect(() => lstatSync(path.join(workspace, 'node_modules'))).toThrow();
      mkdirSync(path.join(workspace, 'node_modules'));
      expect(() => readFileSync(path.join(workspace, 'node_modules/tool.js'))).toThrow();
      writeFileSync(path.join(workspace, 'node_modules/fallback'), 'fresh private view');
    });
    const result = await materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
      cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0', env:{O8_APFS_DEPENDENCY_IMAGES:'0'}, run,
      afterDependencyDirectoryClone: async () => {
        if (mutation === 'lockfile') writeFileSync(path.join(source, 'package-lock.json'), '{"changed":true}');
        else if (mutation === 'package-directory') {
          const pkg = path.join(source, 'node_modules/fixture');
          renameSync(pkg, `${pkg}-old`);
          mkdirSync(pkg);
          writeFileSync(path.join(pkg, 'package.json'), '{"version":"1.0.0"}');
        } else if (mutation === 'committed-tree') {
          writeFileSync(path.join(source, 'README.md'), 'donor advanced during clone');
          execFileSync('git', ['add', 'README.md'], { cwd: source });
          execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'race'], { cwd: source });
        } else writeFileSync(path.join(source, 'node_modules/fixture/custom/deep/addon.node'), 'after');
      },
    });
    expect(run).toHaveBeenCalledOnce();
    expect(result.receipt.source).toBeUndefined();
    expect(readFileSync(path.join(workspace, 'node_modules/fallback'), 'utf8')).toBe('fresh private view');
  },
);

it.skipIf(process.platform !== 'darwin')('refuses fallback when a competing directory replaces the receipted clone', async () => {
  const { source, workspace } = await fixture();
  const run = vi.fn();
  const persistReceipt = vi.fn();
  await expect(materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
    cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0', env:{O8_APFS_DEPENDENCY_IMAGES:'0'}, run, persistReceipt,
    afterDependencyDirectoryClone: async () => {
      writeFileSync(path.join(source, 'package-lock.json'), '{"changed":true}');
      renameSync(path.join(workspace, 'node_modules'), path.join(workspace, 'admitted'));
      mkdirSync(path.join(workspace, 'node_modules'));
      writeFileSync(path.join(workspace, 'node_modules/sentinel'), 'preserve');
    },
  })).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  expect(persistReceipt).not.toHaveBeenCalled();
  expect(readFileSync(path.join(workspace, 'node_modules/sentinel'), 'utf8')).toBe('preserve');
});

it.skipIf(process.platform !== 'darwin')('refuses late source changes without replaying root lifecycle outputs', async () => {
  const { source, workspace } = await fixture();
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({name:'fixture', version:'1.0.0', scripts:{postinstall:'generate'}}));
  execFileSync('git', ['add', 'package.json'], { cwd: source });
  execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'lifecycle'], { cwd: source });
  execFileSync('git', ['pull', '-q', '--ff-only'], { cwd: workspace });
  await installBaseline(source, 'npm ci');
  const persistReceipt = vi.fn();
  const run = vi.fn(async () => {
    writeFileSync(path.join(workspace, 'generated.log'), 'one lifecycle execution');
    writeFileSync(path.join(source, 'package-lock.json'), '{"changed":true}');
  });
  await expect(materializeDependencyInstall(workspace, 'npm ci', {
    cloneSourceWorkspace:source, resolveVersion:async () => '11.8.0', env:{O8_APFS_DEPENDENCY_IMAGES:'0'}, run, persistReceipt,
  })).rejects.toThrow('refusing to replay setup');
  expect(run).toHaveBeenCalledOnce();
  expect(persistReceipt).not.toHaveBeenCalled();
  expect(readFileSync(path.join(workspace, 'generated.log'), 'utf8')).toBe('one lifecycle execution');
});
