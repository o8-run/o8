import { childEnvironment } from '@/lib/providers/spawn-environment';

export function terminalToolEnv(): NodeJS.ProcessEnv {
  return childEnvironment({ inject: false, env: { NODE_ENV: process.env.NODE_ENV ?? 'development' } });
}
