// payer policy part c: preserve the detached supervisor and durable output until key-by-reference launch exists.
import { spawn } from '@/lib/providers/child-process';
import { childEnvironment } from '@/lib/providers/spawn-environment';

export const spawnSolo = spawn;
export function soloEnvironment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return childEnvironment({ runtimeId: 'codex', env: overrides });
}
