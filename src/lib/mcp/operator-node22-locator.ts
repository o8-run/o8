import { ambientChildEnvironment } from '@/lib/providers/ambient-environment';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const NODE22_REEXEC_GUARD = 'O8_MCP_REEXECED';

export type Node22ReexecPlan =
  | { action: 'proceed'; reason: 'already-node-22' | 'guarded' }
  | { action: 'reexec'; nodePath: string; argv: string[] }
  | { action: 'warn'; message: string };

type VersionReader = (candidate: string) => string | null;
type EnvMap = Record<string, string | undefined>;

export interface Node22LocatorOptions {
  env?: EnvMap;
  homeDir?: string;
  readVersion?: VersionReader;
}

export interface Node22PlanOptions extends Node22LocatorOptions {
  currentNodeVersion?: string;
  argv?: string[];
  execArgv?: string[];
}

function nodeMajor(version: string | undefined): number | null {
  const match = version?.match(/^v?(\d+)\./);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isFinite(major) ? major : null;
}

function defaultReadVersion(candidate: string): string | null {
  try {
    return execFileSync(candidate, ['--version'], {
      windowsHide: true,
      env: ambientChildEnvironment(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

function isNode22(candidate: string, readVersion: VersionReader): boolean {
  if (!candidate || !existsSync(candidate)) return false;
  return nodeMajor(readVersion(candidate) ?? undefined) === 22;
}

function sortedDirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function* versionedNodeCandidates(homeDir: string): Generator<string> {
  const nvmRoot = join(homeDir, '.nvm', 'versions', 'node');
  for (const name of sortedDirNames(nvmRoot)) {
    if (name.startsWith('v22')) {
      yield join(nvmRoot, name, 'bin', 'node');
    }
  }

  const fnmRoot = join(homeDir, '.fnm', 'node-versions');
  for (const name of sortedDirNames(fnmRoot)) {
    if (name.startsWith('v22')) {
      yield join(fnmRoot, name, 'bin', 'node');
      yield join(fnmRoot, name, 'installation', 'bin', 'node');
    }
  }

  const voltaRoot = join(homeDir, '.volta', 'tools', 'image', 'node');
  for (const name of sortedDirNames(voltaRoot)) {
    if (name.startsWith('22')) {
      yield join(voltaRoot, name, 'bin', 'node');
    }
  }

  yield '/opt/homebrew/opt/node@22/bin/node';
  yield '/usr/local/opt/node@22/bin/node';
}

export function findNode22Binary(options: Node22LocatorOptions = {}): string | null {
  const env = options.env ?? process.env;
  const readVersion = options.readVersion ?? defaultReadVersion;

  if (env.O8_NODE_BIN && isNode22(env.O8_NODE_BIN, readVersion)) {
    return env.O8_NODE_BIN;
  }

  const homeDir = options.homeDir ?? homedir();
  for (const candidate of versionedNodeCandidates(homeDir)) {
    if (isNode22(candidate, readVersion)) {
      return candidate;
    }
  }
  return null;
}

export function buildNode22ReexecPlan(options: Node22PlanOptions = {}): Node22ReexecPlan {
  const env = options.env ?? process.env;
  const currentNodeVersion = options.currentNodeVersion ?? process.versions.node;
  if (nodeMajor(currentNodeVersion) === 22) {
    return { action: 'proceed', reason: 'already-node-22' };
  }
  if (env[NODE22_REEXEC_GUARD] === '1') {
    return { action: 'proceed', reason: 'guarded' };
  }

  const nodePath = findNode22Binary(options);
  if (nodePath) {
    return {
      action: 'reexec',
      nodePath,
      argv: [...(options.execArgv ?? process.execArgv), ...(options.argv ?? process.argv.slice(1))],
    };
  }

  return {
    action: 'warn',
    message: `operator-mcp-server is running on Node ${currentNodeVersion}; install Node 22 with \`brew install node@22\` or \`nvm install 22\` if better-sqlite3 reports a NODE_MODULE_VERSION mismatch. Continuing on the current node.`,
  };
}
