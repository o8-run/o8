import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from '@/lib/providers/child-process';
import { assertContainedTrackedSymlinks, trackedGitEntries } from './dependency-recipe-git-identity';
import { assertContainedConfigTarget, assertSafeDependencyManagerConfig, RECIPE_CONFIG_NAMES, yarnExecutionTargets } from './dependency-manager-config';
import { resolvePackageManagerExecution } from './dependency-manager-executable';
import { dependencyCloneLifecycleInputs } from './dependency-clone-inputs';
import type { DependencyInstallOptions, DependencyInstallRecipe, SupportedPackageManager } from './dependency-install';

const execFileAsync = promisify(execFile);

interface ParsedInstallCommand {
  manager: SupportedPackageManager;
  args: string[];
}

export const LOCKFILES: Record<SupportedPackageManager, readonly string[]> = {
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

export function parseInstallCommand(command: string): ParsedInstallCommand {
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

export async function regularFileBytes(root: string, relativePath: string): Promise<Buffer> {
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

export function packageManagerField(bytes: Buffer): string | null {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as { packageManager?: unknown };
    return typeof parsed.packageManager === 'string' ? parsed.packageManager.trim() : null;
  } catch {
    throw new Error('Root package.json is not valid JSON.');
  }
}

export function parsePackageManagerDeclaration(
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

export async function deriveDependencyInstallRecipe(
  workspacePath: string,
  installCommand: string,
  options: Pick<DependencyInstallOptions, 'resolveVersion' | 'runtimeFacts'> = {},
): Promise<DependencyInstallRecipe> {
  // Preserve command validation before inspecting the workspace.
  parseInstallCommand(installCommand);
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
  return buildDependencyInstallRecipe(workspacePath, installCommand, options, {
    tracked,
    treeSha: initialTreeSha,
    read: (relativePath) => regularFileBytes(workspacePath, relativePath),
    localDigests: (manifests) => localDependencyDigests(workspacePath, manifests),
    verify: async () => {
      if (await committedTreeReceipt(workspacePath) !== initialTreeSha) {
        throw new Error('Dependency recipe Git tree changed during derivation.');
      }
    },
  });
}

interface RecipeInputSource {
  tracked: string[];
  treeSha: string;
  read: (relativePath: string) => Promise<Buffer>;
  localDigests: (manifests: Array<{ path: string; bytes: Buffer }>) => Promise<Array<{ identity: string; digest: string }>>;
  verify: () => Promise<void>;
}

async function buildDependencyInstallRecipe(
  workspacePath: string,
  installCommand: string,
  options: Pick<DependencyInstallOptions, 'resolveVersion' | 'runtimeFacts'>,
  source: RecipeInputSource,
): Promise<DependencyInstallRecipe> {
  const parsed = parseInstallCommand(installCommand);
  const lifecycleScripts = parsed.args.some((arg) => (
    arg === '--ignore-scripts' || arg === '--ignore-scripts=true'
  )) ? 'disabled' as const : 'enabled' as const;
  const { tracked } = source;
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
    const configBytes = await source.read('.yarnrc.yml');
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
    bytes: await source.read(inputPath),
  })));
  for (const input of inputs) assertSafeDependencyManagerConfig(input.path, input.bytes);
  const rootPackage = inputs.find((entry) => entry.path === 'package.json')!;
  const cloneLifecycleInputs = dependencyCloneLifecycleInputs(rootPackage.bytes, tracked);
  for (const inputPath of cloneLifecycleInputs ?? []) {
    if (!inputPathSet.has(inputPath)) inputs.push({ path: inputPath, bytes: await source.read(inputPath) });
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
  const lockfileBytes = await source.read(lockfilePath);
  const inputDigests = inputs.map((entry) => ({
    path: entry.path,
    digest: digestBytes(entry.bytes),
  }));
  const locals = await source.localDigests(
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
    gitTreeSha: source.treeSha,
    ...(cloneLifecycleInputs === null ? {} : { cloneLifecycleInputs }),
    lockfile: { path: lockfilePath, digest: digestBytes(lockfileBytes) },
    inputDigests,
    localDependencyDigests: locals,
  };
  await source.verify();
  const key = digestJson(unsigned);
  return {
    key,
    ...unsigned,
    cacheAuthorityId: `native-download-cache:${parsed.manager}:recipe:${key}`,
  };
}

/** Derive target inputs from an immutable commit without checking out or reading donor files. */
export async function deriveDependencyInstallRecipeAtCommit(
  repoPath: string,
  creationBaseCommit: string,
  installCommand: string,
  options: Pick<DependencyInstallOptions, 'resolveVersion' | 'runtimeFacts'> = {},
): Promise<DependencyInstallRecipe> {
  parseInstallCommand(installCommand);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(creationBaseCommit)) {
    throw new Error('Dependency recipe requires an immutable full Git commit identity.');
  }
  const git = async (args: string[]): Promise<Buffer> => {
    const { stdout } = await execFileAsync('git', ['--no-replace-objects', ...args], {
      cwd: repoPath,
      encoding: 'buffer',
      timeout: 15_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: { PATH: process.env.PATH ?? process.env.Path, SystemRoot: process.env.SystemRoot, GIT_NO_LAZY_FETCH: '1' },
    });
    return stdout;
  };
  if ((await git(['cat-file', '-t', creationBaseCommit])).toString('utf8').trim() !== 'commit') {
    throw new Error('Dependency recipe identity must name a Git commit object.');
  }
  const treeSha = (await git(['rev-parse', '--verify', `${creationBaseCommit}^{tree}`])).toString('utf8').trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(treeSha)) {
    throw new Error('Dependency recipe commit has an invalid Git tree identity.');
  }
  const treeBytes = await git(['ls-tree', '-rz', '--full-tree', treeSha]);
  if (!Buffer.from(treeBytes.toString('utf8')).equals(treeBytes)) {
    throw new Error('Dependency recipe commit contains an unsupported Git tree path encoding.');
  }
  const entries = new Map<string, { mode: string; objectId: string }>();
  for (const record of treeBytes.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/.exec(record);
    const name = match?.[3];
    if (!match || !name || path.posix.normalize(name) !== name || path.posix.isAbsolute(name)
      || name.includes('\\') || name.split('/').some((part) => ['.', '..', '.git', ''].includes(part))) {
      throw new Error('Dependency recipe commit contains an unsupported Git tree entry.');
    }
    entries.set(name, { mode: match[1]!, objectId: match[2]! });
  }
  return buildDependencyInstallRecipe(repoPath, installCommand, options, {
    tracked: [...entries.keys()].sort(),
    treeSha,
    read: async (relativePath) => {
      const entry = entries.get(relativePath);
      if (!entry || !['100644', '100755'].includes(entry.mode)) {
        throw new Error(`Dependency recipe input is not a regular file: ${relativePath}`);
      }
      return git(['cat-file', 'blob', entry.objectId]);
    },
    localDigests: async (manifests) => {
      if (manifests.some((manifest) => localSpecifiers(manifest.bytes).length > 0)) {
        throw new Error('Immutable dependency recipes do not support local dependency or workspace dependency inputs.');
      }
      return [];
    },
    verify: async () => {},
  });
}
