import 'server-only';
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getDataDir } from '@/lib/data-dir-migration';
import { withProviderStoreLock } from '@/lib/providers/store-lock';
import { acpEnvironmentId, readAcpEnvironment, resolveAcpEnvironment, saveAcpEnvironment, type AcpEnvironmentBinding } from './connection-environment';
import { createAcpOutputRedactor } from './output-redaction';

export interface LocalAcpConnection { name: string; command: string; args: string[]; useOpenRouter: boolean }
const file = () => join(getDataDir(), 'local-acp.json');
export function parseLocalAcpConnection(value: unknown): LocalAcpConnection {
  const v = value as Partial<LocalAcpConnection> | null;
  if (!v || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 80
    || typeof v.command !== 'string' || !v.command.trim() || v.command.length > 1024 || /[\r\n\0]/.test(v.command)
    || !Array.isArray(v.args) || v.args.length > 128 || v.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))
    || typeof v.useOpenRouter !== 'boolean') throw new Error('Enter a name, executable, and one literal argument per line.');
  return { name: v.name.trim(), command: v.command.trim(), args: v.args, useOpenRouter: v.useOpenRouter };
}
export function readLocalAcpConnection(): LocalAcpConnection | null {
  try { return parseLocalAcpConnection(JSON.parse(readFileSync(file(), 'utf8'))); } catch { return null; }
}
export function saveLocalAcpConnection(value: unknown): LocalAcpConnection | null {
  return withProviderStoreLock(() => {
    const parsed = value === null ? null : parseLocalAcpConnection(value);
    const previous = readLocalAcpConnection();
    mkdirSync(getDataDir(), { recursive: true });
    const temp = `${file()}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(parsed), { mode: 0o600 });
      rmSync(join(getDataDir(), 'acp-models', 'acp.json'), { force: true });
      if (parsed === null && previous) {
        // A failed file replacement rolls the credential deletion back too.
        saveAcpEnvironment(readAcpEnvironment(acpEnvironmentId(previous)), [], () => renameSync(temp, file()));
      } else renameSync(temp, file());
    } finally { rmSync(temp, { force: true }); }
    return parsed;
  });
}
export function resolveLocalAcpLaunch() {
  const command = process.env.O8_ACP_COMMAND?.trim();
  if (command) {
    const raw = process.env.O8_ACP_ARGS?.trim() ?? '';
    const args = raw.startsWith('[') ? JSON.parse(raw) : raw.split(' ').filter(Boolean);
    return parseLocalAcpConnection({ name: 'Local ACP', command, args, useOpenRouter: false });
  }
  return readLocalAcpConnection();
}

/** Resolve explicit credential forwarding at both probe and conversation spawns. */
export function localAcpProcessLaunch() {
  const connection = resolveLocalAcpLaunch();
  return connection ? { ...connection,
    ...(!process.env.O8_ACP_COMMAND?.trim() ? resolveAcpEnvironment(acpEnvironmentId(connection)) : {}),
    omitEnv: connection.useOpenRouter ? [] : ['OPENROUTER_API_KEY'] } : null;
}

export function assertLocalAcpEnvironmentCurrent(binding: AcpEnvironmentBinding): void {
  const connection = readLocalAcpConnection();
  if (process.env.O8_ACP_COMMAND?.trim() || !connection || acpEnvironmentId(connection) !== binding.connectionId
    || readAcpEnvironment(binding.connectionId).revision !== binding.revision) {
    throw new Error('The connection environment changed during preparation. Retry the launch.');
  }
}

/** Call under the spawn lock after validating the exact saved environment revision. */
export function localAcpOutputRedactor(binding: AcpEnvironmentBinding | undefined, env: Record<string, string> = {}) {
  const variables = binding ? readAcpEnvironment(binding.connectionId).variables : [];
  const names = variables.filter(variable => variable.secret).map(variable => variable.name);
  return { ...createAcpOutputRedactor(names.map(name => env[name] ?? '')), secretNames: names };
}

export function acpLaunchFingerprint(launch: { command: string; args: string[]; env?: Record<string, string>; omitEnv?: string[]; localEnvironment?: AcpEnvironmentBinding }): string {
  return createHash('sha256').update(JSON.stringify([launch.command, launch.args, launch.env, launch.omitEnv, launch.localEnvironment])).digest('hex');
}
