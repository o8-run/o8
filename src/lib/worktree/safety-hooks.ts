import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  ensurePinnedWorkspaceDirectory,
  ensurePinnedWorkspaceFile,
  inspectPinnedWorkspaceEntry,
  writePinnedWorkspaceFile,
} from './materialization-leaf-io';
import {
  captureWorktreeMaterializationIdentity,
  type WorktreeMaterializationIdentity,
} from './materialization-identity';
import {
  isMaterializationExecutionRefusal,
  materializationAwareExecFile,
  withWorktreeMaterializationExecution,
} from './materialization-execution';

const execFileAsync = materializationAwareExecFile;
const MANAGED_HOOK_NAMES = [
  'claude-code-pretool-hook.js',
  'post-edit-typecheck.js',
  'completion-gate.js',
  'time-ledger.js',
] as const;

export const MANAGED_WORKSPACE_SAFETY_SETTINGS = '.claude/settings.local.json';

export interface ManagedWorkspaceSafetyHookRuntime {
  nodePath: string;
  hookPaths: Record<(typeof MANAGED_HOOK_NAMES)[number], string>;
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function exactExecutable(candidate: string): Promise<string> {
  const canonicalPath = await realpath(candidate);
  const entry = await lstat(canonicalPath);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error('The o8 Node runtime is not an exact executable file.');
  }
  await access(canonicalPath, constants.X_OK);
  return canonicalPath;
}

async function exactHookRoot(candidate: string): Promise<ManagedWorkspaceSafetyHookRuntime['hookPaths'] | null> {
  let canonicalRoot: string;
  try {
    const root = await lstat(candidate);
    if (!root.isDirectory() || root.isSymbolicLink()) return null;
    canonicalRoot = await realpath(candidate);
  } catch {
    return null;
  }
  const result = {} as ManagedWorkspaceSafetyHookRuntime['hookPaths'];
  for (const hookName of MANAGED_HOOK_NAMES) {
    const hookPath = path.join(candidate, hookName);
    try {
      const link = await lstat(hookPath);
      if (!link.isFile() || link.isSymbolicLink()) return null;
      const canonicalPath = await realpath(hookPath);
      const entry = await lstat(canonicalPath);
      if (!entry.isFile() || !canonicalPath.startsWith(`${canonicalRoot}${path.sep}`)) return null;
      await access(canonicalPath, constants.R_OK);
      result[hookName] = canonicalPath;
    } catch {
      return null;
    }
  }
  return result;
}

export async function resolveManagedWorkspaceSafetyHookRuntime(options: {
  runtimeRoot?: string;
  packaged?: boolean;
  nodePath?: string;
} = {}): Promise<ManagedWorkspaceSafetyHookRuntime> {
  const runtimeRoot = path.resolve(options.runtimeRoot ?? process.cwd());
  const packaged = options.packaged ?? process.env.O8_PACKAGED_APP === '1';
  const nodePath = await exactExecutable(
    options.nodePath ?? process.env.O8_NODE_BIN ?? process.execPath,
  );
  const candidates = packaged
    ? [path.join(runtimeRoot, 'hooks')]
    : [path.join(runtimeRoot, 'hooks'), path.join(runtimeRoot, 'dist', 'hooks')];
  for (const candidate of candidates) {
    const hookPaths = await exactHookRoot(candidate);
    if (hookPaths) return { nodePath, hookPaths };
  }
  throw new Error(`The running o8 installation has no complete safety-hook runtime under ${runtimeRoot}.`);
}

async function resolveGitPath(
  cwd: string,
  flag: '--absolute-git-dir' | '--git-common-dir',
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', flag], {
    windowsHide: true,
    cwd,
    timeout: 5_000,
  });
  const candidate = path.resolve(cwd, stdout.trim());
  const link = await lstat(candidate);
  if (!link.isDirectory() || link.isSymbolicLink()) {
    throw new Error('Managed Git administration path is not an exact directory.');
  }
  return realpath(candidate);
}

async function captureManagedGitAdmin(
  o8Root: string,
  worktreePath: string,
  identity: WorktreeMaterializationIdentity,
): Promise<{
  adminPath: string;
  adminIdentity: WorktreeMaterializationIdentity;
  commonPath: string;
  commonIdentity: WorktreeMaterializationIdentity;
}> {
  const resolveWorkspaceGitPath = (flag: '--absolute-git-dir' | '--git-common-dir') => (
    withWorktreeMaterializationExecution(
      worktreePath,
      identity,
      () => resolveGitPath(worktreePath, flag),
    )
  );
  const commonPath = await resolveWorkspaceGitPath('--git-common-dir');
  const adminPath = await resolveWorkspaceGitPath('--absolute-git-dir');
  const workspaceGitPath = path.join(identity.canonicalPath, '.git');
  if (commonPath === workspaceGitPath) {
    const localGit = await inspectPinnedWorkspaceEntry(worktreePath, identity, '.git');
    if (localGit?.kind !== 'directory') {
      throw new Error('Managed clone Git administration escaped the workspace.');
    }
  } else {
    const repoCommonPath = await resolveGitPath(o8Root, '--git-common-dir');
    if (commonPath !== repoCommonPath
      || (adminPath !== commonPath
        && !adminPath.startsWith(`${commonPath}${path.sep}worktrees${path.sep}`))) {
      throw new Error('Managed worktree Git administration escaped its repository.');
    }
  }
  if (adminPath !== commonPath && !adminPath.startsWith(`${commonPath}${path.sep}`)) {
    throw new Error('Managed Git administration is outside its common directory.');
  }
  const adminIdentity = await captureWorktreeMaterializationIdentity(adminPath);
  const commonIdentity = adminPath === commonPath
    ? adminIdentity
    : await captureWorktreeMaterializationIdentity(commonPath);
  if (await resolveWorkspaceGitPath('--git-common-dir') !== commonPath
    || await resolveWorkspaceGitPath('--absolute-git-dir') !== adminPath) {
    throw new Error('Managed Git administration changed during capture.');
  }
  return { adminPath, adminIdentity, commonPath, commonIdentity };
}

async function ensureSafetyHookGitExclusion(
  o8Root: string,
  worktreePath: string,
  identity: WorktreeMaterializationIdentity,
): Promise<{ adminPath: string; adminIdentity: WorktreeMaterializationIdentity }> {
  const gitAdmin = await captureManagedGitAdmin(o8Root, worktreePath, identity);
  await ensurePinnedWorkspaceDirectory(gitAdmin.commonPath, gitAdmin.commonIdentity, 'info');
  const excludeName = `info/o8-managed-excludes-${path.basename(gitAdmin.adminPath)
    .replace(/[^a-zA-Z0-9._-]/g, '-')}`;
  await ensurePinnedWorkspaceFile(
    gitAdmin.commonPath,
    gitAdmin.commonIdentity,
    excludeName,
    `${MANAGED_WORKSPACE_SAFETY_SETTINGS}\n.o8/\n`,
  );
  await withWorktreeMaterializationExecution(
    gitAdmin.commonPath,
    gitAdmin.commonIdentity,
    () => execFileAsync('git', [
      '--git-dir=.',
      'config', 'extensions.worktreeConfig', 'true',
    ], {
      windowsHide: true,
      cwd: gitAdmin.commonPath,
      timeout: 10_000,
    }),
  );
  let existingExclude: string | null = null;
  try {
    const { stdout } = await withWorktreeMaterializationExecution(
      gitAdmin.adminPath,
      gitAdmin.adminIdentity,
      () => execFileAsync('git', [
        '--git-dir=.',
        `--work-tree=${identity.canonicalPath}`,
        'config', '--worktree', '--get', 'core.excludesFile',
      ], {
        windowsHide: true,
        cwd: gitAdmin.adminPath,
        timeout: 10_000,
      }),
    );
    existingExclude = stdout.trim() || null;
  } catch (error) {
    if (isMaterializationExecutionRefusal(error)) throw error;
    const code = error instanceof Error && 'code' in error
      ? Number((error as NodeJS.ErrnoException).code)
      : null;
    if (code !== 1) throw error;
  }
  const excludePath = path.join(gitAdmin.commonPath, excludeName);
  if (existingExclude && path.resolve(existingExclude) !== excludePath) {
    throw new Error('Managed hook injection refuses to replace an existing worktree exclude file.');
  }
  await withWorktreeMaterializationExecution(
    gitAdmin.adminPath,
    gitAdmin.adminIdentity,
    () => execFileAsync('git', [
      '--git-dir=.',
      `--work-tree=${identity.canonicalPath}`,
      'config', '--worktree', 'core.excludesFile', excludePath,
    ], {
      windowsHide: true,
      cwd: gitAdmin.adminPath,
      timeout: 10_000,
    }),
  );
  return { adminPath: gitAdmin.adminPath, adminIdentity: gitAdmin.adminIdentity };
}

function safetyHooksContent(
  runtime: ManagedWorkspaceSafetyHookRuntime,
  timeLedger: boolean,
): string {
  const hook = (hookName: (typeof MANAGED_HOOK_NAMES)[number], timeout: number) => ({
    type: 'command',
    command: `${quoteShellArg(runtime.nodePath)} ${quoteShellArg(runtime.hookPaths[hookName])}`,
    timeout,
  });
  const clock = { hooks: [hook('time-ledger.js', 20)] };
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: '*', hooks: [hook('claude-code-pretool-hook.js', 10)] },
        ...(timeLedger ? [{ matcher: 'Bash', ...clock }] : []),
      ],
      PostToolUse: [
        { matcher: 'Write|Edit|MultiEdit', hooks: [hook('post-edit-typecheck.js', 35)] },
        { matcher: 'Stop|TaskComplete', hooks: [hook('completion-gate.js', 50)] },
        ...(timeLedger ? [{ matcher: 'Bash', ...clock }] : []),
      ],
      ...(timeLedger ? {
        PostToolUseFailure: [{ matcher: 'Bash', ...clock }],
        SessionStart: [clock],
      } : {}),
    },
  }, null, 2);
}

export function managedWorkspaceSafetyHooksContent(
  runtime: ManagedWorkspaceSafetyHookRuntime,
): string {
  return safetyHooksContent(runtime, true);
}

/**
 * The settings o8 generated before the time ledger. A workspace created by an
 * older build still holds these bytes, and cleanup must keep recognizing them
 * as generated.
 */
export function previousManagedWorkspaceSafetyHooksContent(
  runtime: ManagedWorkspaceSafetyHookRuntime,
): string {
  return safetyHooksContent(runtime, false);
}

export async function writeManagedWorkspaceSafetyHooks(
  repositoryPath: string,
  worktreePath: string,
  identity: WorktreeMaterializationIdentity,
): Promise<void> {
  const runtime = await resolveManagedWorkspaceSafetyHookRuntime();
  const existingSettings = await inspectPinnedWorkspaceEntry(
    worktreePath,
    identity,
    MANAGED_WORKSPACE_SAFETY_SETTINGS,
  );
  if (existingSettings) {
    throw new Error(`Managed hook injection refuses to replace existing ${MANAGED_WORKSPACE_SAFETY_SETTINGS}.`);
  }
  const gitAdmin = await ensureSafetyHookGitExclusion(repositoryPath, worktreePath, identity);
  await writePinnedWorkspaceFile(
    worktreePath,
    identity,
    MANAGED_WORKSPACE_SAFETY_SETTINGS,
    managedWorkspaceSafetyHooksContent(runtime),
    undefined,
    null,
  );
  try {
    await withWorktreeMaterializationExecution(
      gitAdmin.adminPath,
      gitAdmin.adminIdentity,
      () => execFileAsync('git', [
        '--git-dir=.',
        `--work-tree=${identity.canonicalPath}`,
        'update-index', '--skip-worktree', MANAGED_WORKSPACE_SAFETY_SETTINGS,
      ], {
        windowsHide: true,
        cwd: gitAdmin.adminPath,
        timeout: 10_000,
      }),
    );
  } catch (error) {
    if (isMaterializationExecutionRefusal(error)) throw error;
    // The generated file is intentionally untracked in most repositories.
  }
}
