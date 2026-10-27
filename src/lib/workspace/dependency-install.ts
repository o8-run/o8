import { createHash, randomUUID } from 'node:crypto';
import { dependencyInstallProcessesStopped, execDependencyInstallProcess } from './dependency-install-process';
import { timedDependencyInstall } from './dependency-install-timing';
import { execFile } from '@/lib/providers/child-process';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { guardedWorkspaceInvocation } from '@/lib/worktree/materialization-execution';
import {
  captureWorktreeMaterializationIdentity,
  type WorktreeMaterializationIdentity,
} from '@/lib/worktree/materialization-identity';
import {
  ensurePinnedWorkspaceDirectory,
  createPinnedInstallRuntime,
} from '@/lib/worktree/materialization-leaf-io';
import { purgeExactDirectory } from './exact-directory-purge';
import {
  assertContainedTrackedSymlinks,
  trackedGitEntries,
} from './dependency-recipe-git-identity';
import {
  assertContainedConfigTarget,
  assertSafeDependencyManagerConfig,
  DependencyAuthenticationUnsupportedError,
  RECIPE_CONFIG_NAMES,
  yarnExecutionTargets,
} from './dependency-manager-config';
import { dependencyInstallCommandForManager } from './dependency-manager-contract';
import {
  resolvePackageManagerExecution,
  resolveReceiptedPackageManagerExecution,
} from './dependency-manager-executable';
import { dependencyCacheRoot } from './dependency-cache-root';
import { acquireDependencyCache, type DependencyCachePolicy, type DependencyCacheRetentionReceipt } from './dependency-cache-retention';
import { dependencyCloneLifecycleInputs } from './dependency-clone-inputs';

const execFileAsync = promisify(execFile);

export type SupportedPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface DependencyInstallInvocation {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface DependencyInstallRecipe {
  key: string;
  packageManager: SupportedPackageManager;
  packageManagerVersion: string;
  runtimeAbi: string;
  platform: NodeJS.Platform;
  architecture: string;
  installArgs: string[];
  lifecycleScripts: 'enabled' | 'disabled';
  gitTreeSha: string;
  cloneLifecycleInputs?: string[];
  lockfile: { path: string; digest: string };
  inputDigests: Array<{ path: string; digest: string }>;
  localDependencyDigests: Array<{ identity: string; digest: string }>;
  cacheAuthorityId: string;
}

export interface DependencyInstallReceipt {
  recipe: DependencyInstallRecipe;
  /** Absolute package-manager binary that produced this view. */
  packageManagerExecutable: string;
  privateViewVerified: boolean;
  completedAt: string;
  cacheRetention?: DependencyCacheRetentionReceipt;
}

export { DependencyAuthenticationUnsupportedError } from './dependency-manager-config';

export function isDependencyAuthenticationUnsupportedError(error: unknown): error is DependencyAuthenticationUnsupportedError {
  const candidate = error as { code?: unknown; message?: unknown; name?: unknown };
  return candidate?.code === 'dependency_authentication_unsupported'
    && candidate.message === 'Credential-bearing package-manager configuration is unsupported for public dependency installs.'
    && candidate.name === 'DependencyAuthenticationUnsupportedError';
}

export interface DependencyInstallOptions {
  run?: (invocation: DependencyInstallInvocation) => Promise<void>;
  resolveVersion?: (manager: SupportedPackageManager) => Promise<string>;
  cacheRoot?: string;
  cachePolicy?: DependencyCachePolicy;
  now?: () => Date;
  materializationIdentity?: WorktreeMaterializationIdentity;
  /** Recipe derived at the same pinned setup boundary, before execution. */
  preparedRecipe?: DependencyInstallRecipe;
  runtimeFacts?: {
    abi: string;
    platform: NodeJS.Platform;
    architecture: string;
  };
  /** Deterministic safety seam after exact runtime capture and before namespace retirement. */
  afterRuntimeTreeCapture?: (runtimePath: string) => Promise<void>;
}

interface ParsedInstallCommand {
  manager: SupportedPackageManager;
  args: string[];
}

const LOCKFILES: Record<SupportedPackageManager, readonly string[]> = {
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb'],
};

const ALLOWED_INSTALL_FLAGS: Record<SupportedPackageManager, ReadonlySet<string>> = {
  npm: new Set([
    '--prefer-offline', '--offline', '--ignore-scripts', '--foreground-scripts',
    '--no-audit', '--audit=false', '--no-fund', '--fund=false',
    '--include=dev', '--include=optional', '--omit=dev', '--omit=optional', '--omit=peer',
    '--strict-peer-deps', '--legacy-peer-deps', '--workspaces', '--include-workspace-root',
  ]),
  pnpm: new Set([
    '--frozen-lockfile', '--prefer-offline', '--offline', '--ignore-scripts',
    '--prod', '--dev', '--no-optional', '--strict-peer-dependencies', '--workspace-root',
  ]),
  yarn: new Set([
    '--immutable', '--immutable-cache', '--check-cache', '--frozen-lockfile',
    '--offline', '--ignore-scripts',
  ]),
  bun: new Set([
    '--frozen-lockfile', '--offline', '--ignore-scripts', '--production', '--development',
  ]),
};

const SAFE_HOST_ENV_NAMES = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'COMSPEC',
  'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
] as const;

function digestBytes(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function digestJson(value: unknown): string {
  return digestBytes(JSON.stringify(value));
}

function pathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseInstallCommand(command: string): ParsedInstallCommand {
  const trimmed = command.trim();
  if (!trimmed) throw new Error('Dependency install command is empty.');
  if (/[\r\n\0'"`\\;&|<>$(){}[\]*?!~]/.test(trimmed)) {
    throw new Error('Dependency install command requires unsupported shell syntax.');
  }
  const tokens = trimmed.split(/\s+/);
  const executable = tokens.shift()!;
  if (!/^(?:npm|pnpm|yarn|bun)(?:\.exe)?$/.test(executable)) {
    throw new Error(`Unsupported package-manager executable: ${executable}`);
  }
  const manager = executable.replace(/\.exe$/, '') as SupportedPackageManager;
  if (!Object.hasOwn(LOCKFILES, manager)) {
    throw new Error(`Unsupported package manager in saved install command: ${executable}`);
  }
  const args = tokens;
  const subcommand = args[0];
  const allowedSubcommands: Record<SupportedPackageManager, readonly string[]> = {
    npm: ['ci', 'install', 'i'],
    pnpm: ['install', 'i'],
    yarn: ['install'],
    bun: ['install', 'i'],
  };
  if (!subcommand || !allowedSubcommands[manager].includes(subcommand)) {
    throw new Error(`Saved ${manager} command is not an install contract.`);
  }
  for (const arg of args.slice(1)) {
    if (!ALLOWED_INSTALL_FLAGS[manager].has(arg)) {
      throw new Error(`Saved ${manager} install contract has an unsupported argument: ${arg}`);
    }
  }
  return { manager, args };
}

async function regularFileBytes(root: string, relativePath: string): Promise<Buffer> {
  const absolutePath = path.join(root, relativePath);
  const entry = await lstat(absolutePath);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`Dependency recipe input is not a regular file: ${relativePath}`);
  }
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(absolutePath);
  if (!pathInside(canonicalPath, canonicalRoot)) {
    throw new Error(`Dependency recipe input escapes its workspace: ${relativePath}`);
  }
  return readFile(absolutePath);
}

async function trackedFiles(workspacePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
    cwd: workspacePath,
    encoding: 'buffer',
    timeout: 15_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout.toString('utf8').split('\0').filter(Boolean).sort();
}

async function committedTreeReceipt(workspacePath: string): Promise<string> {
  const [tree, status] = await Promise.all([
    execFileAsync('git', ['rev-parse', '--verify', 'HEAD^{tree}'], {
      cwd: workspacePath,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    }),
    execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=no'], {
      cwd: workspacePath,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    }),
  ]);
  const treeSha = tree.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(treeSha) || status.stdout.trim()) {
    throw new Error('Dependency recipe requires an exact clean committed Git tree.');
  }
  return treeSha;
}

function packageManagerField(bytes: Buffer): string | null {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as { packageManager?: unknown };
    return typeof parsed.packageManager === 'string' ? parsed.packageManager.trim() : null;
  } catch {
    throw new Error('Root package.json is not valid JSON.');
  }
}

function parsePackageManagerDeclaration(
  value: string | null,
): { manager: SupportedPackageManager; version: string | null } | null {
  if (!value) return null;
  const match = /^(npm|pnpm|yarn|bun)(?:@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+sha(?:224|256|384|512)\.[0-9A-Fa-f]+)?)?$/.exec(value);
  if (!match?.[1]) throw new Error('package.json packageManager is not canonical.');
  return {
    manager: match[1] as SupportedPackageManager,
    version: match[2] ?? null,
  };
}

function localSpecifiers(bytes: Buffer): string[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('A workspace package.json is not valid JSON.');
  }
  const groups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'resolutions'];
  const result: string[] = [];
  for (const group of groups) {
    const value = parsed[group];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const specifier of Object.values(value)) {
      if (typeof specifier === 'string'
        && (specifier.startsWith('file:')
          || specifier.startsWith('link:')
          || specifier.startsWith('workspace:'))) {
        result.push(specifier);
      }
    }
  }
  return result.sort();
}

async function localDependencyDigests(
  workspacePath: string,
  manifestInputs: readonly { path: string; bytes: Buffer }[],
): Promise<Array<{ identity: string; digest: string }>> {
  const result: Array<{ identity: string; digest: string }> = [];
  const canonicalRoot = await realpath(workspacePath);
  for (const manifest of manifestInputs) {
    for (const specifier of localSpecifiers(manifest.bytes)) {
      if (specifier.startsWith('workspace:')) {
        result.push({ identity: `${manifest.path}:${specifier}`, digest: digestBytes(specifier) });
        continue;
      }
      const targetText = specifier.slice(specifier.indexOf(':') + 1);
      const manifestDirectory = path.dirname(path.join(workspacePath, manifest.path));
      const targetPath = path.resolve(manifestDirectory, targetText);
      let canonicalTarget: string;
      try {
        canonicalTarget = await realpath(targetPath);
      } catch {
        throw new Error(`Local dependency target is unavailable: ${manifest.path}:${specifier}`);
      }
      if (!pathInside(canonicalTarget, canonicalRoot)) {
        throw new Error(`Local dependency escapes its workspace: ${manifest.path}:${specifier}`);
      }
      const relativeTarget = path.relative(workspacePath, targetPath).replaceAll(path.sep, '/');
      const entries = await trackedGitEntries(workspacePath, relativeTarget);
      if (entries.length === 0) {
        throw new Error(`Local dependency has no tracked identity: ${manifest.path}:${specifier}`);
      }
      await assertContainedTrackedSymlinks(workspacePath, entries);
      const hash = createHash('sha256');
      for (const entry of entries) {
        hash.update(entry.mode);
        hash.update('\0');
        hash.update(entry.objectId);
        hash.update('\0');
        hash.update(entry.path);
        hash.update('\0');
      }
      result.push({ identity: `${manifest.path}:${specifier}`, digest: hash.digest('hex') });
    }
  }
  return result.sort((left, right) => left.identity.localeCompare(right.identity));
}

export async function detectDependencyInstallCommand(
  workspacePath: string,
  inputs?: {
    readPackage: () => Promise<Buffer | null>;
    hasLockfile: (name: string) => Promise<boolean>;
  },
): Promise<string | null> {
  let packageBytes: Buffer;
  try {
    const bytes = inputs ? await inputs.readPackage() : await regularFileBytes(workspacePath, 'package.json');
    if (!bytes) return null;
    packageBytes = bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const declaration = parsePackageManagerDeclaration(packageManagerField(packageBytes));
  const declared = declaration?.manager;
  const present: SupportedPackageManager[] = [];
  for (const manager of Object.keys(LOCKFILES) as SupportedPackageManager[]) {
    for (const lockfile of LOCKFILES[manager]) {
      try {
        if (inputs) {
          if (!await inputs.hasLockfile(lockfile)) continue;
        } else {
          await lstat(path.join(workspacePath, lockfile));
        }
        present.push(manager);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  const unique = [...new Set(present)];
  if (declared && unique.some((manager) => manager !== declared)) {
    throw new Error('Package-manager declaration conflicts with the repository lockfile.');
  }
  if (!declared && unique.length > 1) {
    throw new Error('Repository has conflicting package-manager lockfiles.');
  }
  const manager = declared ?? unique[0];
  if (!manager) return null;
  return dependencyInstallCommandForManager(
    manager,
    declaration?.version ?? null,
    unique.includes(manager),
  );
}

export async function deriveDependencyInstallRecipe(
  workspacePath: string,
  installCommand: string,
  options: Pick<DependencyInstallOptions, 'resolveVersion' | 'runtimeFacts'> = {},
): Promise<DependencyInstallRecipe> {
  const parsed = parseInstallCommand(installCommand);
  const lifecycleScripts = parsed.args.some((arg) => (
    arg === '--ignore-scripts'
      || arg === '--ignore-scripts=true'
  )) ? 'disabled' as const : 'enabled' as const;
  const initialTreeSha = await committedTreeReceipt(workspacePath);
  const tracked = await trackedFiles(workspacePath);
  for (const configName of RECIPE_CONFIG_NAMES) {
    if (configName === 'package.json' || tracked.includes(configName)) continue;
    try {
      await lstat(path.join(workspacePath, configName));
      assertSafeDependencyManagerConfig(
        configName,
        await regularFileBytes(workspacePath, configName),
      );
      throw new Error(`Dependency manager config must be tracked: ${configName}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const lockCandidates = LOCKFILES[parsed.manager].filter((candidate) => tracked.includes(candidate));
  if (lockCandidates.length !== 1) {
    throw new Error(`Saved ${parsed.manager} install contract requires exactly one tracked lockfile.`);
  }
  const otherLocks = (Object.entries(LOCKFILES) as Array<[SupportedPackageManager, readonly string[]]>)
    .filter(([manager]) => manager !== parsed.manager)
    .flatMap(([, names]) => names)
    .filter((candidate) => tracked.includes(candidate));
  if (otherLocks.length > 0) {
    throw new Error(`Saved ${parsed.manager} install contract conflicts with another tracked lockfile.`);
  }
  const inputPathSet = new Set(tracked.filter((entry) => {
    const basename = path.posix.basename(entry);
    return basename === 'package.json'
      || RECIPE_CONFIG_NAMES.has(entry)
      || entry.startsWith('patches/')
      || entry.startsWith('.yarn/patches/')
      || entry.startsWith('.yarn/plugins/')
      || entry.startsWith('.yarn/releases/')
      || entry.endsWith('.patch');
  }));
  if (parsed.manager === 'yarn' && tracked.includes('.yarnrc.yml')) {
    const configBytes = await regularFileBytes(workspacePath, '.yarnrc.yml');
    for (const target of yarnExecutionTargets(configBytes)) {
      const normalized = assertContainedConfigTarget(workspacePath, target);
      if (!tracked.includes(normalized)) {
        throw new Error(`Yarn executable config target must be tracked: ${normalized}`);
      }
      inputPathSet.add(normalized);
    }
  }
  const inputPaths = [...inputPathSet].sort();
  if (!inputPaths.includes('package.json')) throw new Error('Dependency recipe has no tracked package.json.');
  const inputs = await Promise.all(inputPaths.map(async (inputPath) => ({
    path: inputPath,
    bytes: await regularFileBytes(workspacePath, inputPath),
  })));
  for (const input of inputs) assertSafeDependencyManagerConfig(input.path, input.bytes);
  const rootPackage = inputs.find((entry) => entry.path === 'package.json')!;
  const cloneLifecycleInputs = dependencyCloneLifecycleInputs(rootPackage.bytes, tracked);
  for (const inputPath of cloneLifecycleInputs ?? []) {
    if (!inputPathSet.has(inputPath)) inputs.push({ path: inputPath, bytes: await regularFileBytes(workspacePath, inputPath) });
  }
  inputs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const declared = parsePackageManagerDeclaration(packageManagerField(rootPackage.bytes));
  const version = options.resolveVersion
    ? await options.resolveVersion(parsed.manager)
    : (await resolvePackageManagerExecution(
        parsed.manager,
        declared?.version ?? null,
      )).version;
  if (declared) {
    if (declared.manager !== parsed.manager) {
      throw new Error('Saved install command does not match package.json packageManager.');
    }
    if (declared.version && declared.version !== version) {
      throw new Error(`Installed ${parsed.manager} version does not match package.json packageManager.`);
    }
  }
  const lockfilePath = lockCandidates[0]!;
  const lockfileBytes = await regularFileBytes(workspacePath, lockfilePath);
  const inputDigests = inputs.map((entry) => ({
    path: entry.path,
    digest: digestBytes(entry.bytes),
  }));
  const locals = await localDependencyDigests(
    workspacePath,
    inputs.filter((entry) => path.posix.basename(entry.path) === 'package.json'),
  );
  const runtimeFacts = options.runtimeFacts ?? {
    abi: process.versions.modules,
    platform: process.platform,
    architecture: process.arch,
  };
  const unsigned = {
    packageManager: parsed.manager,
    packageManagerVersion: version,
    runtimeAbi: runtimeFacts.abi,
    platform: runtimeFacts.platform,
    architecture: runtimeFacts.architecture,
    installArgs: parsed.args,
    lifecycleScripts,
    gitTreeSha: initialTreeSha,
    ...(cloneLifecycleInputs === null ? {} : { cloneLifecycleInputs }),
    lockfile: { path: lockfilePath, digest: digestBytes(lockfileBytes) },
    inputDigests,
    localDependencyDigests: locals,
  };
  if (await committedTreeReceipt(workspacePath) !== initialTreeSha) {
    throw new Error('Dependency recipe Git tree changed during derivation.');
  }
  const key = digestJson(unsigned);
  return {
    key,
    ...unsigned,
    cacheAuthorityId: `native-download-cache:${parsed.manager}:recipe:${key}`,
  };
}

interface RecipeCacheAuthority {
  root: string;
  cache: string;
}

interface InstallRuntimePaths {
  root: string;
  home: string;
  config: string;
  xdgCache: string;
  temp: string;
  corepack: string;
  emptyUserConfig: string;
  emptyGlobalConfig: string;
  device: number;
  inode: number;
}

async function createInstallRuntime(
  workspacePath: string,
  workspaceIdentity: WorktreeMaterializationIdentity,
): Promise<InstallRuntimePaths> {
  const rootRelative = `.o8-install-runtime/${randomUUID()}`;
  const rootIdentity = await createPinnedInstallRuntime(workspacePath, workspaceIdentity, rootRelative);
  const root = path.join(workspacePath, rootRelative);
  const paths: InstallRuntimePaths = {
    root,
    home: path.join(root, 'home'),
    config: path.join(root, 'config'),
    xdgCache: path.join(root, 'xdg-cache'),
    temp: path.join(root, 'tmp'),
    corepack: path.join(root, 'corepack'),
    emptyUserConfig: path.join(root, 'config', 'user.rc'),
    emptyGlobalConfig: path.join(root, 'config', 'global.rc'),
    device: rootIdentity.device,
    inode: rootIdentity.inode,
  };
  return paths;
}

async function retireInstallRuntime(
  runtime: InstallRuntimePaths,
  afterTreeCapture?: DependencyInstallOptions['afterRuntimeTreeCapture'],
): Promise<void> {
  await purgeExactDirectory(
    runtime.root,
    { device: runtime.device, inode: runtime.inode },
    undefined,
    afterTreeCapture,
  );
}

function isolatedInstallEnvironment(runtime: InstallRuntimePaths): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
  for (const name of SAFE_HOST_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.HOME = runtime.home;
  env.USERPROFILE = runtime.home;
  env.XDG_CONFIG_HOME = runtime.config;
  env.XDG_CACHE_HOME = runtime.xdgCache;
  env.COREPACK_HOME = runtime.corepack;
  env.TMPDIR = runtime.temp;
  env.TMP = runtime.temp;
  env.TEMP = runtime.temp;
  return env;
}

function nativeInvocation(
  workspacePath: string,
  recipe: DependencyInstallRecipe,
  authority: RecipeCacheAuthority,
  runtime: InstallRuntimePaths,
  executable: string,
): DependencyInstallInvocation {
  const env = isolatedInstallEnvironment(runtime);
  const args = [...recipe.installArgs];
  if (recipe.packageManager === 'npm') {
    env.npm_config_cache = authority.cache;
    env.npm_config_userconfig = runtime.emptyUserConfig;
    env.npm_config_globalconfig = runtime.emptyGlobalConfig;
    env.npm_config_prefer_offline = 'true';
  } else if (recipe.packageManager === 'pnpm') {
    env.npm_config_userconfig = runtime.emptyUserConfig;
    env.npm_config_globalconfig = runtime.emptyGlobalConfig;
    args.push('--store-dir', authority.cache, '--package-import-method=copy');
  } else if (recipe.packageManager === 'yarn') {
    env.YARN_CACHE_FOLDER = authority.cache;
    env.YARN_ENABLE_GLOBAL_CACHE = 'true';
    env.YARN_GLOBAL_FOLDER = authority.cache;
    env.YARN_NODE_LINKER = 'node-modules';
  } else {
    env.BUN_INSTALL_CACHE_DIR = authority.cache;
  }
  return {
    command: executable,
    args,
    cwd: workspacePath,
    timeoutMs: 45 * 60_000,
    env,
  };
}

async function defaultRun(
  invocation: DependencyInstallInvocation,
  identity?: WorktreeMaterializationIdentity,
): Promise<void> {
  const guarded = guardedWorkspaceInvocation(
    invocation.command,
    invocation.args,
    identity ?? null,
  );
  await execDependencyInstallProcess(guarded.command, guarded.args, {
    cwd: invocation.cwd,
    timeout: invocation.timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: invocation.env,
    signal: invocation.signal,
  });
}

interface InstalledHardlinkAudit {
  path: string;
  nlink: number;
  internal: number;
}

async function auditInstalledEntry(
  workspacePath: string,
  absolutePath: string,
  hardlinks: Map<string, InstalledHardlinkAudit | number>,
): Promise<string[]> {
  const entry = await lstat(absolutePath);
  if (entry.isSymbolicLink()) {
    const target = await realpath(absolutePath);
    if (!pathInside(target, await realpath(workspacePath))) {
      throw new Error(`Installed dependency link escapes its private workspace: ${path.relative(workspacePath, absolutePath)}`);
    }
    return [];
  }
  if (entry.isFile()) {
    const key = `${entry.dev}:${entry.ino}`;
    const audited = hardlinks.get(key);
    // Retain EVERY inode and its count. A number encodes internal count with
    // observed nlink <= 1; promote it if any later observation has more links.
    // This keeps the same accounting without retaining private file paths.
    if (typeof audited === 'number') {
      hardlinks.set(key, entry.nlink > 1
        ? { path: absolutePath, nlink: entry.nlink, internal: audited + 1 }
        : audited + 1);
    } else if (audited) {
      audited.internal += 1;
      audited.nlink = Math.max(audited.nlink, entry.nlink);
    } else {
      hardlinks.set(key, entry.nlink > 1 ? { path: absolutePath, nlink: entry.nlink, internal: 1 } : 1);
    }
    return [];
  }
  if (!entry.isDirectory()) return [];
  const children = await readdir(absolutePath);
  return children.map((child) => path.join(absolutePath, child));
}

export async function auditPrivateDependencyView(workspacePath: string): Promise<void> {
  const nodeModules = path.join(workspacePath, 'node_modules');
  let root;
  try {
    root = await lstat(nodeModules);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Package-manager install completed without a private node_modules view.');
    }
    throw error;
  }
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o200) === 0) {
    throw new Error('Installed dependency view is not a private writable directory.');
  }
  const hardlinks = new Map<string, InstalledHardlinkAudit | number>();
  const pending = [nodeModules];
  const waiting: Array<() => void> = [];
  let active = 0;
  let failed = false;
  let failure: unknown;
  // Fixed workers avoid batch barriers without unbounded filesystem pressure.
  const worker = async () => {
    while (!failed) {
      const entry = pending.pop();
      if (!entry) {
        if (!active) return;
        await new Promise<void>((resolve) => { waiting.push(resolve); });
        continue;
      }
      active += 1;
      try {
        for (const child of await auditInstalledEntry(workspacePath, entry, hardlinks)) pending.push(child);
      }
      catch (error) { failed = true; failure = error; }
      finally { active -= 1; for (const resume of waiting.splice(0)) resume(); }
    }
  };
  // Every in-flight read settles before failure can retire the private runtime.
  await Promise.all(Array.from({ length: 32 }, worker));
  if (failed) throw failure;
  for (const audited of hardlinks.values()) {
    if (typeof audited !== 'number' && audited.nlink > 1 && audited.internal < audited.nlink) {
      throw new Error(
        `Installed dependency uses a shared hardlink: ${path.relative(workspacePath, audited.path)} (nlink=${audited.nlink}, internal=${audited.internal})`,
      );
    }
  }
}

export async function runDependencyInstall(
  workspacePath: string,
  installCommand: string,
  options: DependencyInstallOptions = {},
): Promise<DependencyInstallReceipt> {
  const parsed = parseInstallCommand(installCommand);
  const recipe = options.preparedRecipe
    ?? await deriveDependencyInstallRecipe(workspacePath, installCommand, options);
  if (recipe.packageManager !== parsed.manager
    || JSON.stringify(recipe.installArgs) !== JSON.stringify(parsed.args)) {
    throw new Error('Prepared dependency recipe does not match the saved install command.');
  }
  const cacheRoot = path.resolve(options.cacheRoot ?? dependencyCacheRoot());
  const execution = await resolveReceiptedPackageManagerExecution(
    recipe.packageManager,
    recipe.packageManagerVersion,
    Boolean(options.resolveVersion),
  );
  const materializationIdentity = options.materializationIdentity
    ?? await captureWorktreeMaterializationIdentity(workspacePath);
  const authority = await acquireDependencyCache(cacheRoot, recipe, options.cachePolicy);
  let runtime: InstallRuntimePaths | undefined;
  let receipt: DependencyInstallReceipt | undefined;
  let executionStarted = false;
  let executionFinished = false;
  try {
    runtime = await createInstallRuntime(workspacePath, materializationIdentity);
    const invocation = nativeInvocation(
      workspacePath, recipe, authority, runtime, execution.executable,
    );
    await timedDependencyInstall((signal) => {
      executionStarted = true;
      return options.run ? options.run({ ...invocation, signal })
        : defaultRun({ ...invocation, signal }, options.materializationIdentity);
    });
    executionFinished = true;
    await ensurePinnedWorkspaceDirectory(workspacePath, materializationIdentity, 'node_modules');
    await auditPrivateDependencyView(workspacePath);
    receipt = {
      recipe,
      packageManagerExecutable: execution.executable,
      privateViewVerified: true,
      completedAt: (options.now ?? (() => new Date()))().toISOString(),
    };
    return receipt;
  } catch (error) {
    // Failed installs also release their lease once native teardown has settled.
    executionFinished ||= dependencyInstallProcessesStopped(error);
    throw error;
  } finally {
    try {
      if (runtime) await retireInstallRuntime(runtime, options.afterRuntimeTreeCapture);
    } finally {
      // An unconfirmed teardown or an unresolved custom runner still protects live writers.
      if (!executionStarted || executionFinished) {
        const retention = await authority.release();
        if (receipt) receipt.cacheRetention = retention;
      }
    }
  }
}

export async function measureDependencyTreeBytes(workspacePath: string): Promise<number> {
  const root = path.join(workspacePath, 'node_modules');
  let total = 0;
  async function walk(candidate: string): Promise<void> {
    const entry = await lstat(candidate);
    if (entry.isSymbolicLink()) return;
    if (entry.isFile()) {
      total += entry.size;
      return;
    }
    if (!entry.isDirectory()) return;
    for (const child of await readdir(candidate)) await walk(path.join(candidate, child));
  }
  await stat(root);
  await walk(root);
  return total;
}
