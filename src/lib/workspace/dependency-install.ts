import { randomUUID } from 'node:crypto';
import { dependencyInstallProcessesStopped, execDependencyInstallProcess } from './dependency-install-process';
import { timedDependencyInstall } from './dependency-install-timing';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

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
import { dependencyInstallCommandForManager } from './dependency-manager-contract';
import { DependencyAuthenticationUnsupportedError } from './dependency-manager-config';
import {
  resolveReceiptedPackageManagerExecution,
} from './dependency-manager-executable';
import { dependencyCacheRoot } from './dependency-cache-root';
import { acquireDependencyCache, type DependencyCachePolicy, type DependencyCacheRetentionReceipt } from './dependency-cache-retention';
import {
  deriveDependencyInstallRecipe,
  LOCKFILES,
  packageManagerField,
  parseInstallCommand,
  parsePackageManagerDeclaration,
  regularFileBytes,
} from './dependency-recipe-commit';
export { deriveDependencyInstallRecipe, deriveDependencyInstallRecipeAtCommit } from './dependency-recipe-commit';

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

const SAFE_HOST_ENV_NAMES = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'COMSPEC',
  'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
] as const;

function pathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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
