import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execDependencyInstallProcess } from './dependency-install-process';
import { timedDependencyInstall } from './dependency-install-timing';

import { guardedWorkspaceInvocation, materializationAwareExecFile } from '@/lib/worktree/materialization-execution';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { purgeExactDirectory } from './exact-directory-purge';
import { resolveReceiptedPackageManagerExecution } from './dependency-manager-executable';
import type { DependencyInstallOptions, DependencyInstallRecipe } from './dependency-install';
import { profileDependencyClone } from './dependency-clone-profile';

const CREATE_RUNTIME = String.raw`
const fs = require('node:fs');
const name = process.argv[1];
fs.mkdirSync(name, {mode: 0o700});
const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
const receipt = fs.fstatSync(fd);
process.chdir(name);
if (fs.statSync('.').ino !== receipt.ino || fs.statSync('.').dev !== receipt.dev) throw new Error('Lifecycle runtime changed.');
for (const child of ['home', 'config', 'cache', 'tmp', 'corepack']) fs.mkdirSync(child);
for (const child of ['user.rc', 'global.rc']) fs.writeFileSync('config/' + child, '', {flag:'wx'});
console.log(JSON.stringify({device:receipt.dev, inode:receipt.ino}));
fs.closeSync(fd);
`;

/** Replay root lifecycle generation with one private runtime, without installing. */
export async function finishDependencyClone(input: {
  workspace: string;
  identity: WorktreeMaterializationIdentity;
  recipe: DependencyInstallRecipe;
  options: DependencyInstallOptions;
}): Promise<void> {
  const { workspace, identity, recipe, options } = input;
  const execute = async (command: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs = 60_000, signal?: AbortSignal) => {
    const guarded = guardedWorkspaceInvocation(command, args, identity);
    return execDependencyInstallProcess(guarded.command, guarded.args, {
      cwd: workspace, env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, signal,
    });
  };
  if (recipe.lifecycleScripts === 'disabled') return;
  const manifest = JSON.parse(await readFile(path.join(workspace, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
  if (!['preinstall', 'install', 'postinstall'].some((stage) => typeof manifest.scripts?.[stage] === 'string')) return;
  const execution = await resolveReceiptedPackageManagerExecution('npm', recipe.packageManagerVersion, Boolean(options.resolveVersion));
  const name = `.o8-clone-lifecycle-${randomUUID()}`;
  const { stdout } = await profileDependencyClone('lifecycle-runtime', () => execute(process.execPath, ['-e', CREATE_RUNTIME, name]));
  const receipt = JSON.parse(stdout) as {device: number; inode: number};
  const runtime = path.join(workspace, name);
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'COMSPEC', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: path.join(runtime, 'home'), USERPROFILE: path.join(runtime, 'home'),
    XDG_CONFIG_HOME: path.join(runtime, 'config'), XDG_CACHE_HOME: path.join(runtime, 'cache'),
    COREPACK_HOME: path.join(runtime, 'corepack'), TMPDIR: path.join(runtime, 'tmp'),
    TMP: path.join(runtime, 'tmp'), TEMP: path.join(runtime, 'tmp'),
    npm_config_cache: path.join(runtime, 'cache'), npm_config_userconfig: path.join(runtime, 'config/user.rc'),
    npm_config_globalconfig: path.join(runtime, 'config/global.rc'), npm_config_prefer_offline: 'true',
  });
  try {
    const args = ['rebuild', '.', ...recipe.installArgs.slice(1)];
    await profileDependencyClone('lifecycle-execute', () => timedDependencyInstall(async signal => {
      if (options.run) await options.run({ command: execution.executable, args, cwd: workspace, env, timeoutMs: 45 * 60_000, signal });
      else await execute(execution.executable, args, env, 45 * 60_000, signal);
    }));
  } finally {
    await profileDependencyClone('lifecycle-retire', () => purgeExactDirectory(runtime, receipt, undefined, options.afterRuntimeTreeCapture));
  }
}

/** Probe the final bindings, including anything generated or replaced by lifecycle. */
export async function probeDependencyCloneNativeFiles(workspace: string, identity: WorktreeMaterializationIdentity, files: string[]): Promise<void> {
  if (!files.length) return;
  const invocation = guardedWorkspaceInvocation(process.execPath, ['-e',
    "const M=require('node:module'); for(const file of JSON.parse(process.argv[1])) process.dlopen(new M(file),file);",
    JSON.stringify(files.map((file) => path.join(workspace, file))),
  ], identity);
  await profileDependencyClone('native-bindings', () => materializationAwareExecFile(invocation.command, invocation.args, {
    cwd: workspace, timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  }));
}
