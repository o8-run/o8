import { providerSpawnEnvironment } from '@/lib/providers/spawn-environment';
import { workerParentEnvironment } from '@/lib/providers/worker-environment';

/** Resolved owned environments must execute without login/startup files restoring keys. */
export function managedCommandLaunch(shell: string, command: string, inherited: Record<string, string | undefined>, overrides: Record<string, string> = {}, resolvedEnvironment = false) {
  const base = Object.fromEntries(Object.entries(workerParentEnvironment(inherited)).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const mode = inherited.NODE_ENV;
  const nodeEnv: NodeJS.ProcessEnv['NODE_ENV'] = mode === 'development' || mode === 'test' ? mode : 'production';
  if (!resolvedEnvironment) return { file: shell, args: ['-l', '-c', command], env: { ...base, ...overrides, NODE_ENV: nodeEnv } };
  if (process.platform === 'win32') throw new Error('Resolved Windows workers require direct spawn');
  const env = { ...providerSpawnEnvironment(base, { inject: false, clearInherited: true }), ...overrides, BASH_ENV: '', ENV: '' };
  return { file: '/bin/sh', args: ['-c', command], env };
}
