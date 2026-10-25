import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export interface McpExecutable {
  alias: string;
  target: string;
  aliasStat: string;
  targetStat: string;
}
const failure = () => new Error('MCP executable changed or could not be resolved. Rebuild the launch and retry.');
const identity = (file: string) => {
  const stat = statSync(file, { bigint: true });
  if (!stat.isFile()) throw failure();
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
};

export function captureMcpExecutable(command: string, cwd = process.cwd(), pathValue = process.env.PATH ?? ''): McpExecutable {
  const candidates = path.isAbsolute(command) ? [command]
    : command.includes('/') || command.includes('\\') ? [path.resolve(cwd, command)]
      : pathValue.split(path.delimiter).filter(Boolean).flatMap(directory => {
        const candidate = path.resolve(cwd, directory, command);
        return process.platform === 'win32' && !path.extname(command)
          ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(extension => candidate + extension.toLowerCase())
          : [candidate];
      });
  for (const alias of candidates) {
    try {
      accessSync(alias, constants.X_OK);
      const target = realpathSync(alias);
      return { alias, target, aliasStat: identity(alias), targetStat: identity(target) };
    } catch { /* Resolve once; an unresolved prepared launch will never fall back. */ }
  }
  throw failure();
}

export function verifyMcpExecutable(binding: McpExecutable): void {
  try {
    if (realpathSync(binding.alias) !== binding.target || identity(binding.alias) !== binding.aliasStat
      || identity(binding.target) !== binding.targetStat) throw failure();
  } catch { throw failure(); }
}

const prepared = new WeakMap<object, McpExecutable | null>();
export function bindMcpExecutable(env: object, command: string, pathValue?: string): void {
  try { prepared.set(env, captureMcpExecutable(command, process.cwd(), pathValue)); }
  catch { prepared.set(env, null); }
}

/** Only an in-process configured launch can supply this authority. */
export function preparedMcpExecutable(env: object | undefined): McpExecutable | undefined {
  if (!env || !prepared.has(env)) return undefined;
  const binding = prepared.get(env);
  if (!binding) throw failure();
  return binding;
}

/** Kept identical to the synchronous check at the application spawn boundary. */
export const MCP_EXECUTABLE_CHECK_SCRIPT = String.raw`
function verifyMcpExecutable(binding) {
  const fs = require('node:fs');
  const identity = file => {
    const stat = fs.statSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error('MCP executable is invalid.');
    return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  };
  if (fs.realpathSync(binding.alias) !== binding.target || identity(binding.alias) !== binding.aliasStat
    || identity(binding.target) !== binding.targetStat) throw new Error('MCP executable changed. Retry the launch.');
}
`;
