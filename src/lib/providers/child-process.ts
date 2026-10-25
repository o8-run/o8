import { assertMcpConfigArguments } from './mcp-config-policy';
/** All application child processes cross this environment and artifact boundary. */
import * as processApi from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertChildArguments, childEnvironmentContext, refreshChildEnvironment, stampChildPolicy } from './spawn-environment';
import { credentialPolicyFingerprint } from './credential-policy';
import { withProviderStoreLock } from './store-lock';
import { assertLegacyRuntimeConfigSelection } from './legacy-runtime-config';
import { recordRuntimeProfileChild } from './runtime-profile-processes';
import { preparedMcpExecutable, verifyMcpExecutable } from './mcp-executable';
export type * from 'node:child_process';

/** Keychain bootstrap cannot read the provider store it unlocks. Inherit nothing. */
export function execKeychainCommand(operation: 'find-generic-password' | 'add-generic-password', args: readonly string[]): string {
  return processApi.execFileSync('/usr/bin/security', [operation, ...args], {
    env: { NODE_ENV: 'production' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

type Operation = 'spawn' | 'spawnSync' | 'execFile' | 'execFileSync' | 'exec' | 'execSync' | 'fork';
function invoke(name: Operation, supplied: unknown[], asPromise = false): unknown {
  const args = [...supplied];
  const hasArgs = Array.isArray(args[1]) || args[1] == null && args.length > 2;
  const index = name === 'exec' || name === 'execSync' ? 1 : hasArgs ? 2 : 1;
  const current = args[index];
  const options = current && typeof current === 'object' ? { ...current as Record<string, unknown> } : {};
  if (typeof current === 'function') args.splice(index, 0, options);
  else args[index] = options;
  const input = options.env as NodeJS.ProcessEnv | undefined;
  const launchArgs = args.filter((arg): arg is string => typeof arg === 'string').concat(Array.isArray(args[1]) ? args[1] as string[] : []);
  return withChildEnvironment(input, launchArgs, env => {
    options.env = env;
    const operation = asPromise ? (processApi[name] as unknown as { [promisify.custom]: (...values: unknown[]) => unknown })[promisify.custom] : processApi[name];
    const executable = preparedMcpExecutable(input);
    if (executable) {
      if (options.shell || name === 'exec' || name === 'execSync' || name === 'fork') throw new Error('MCP launch requires a direct executable.');
      if (process.platform === 'win32' && Array.isArray(args[1]) && args[1][0] === '/d' && args[1][1] === '/c') {
        args[1] = [...args[1]];
        (args[1] as string[])[2] = executable.target;
      } else args[0] = executable.target;
      // No asynchronous work or PATH lookup between this check and OS creation.
      verifyMcpExecutable(executable);
    }
    return Reflect.apply(operation, processApi, args);
  }, !options.shell && name !== 'exec' && name !== 'execSync', options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd as string | undefined);
}

/** Node and native PTY creation share the same synchronous policy boundary. */
export function withChildEnvironment<T>(input: Record<string, string | undefined> | undefined, args: readonly string[], create: (env: Record<string, string>) => T, allowDeferredMcp = false, cwd?: string): T {
  const context = childEnvironmentContext(input);
  const launch = () => {
    if (context?.runtimeId && context.policy !== credentialPolicyFingerprint(context.runtimeId)) {
      throw new Error('Credentials or billing changed during child preparation. Retry the launch.');
    }
    const env = refreshChildEnvironment(input);
    assertChildArguments(args, input, env, allowDeferredMcp);
    assertMcpConfigArguments(args, env, context?.runtimeId, allowDeferredMcp ? input : undefined, { depth: 0, files: new Set(), cwd });
    const profiles = context?.runtimeId || context?.runtimeLaunch ? assertLegacyRuntimeConfigSelection(context.runtimeId, env, args, cwd) : [];
    stampChildPolicy(env);
    const result = create(env);
    recordRuntimeProfileChild(result, context?.runtimeId, profiles, env);
    return result;
  };
  return withProviderStoreLock(launch);
}

export const spawn = ((...args: unknown[]) => invoke('spawn', args)) as typeof processApi.spawn;
export const spawnSync = ((...args: unknown[]) => invoke('spawnSync', args)) as typeof processApi.spawnSync;
export const execFileSync = ((...args: unknown[]) => invoke('execFileSync', args)) as typeof processApi.execFileSync;
export const execSync = ((...args: unknown[]) => invoke('execSync', args)) as typeof processApi.execSync;
export const fork = ((...args: unknown[]) => invoke('fork', args)) as typeof processApi.fork;
function promised(name: 'execFile' | 'exec', args: unknown[]): Promise<{ stdout: unknown; stderr: unknown }> {
  const custom = (processApi[name] as unknown as { [promisify.custom]?: unknown })[promisify.custom];
  if (typeof custom === 'function') return invoke(name, args, true) as Promise<{ stdout: unknown; stderr: unknown }>;
  return new Promise((resolve, reject) => {
    invoke(name, [...args, (error: Error | null, stdout: unknown, stderr: unknown) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    }]);
  });
}
export const execFile: typeof processApi.execFile = ((...args: unknown[]) => invoke('execFile', args)) as typeof processApi.execFile;
Object.defineProperty(execFile, promisify.custom, { value: (...args: unknown[]) => promised('execFile', args) });
export const exec: typeof processApi.exec = ((...args: unknown[]) => invoke('exec', args)) as typeof processApi.exec;
Object.defineProperty(exec, promisify.custom, { value: (...args: unknown[]) => promised('exec', args) });
