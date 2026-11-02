import { AsyncLocalStorage } from 'node:async_hooks';
/** All application child processes cross this environment and artifact boundary. */
import * as processApi from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { assertChildArguments, childEnvironmentContext, refreshChildEnvironment, stampChildPolicy } from './spawn-environment';
import { credentialPolicyFingerprint } from './credential-policy';
import { withProviderStoreLock } from './store-lock';
import { assertLegacyRuntimeConfigSelection } from './legacy-runtime-config';
import { recordRuntimeProfileChild } from './runtime-profile-processes';
export type * from 'node:child_process';

/** Keychain bootstrap cannot read the provider store it unlocks. Inherit nothing. */
export function execKeychainCommand(operation: 'find-generic-password' | 'add-generic-password', args: readonly string[]): string {
  return processApi.execFileSync('/usr/bin/security', [operation, ...args], {
    env: { NODE_ENV: 'production' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const creationGuard = new AsyncLocalStorage<() => void>();
export function withChildCreationGuard<T>(check: () => void, operation: () => T): T {
  const parent = creationGuard.getStore();
  return creationGuard.run(() => {
    // Inspection subprocesses retain child policy checks without recursively
    // inspecting the worker launch they are meant to validate.
    creationGuard.exit(() => { parent?.(); check(); });
  }, operation);
}

export interface SecretToolResult { code: number | null; stdout: string; stderr: string; missing?: boolean }
const SECRET_TOOL_PATHS = ['/usr/bin/secret-tool', '/usr/local/bin/secret-tool', '/bin/secret-tool'];
const SECRET_TOOL_TIMEOUT_MS = 15_000;

/** Like Keychain bootstrap: secret-tool gets only the session-bus locators, never the provider store. */
function secretToolLaunch(): { path: string; env: NodeJS.ProcessEnv } | null {
  const path = SECRET_TOOL_PATHS.find((candidate) => existsSync(candidate));
  if (!path) return null;
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'HOME']) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return { path, env };
}

const missingSecretTool: SecretToolResult = { code: null, stdout: '', stderr: 'secret-tool is not installed (libsecret-tools)', missing: true };

/** Synchronous `secret-tool` call. Secrets travel over stdin, never argv. */
export function execSecretToolSync(args: readonly string[], input = ''): SecretToolResult {
  const launch = secretToolLaunch();
  if (!launch) return missingSecretTool;
  const result = processApi.spawnSync(launch.path, [...args], {
    env: launch.env, encoding: 'utf8', input, timeout: SECRET_TOOL_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.error ? result.error.message : result.stderr ?? '' };
}

/** Asynchronous `secret-tool` call with the same environment and timeout. */
export function runSecretTool(args: readonly string[], input = ''): Promise<SecretToolResult> {
  const launch = secretToolLaunch();
  if (!launch) return Promise.resolve(missingSecretTool);
  return new Promise((resolve) => {
    const child = processApi.spawn(launch.path, [...args], { env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), SECRET_TOOL_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (stdout.length > 2_000_000) child.kill(); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4_096) stderr += chunk.toString('utf8'); });
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: null, stdout: '', stderr: error.message }); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
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
    const profiles = context?.runtimeId || context?.runtimeLaunch ? assertLegacyRuntimeConfigSelection(context.runtimeId, env, args, cwd, context.metadataRedaction) : [];
    stampChildPolicy(env);
    creationGuard.getStore()?.();
    const result = create(env);
    recordRuntimeProfileChild(result, context?.runtimeId, profiles, env, context?.metadataRedaction);
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
