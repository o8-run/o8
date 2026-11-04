import { execFile } from 'node:child_process';
import { readFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { WorktreeManager } from '@/lib/worktree/manager';
import { closeDb } from '@/lib/db';
import type { RepoSetupConfig } from '@/lib/repos/types';

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({ accountingStatus: 'observed', probePath: '/',
    availableBytes: 90_000_000_000, freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000, error: null })),
}));

const run = promisify(execFile);
const npmCli = process.env.O8_TEST_NPM_CLI ?? process.env.npm_execpath!;
let root: string;
let registry: string;
let server: Server;
let projectConfig: string;
let packageManager: string;
const tarballs = new Map<string, Buffer>();
const requestedTarballs: string[] = [];
const manifest = { name: 'release-age-consumer', version: '1.0.0', private: true,
  dependencies: { 'o8-age-fixture': '^1.0.0' } };

beforeAll(async () => {
  const { stdout } = await run(process.execPath, [npmCli, '--version']);
  const [major, minor] = stdout.trim().split('.').map(Number);
  if (major < 11 || (major === 11 && minor < 10)) {
    throw new Error('Release-age proof requires npm >=11.10.0, matching the supported CI toolchain. Set O8_TEST_NPM_CLI to an isolated supported npm-cli.js.');
  }
  root = await mkdtemp(path.join(process.env.CORTEX_IDE_DATA_DIR!, 'npm-age-'));
  await writeFile(path.join(root, 'empty-user.npmrc'), '');
  await writeFile(path.join(root, 'empty-global.npmrc'), '');
  projectConfig = await readFile(path.resolve('.npmrc'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  packageManager = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')).packageManager;
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  await symlink(npmCli, path.join(bin, 'npm'));
  vi.stubEnv('PATH', [bin, process.env.PATH].join(path.delimiter));
  vi.stubEnv('O8_APFS_DEPENDENCY_IMAGES', '0');
  for (const version of ['1.0.0', '1.1.0']) {
    const contents = path.join(root, version, 'package');
    await mkdir(contents, { recursive: true });
    await writeFile(path.join(contents, 'package.json'), JSON.stringify({ name: 'o8-age-fixture', version }));
    const archive = path.join(root, `${version}.tgz`);
    await run('tar', ['-czf', archive, '-C', path.dirname(contents), 'package']);
    tarballs.set(`/unused-${version}.tgz`, await readFile(archive));
  }
  server = createServer((request, response) => {
    const tarball = tarballs.get(request.url ?? '');
    if (tarball) {
      requestedTarballs.push(request.url!);
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(tarball);
      return;
    }
    if (request.url !== '/o8-age-fixture') { response.writeHead(404).end(); return; }
    const versions = Object.fromEntries(['1.0.0', '1.1.0'].map(version => [version, {
      name: 'o8-age-fixture', version, dist: { tarball: `${registry}/unused-${version}.tgz` },
    }]));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ name: 'o8-age-fixture', 'dist-tags': { latest: '1.1.0' }, versions,
      time: { '1.0.0': new Date(Date.now() - 30 * 86_400_000).toISOString(),
        '1.1.0': new Date(Date.now() - 3_600_000).toISOString() } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture registry did not bind TCP.');
  registry = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  closeDb();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

async function workspace(name: string, version = '^1.0.0') {
  const directory = path.join(root, name);
  await mkdir(directory);
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ ...manifest,
    dependencies: { 'o8-age-fixture': version } }));
  await writeFile(path.join(directory, '.npmrc'), projectConfig);
  return directory;
}

async function resolve(directory: string, extra: string[] = []) {
  await run(process.execPath, [npmCli, 'install', '--package-lock-only', '--ignore-scripts',
    '--no-audit', '--no-fund', ...extra], { cwd: directory, timeout: 15_000,
    env: { NODE_ENV: 'test', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      HOME: root, USERPROFILE: root, npm_config_registry: registry,
      npm_config_cache: path.join(directory, '.npm-cache'), npm_config_fetch_retries: '0',
      npm_config_userconfig: path.join(root, 'empty-user.npmrc'),
      npm_config_globalconfig: path.join(root, 'empty-global.npmrc') } });
  const lock = JSON.parse(await readFile(path.join(directory, 'package-lock.json'), 'utf8'));
  return lock.packages['node_modules/o8-age-fixture'].version;
}

describe('repository release-age policy through the real npm CLI', () => {
  it('selects the aged release instead of the newly published latest version', async () => {
    expect(await resolve(await workspace('range'))).toBe('1.0.0');
  });

  it('refuses an exact version when it is younger than the policy', async () => {
    await expect(resolve(await workspace('exact', '1.1.0'))).rejects.toMatchObject({
      stderr: expect.stringMatching(/ETARGET|No matching version/),
    });
  });

  it('allows a one-command emergency override without changing repository policy', async () => {
    expect(await resolve(await workspace('override'), ['--min-release-age=0'])).toBe('1.1.0');
    expect(await readFile(path.resolve('.npmrc'), 'utf8').catch(() => '')).toBe(projectConfig);
  });

  it('carries the project policy into a packet checkout for a supported npm CLI', async () => {
    const repo = await workspace('source');
    const git = (...args: string[]) => run('git', args, { cwd: repo, timeout: 10_000 });
    await git('init', '-b', 'main');
    await git('add', 'package.json', '.npmrc');
    await git('-c', 'user.name=o8-test', '-c', 'user.email=test@o8.invalid', 'commit', '-m', 'fixture');
    vi.stubEnv('O8_WORKTREE_ROOT', path.join(root, 'worktrees'));
    vi.stubEnv('O8_SKIP_PRELAUNCH_TYPECHECK', '1');
    const packet = await new WorktreeManager(repo).create({ agentType: 'codex', managed: true,
      packetId: 'pkt-release-age', branchName: 'fixture/release-age', baseBranch: 'main',
      taskName: 'release-age', skipSetup: true, isolationPreference: 'git-worktree' });
    expect(await resolve(packet.path)).toBe('1.0.0');
  }, 60_000);
});

const installCommand = 'npm install --ignore-scripts --no-audit --no-fund';
const setup: RepoSetupConfig = {
  envMode: 'skip', envFiles: [], installCommand, installOnCreateWorkspace: true,
  buildCommand: null, runBuildOnCreateWorkspace: false, devCommand: null,
  defaultPort: null, workspaceIsolationPreference: 'git-worktree',
};

async function workerSource(name: string, version = '^1.0.0', locked = false) {
  const repo = await workspace(name, version);
  const fixtureManifest = { ...manifest, packageManager,
    dependencies: { 'o8-age-fixture': version } };
  await writeFile(path.join(repo, 'package.json'), JSON.stringify(fixtureManifest));
  await writeFile(path.join(repo, '.npmrc'), `${projectConfig}\nregistry=${registry}\nfetch-retries=0\n`);
  // Leave the dependency unresolved so a saved npm install must consult the registry.
  await writeFile(path.join(repo, 'package-lock.json'), JSON.stringify({
    name: manifest.name, version: manifest.version, lockfileVersion: 3,
    packages: { '': fixtureManifest },
  }));
  if (locked) await resolve(repo);
  await writeFile(path.join(repo, '.gitignore'), 'node_modules/\n.npm-cache/\n');
  const git = (...args: string[]) => run('git', args, { cwd: repo, timeout: 10_000 });
  await git('init', '-b', 'main');
  await git('add', 'package.json', 'package-lock.json', '.npmrc', '.gitignore');
  await git('-c', 'user.name=o8-test', '-c', 'user.email=test@o8.invalid', 'commit', '-m', 'fixture');
  vi.stubEnv('O8_WORKTREE_ROOT', path.join(root, 'worker-checkouts'));
  vi.stubEnv('O8_SKIP_PRELAUNCH_TYPECHECK', '1');
  return new WorktreeManager(repo);
}

async function createWorker(manager: WorktreeManager, name: string, command = installCommand) {
  return manager.create({ agentType: 'codex', managed: true, packetId: `pkt-age-${name}`,
    branchName: `fixture/${name}`, baseBranch: 'main', taskName: name,
    isolationPreference: 'git-worktree', repoSetup: { ...setup, installCommand: command } });
}

describe('pinned worker dependency installation in a real packet checkout', () => {
  it('installs the aged matching package and persists the saved-install receipt', async () => {
    const manager = await workerSource('worker-range');
    const packet = await createWorker(manager, 'range');
    const installed = JSON.parse(await readFile(path.join(packet.path,
      'node_modules/o8-age-fixture/package.json'), 'utf8'));
    expect(installed.version).toBe('1.0.0');
    expect((await manager.get(packet.id))?.dependencyMaterialization).toMatchObject({
      mode: 'native', installCommand, recipeKey: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(await readFile(path.join(packet.path, '.npmrc'), 'utf8')).toContain('min-release-age=7');
  }, 60_000);

  it('refuses a newly published exact package before downloading its archive', async () => {
    const manager = await workerSource('worker-exact', '1.1.0');
    requestedTarballs.length = 0;
    await expect(createWorker(manager, 'exact')).rejects.toThrow(/ETARGET|No matching version/);
    expect(requestedTarballs).not.toContain('/unused-1.1.0.tgz');
  }, 60_000);

  it('executes the default npm ci contract with the aged reviewed lockfile', async () => {
    const manager = await workerSource('worker-ci', '^1.0.0', true);
    const command = 'npm ci --prefer-offline --ignore-scripts --no-audit --no-fund';
    const packet = await createWorker(manager, 'ci', command);
    const installed = JSON.parse(await readFile(path.join(packet.path,
      'node_modules/o8-age-fixture/package.json'), 'utf8'));
    expect(installed.version).toBe('1.0.0');
    expect((await manager.get(packet.id))?.dependencyMaterialization).toMatchObject({
      mode: 'native', installCommand: command, recipeKey: packet.dependencyRecipeKey,
    });
  }, 60_000);
});
