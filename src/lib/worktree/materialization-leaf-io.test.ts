import {
  chmodSync,
  existsSync,
  mkdirSync,
  lstatSync,
  linkSync,
  rmSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';
import { captureWorktreeMaterializationIdentity } from './materialization-identity';
import {
  createPinnedWorkspaceBinding,
  createPinnedInstallRuntime,
  ensurePinnedWorkspaceDirectory,
  ensurePinnedWorkspaceFile,
  inspectPinnedWorkspaceEntry,
  writePinnedWorkspaceFile,
} from './materialization-leaf-io';

it('terminates an absent pinned inspection with a null receipt', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-absent-inspection-'));
  const identity = await captureWorktreeMaterializationIdentity(workspace);

  await expect(inspectPinnedWorkspaceEntry(
    workspace,
    identity,
    'node_modules',
  )).resolves.toBeNull();
}, 5_000);

it('refuses an ancestor swap between pinned descendant components', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-chain-root-'));
  const redirected = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-chain-redirect-'));
  const sentinel = path.join(redirected, 'sentinel');
  writeFileSync(sentinel, 'preserve');
  const rootIdentity = await captureWorktreeMaterializationIdentity(root);

  await expect(ensurePinnedWorkspaceDirectory(
    root,
    rootIdentity,
    'repo-key/.cortex-worktrees',
    async (segment) => {
      if (segment !== 'repo-key') return;
      renameSync(path.join(root, segment), path.join(root, `${segment}-admitted`));
      symlinkSync(redirected, path.join(root, segment), 'dir');
    },
  )).rejects.toThrow('Pinned workspace ancestor changed during capture.');

  expect(existsSync(path.join(redirected, '.cortex-worktrees'))).toBe(false);
  expect(existsSync(sentinel)).toBe(true);
});

it('refuses a hydration source swap before external bytes reach the workspace', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-copy-workspace-'));
  const source = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-copy-source-'));
  writeFileSync(path.join(source, 'cache'), 'trusted');
  const redirected = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-copy-redirect-'));
  writeFileSync(path.join(redirected, 'secret'), 'external');
  const identity = await captureWorktreeMaterializationIdentity(workspace);

  await expect(createPinnedWorkspaceBinding(
    workspace,
    identity,
    '.next/cache',
    { mode: 'copy-tree', source },
    async (segment) => {
      if (segment !== 'source') return;
      renameSync(source, `${source}-admitted`);
      symlinkSync(redirected, source, 'dir');
    },
  )).rejects.toThrow('Pinned hydration source changed after capture.');

  expect(readdirSync(path.join(workspace, '.next', 'cache'))).toEqual([]);
  expect(existsSync(path.join(workspace, '.next', 'secret'))).toBe(false);
}, 30_000);

it('refuses a hydration source swap restored before publish', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-copy-restore-workspace-'));
  const source = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-copy-restore-source-'));
  writeFileSync(path.join(source, 'cache'), 'trusted');
  const redirected = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-copy-restore-redirect-'));
  writeFileSync(path.join(redirected, 'cache'), 'external');
  const admittedSource = `${source}-admitted`;
  const identity = await captureWorktreeMaterializationIdentity(workspace);

  await expect(createPinnedWorkspaceBinding(
    workspace,
    identity,
    '.next/cache',
    { mode: 'copy-tree', source },
    async (segment) => {
      if (segment === 'source-reproved') {
        renameSync(source, admittedSource);
        renameSync(redirected, source);
      } else if (segment === 'source-copied') {
        renameSync(source, redirected);
        renameSync(admittedSource, source);
      }
    },
  )).rejects.toThrow('Pinned hydration source changed during direct population.');

  expect(readFileSync(path.join(workspace, '.next', 'cache', 'cache'), 'utf8')).toBe('external');
}, 30_000);

it('refuses restored hydration sources with byte-identical permission drift', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-mode-workspace-'));
  const source = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-mode-source-'));
  writeFileSync(path.join(source, 'tool'), 'same-bytes');
  chmodSync(path.join(source, 'tool'), 0o644);
  const redirected = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-mode-redirect-'));
  writeFileSync(path.join(redirected, 'tool'), 'same-bytes');
  chmodSync(path.join(redirected, 'tool'), 0o755);
  const admittedSource = `${source}-admitted`;
  const identity = await captureWorktreeMaterializationIdentity(workspace);

  await expect(createPinnedWorkspaceBinding(
    workspace,
    identity,
    'cache',
    { mode: 'copy-tree', source },
    async (segment) => {
      if (segment === 'source-reproved') {
        renameSync(source, admittedSource);
        renameSync(redirected, source);
      } else if (segment === 'source-copied') {
        renameSync(source, redirected);
        renameSync(admittedSource, source);
      }
    },
  )).rejects.toThrow('Pinned hydration source changed during direct population.');

  expect(existsSync(path.join(workspace, 'cache', 'tool'))).toBe(true);
}, 30_000);

it('refuses a replaced direct-write target without mutating the replacement', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-atomic-workspace-'));
  const identity = await captureWorktreeMaterializationIdentity(workspace);
  let admitted = '';
  let replacement = '';

  await expect(writePinnedWorkspaceFile(
    workspace,
    identity,
    'settings.json',
    '{"trusted":true}\n',
    async (segment) => {
      if (segment !== 'atomic-opened') return;
      replacement = path.join(workspace, 'settings.json');
      admitted = `${replacement}-admitted`;
      renameSync(replacement, admitted);
      writeFileSync(replacement, '{"attacker":true}\n');
    },
  )).rejects.toThrow('Pinned workspace target changed before direct write.');

  expect(readFileSync(admitted, 'utf8')).toBe('');
  expect(readFileSync(replacement, 'utf8')).toBe('{"attacker":true}\n');
});

it('preserves both owners when a direct hydration target is replaced before population', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-target-workspace-'));
  const source = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-target-source-'));
  writeFileSync(path.join(source, 'cache'), 'trusted');
  const identity = await captureWorktreeMaterializationIdentity(workspace);
  let admitted = '';
  let replacement = '';

  await expect(createPinnedWorkspaceBinding(
    workspace,
    identity,
    'cache',
    { mode: 'copy-tree', source },
    async (segment) => {
      if (segment !== 'target-created') return;
      replacement = path.join(workspace, 'cache');
      admitted = `${replacement}-admitted`;
      renameSync(replacement, admitted);
      mkdirSync(replacement);
      writeFileSync(path.join(replacement, 'unrelated-sentinel'), 'preserve');
    },
  )).rejects.toThrow('Pinned hydration target changed before population.');

  expect(readdirSync(admitted)).toEqual([]);
  expect(readFileSync(path.join(replacement, 'unrelated-sentinel'), 'utf8')).toBe('preserve');
});

it('refuses a copied file when its opened source changes in place', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-file-workspace-'));
  const source = path.join(mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-file-source-')), '.env');
  writeFileSync(source, 'trusted-secret');
  const identity = await captureWorktreeMaterializationIdentity(workspace);

  await expect(createPinnedWorkspaceBinding(
    workspace,
    identity,
    '.env',
    { mode: 'copy-file', source },
    async (segment) => {
      if (segment === 'copy-file-read') writeFileSync(source, 'changed-secret');
    },
  )).rejects.toThrow('Pinned workspace source file changed during copy.');

  expect(existsSync(path.join(workspace, '.env'))).toBe(false);
});

it('never mutates a replaced preexisting Git exclude receipt', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-append-workspace-'));
  mkdirSync(path.join(workspace, 'info'));
  const exclude = path.join(workspace, 'info', 'o8-managed-excludes');
  const admitted = `${exclude}-admitted`;
  writeFileSync(exclude, '.claude/\n');
  const identity = await captureWorktreeMaterializationIdentity(workspace);

  await expect(ensurePinnedWorkspaceFile(
    workspace,
    identity,
    'info/o8-managed-excludes',
    '.claude/\n',
    async (segment) => {
      if (segment !== 'ensure-file-opened') return;
      renameSync(exclude, admitted);
      writeFileSync(exclude, 'external-sentinel\n');
    },
  )).rejects.toThrow('publish moved an unexpected ensured file');

  expect(readFileSync(exclude, 'utf8')).toBe('external-sentinel\n');
  expect(readFileSync(admitted, 'utf8')).toBe('.claude/\n');
});

it('refuses a swapped installer config ancestor before creating its files', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-runtime-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-runtime-outside-'));
  try {
    const identity = await captureWorktreeMaterializationIdentity(workspace);
    await expect(createPinnedInstallRuntime(workspace, identity, '.o8-install-runtime/attempt', async (step) => {
      if (step !== 'install-runtime-config') return;
      const config = path.join(workspace, '.o8-install-runtime/attempt/config');
      renameSync(config, `${config}-captured`);
      symlinkSync(outside, config, 'dir');
    })).rejects.toThrow(/changed|unsafe/);
    expect(readdirSync(outside)).toEqual([]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

it('creates the private installer scaffold once and refuses an occupied root', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-runtime-scaffold-'));
  try {
    const identity = await captureWorktreeMaterializationIdentity(workspace);
    const created = await createPinnedInstallRuntime(workspace, identity, '.o8-install-runtime/attempt');
    const runtime = path.join(workspace, '.o8-install-runtime/attempt');
    expect(created.inode).toBe(lstatSync(runtime).ino);
    for (const name of ['', 'home', 'config', 'xdg-cache', 'tmp', 'corepack']) {
      expect(lstatSync(path.join(runtime, name)).mode & 0o777).toBe(0o700);
    }
    for (const name of ['config/user.rc', 'config/global.rc']) {
      expect(readFileSync(path.join(runtime, name), 'utf8')).toBe('');
      expect(lstatSync(path.join(runtime, name)).nlink).toBe(1);
      expect(lstatSync(path.join(runtime, name)).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(path.join(runtime, '.gitignore'), 'utf8')).toBe('*\n');
    expect(lstatSync(path.join(runtime, '.gitignore')).nlink).toBe(1);
    expect(lstatSync(path.join(runtime, '.gitignore')).mode & 0o777).toBe(0o600);
    await expect(createPinnedInstallRuntime(workspace, identity, '.o8-install-runtime/attempt')).rejects.toThrow(/EEXIST/);
    expect(lstatSync(runtime).ino).toBe(created.inode);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

it('refuses a replaced installer root before populating any child', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-runtime-root-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-runtime-root-outside-'));
  try {
    const identity = await captureWorktreeMaterializationIdentity(workspace);
    await expect(createPinnedInstallRuntime(workspace, identity, '.o8-install-runtime/attempt', async (step) => {
      if (step !== 'install-runtime-created') return;
      const runtime = path.join(workspace, '.o8-install-runtime/attempt');
      renameSync(runtime, `${runtime}-captured`);
      symlinkSync(outside, runtime, 'dir');
    })).rejects.toThrow(/changed/);
    expect(readdirSync(outside)).toEqual([]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

it('refuses an installer config file that gains an external hardlink', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'o8-pinned-runtime-file-'));
  try {
    const identity = await captureWorktreeMaterializationIdentity(workspace);
    let linked = false;
    await expect(createPinnedInstallRuntime(workspace, identity, '.o8-install-runtime/attempt', async (step) => {
      if (step !== 'install-runtime-file-opened' || linked) return;
      linked = true;
      linkSync(path.join(workspace, '.o8-install-runtime/attempt/config/user.rc'), path.join(workspace, 'outside.rc'));
    })).rejects.toThrow(/changed/);
    expect(readFileSync(path.join(workspace, 'outside.rc'), 'utf8')).toBe('');
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
