import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from '@/lib/providers/child-process';

const execFileAsync = promisify(execFile);

/** A linked checkout can load hooks from its backing project's config file. */
export async function backingProjectConfigPaths(
  gitPaths: string[],
  worktreeRoot: string,
  protectedRoots: string[],
): Promise<string[]> {
  const commonDir = gitPaths.at(-1);
  // A bare or separately located Git directory does not identify a checkout.
  if (!commonDir || path.basename(commonDir) !== '.git') return [];
  const projectRoot = await realpath(path.dirname(commonDir));
  if (projectRoot === worktreeRoot) return [];
  const config = path.join(projectRoot, '.codex', 'config.toml');
  if (protectedRoots.includes(projectRoot)) {
    throw new Error(`Backing project configuration '${config}' cannot re-open a protected root.`);
  }
  const entry = await lstat(config).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot inspect backing project configuration '${config}' (${error.code ?? 'unknown error'}). Review its permissions before retrying.`);
  });
  if (!entry) return [];
  // Do not turn a repository symlink into a grant on an operator's config or
  // credential store. Only this regular file at its canonical path is eligible.
  if (!entry.isFile() || entry.nlink !== 1 || await realpath(config) !== config) {
    throw new Error(`Backing project configuration '${config}' must be a regular, non-aliased file.`);
  }
  return [config];
}

/** Open required configuration through the policy without reading its contents. */
export async function assertBackingProjectConfigReadable(
  sandboxBinary: string,
  profilePath: string,
  configs: string[],
): Promise<void> {
  for (const config of configs) {
    try {
      await execFileAsync(sandboxBinary, ['-f', profilePath, process.execPath, '-e',
        'const fs = require("node:fs"); fs.closeSync(fs.openSync(process.argv[1], "r"));', config],
      { windowsHide: true, timeout: 5_000 });
    } catch {
      throw new Error(
        `Sandbox refused read access to backing project configuration '${config}'. Review the sandbox profile before retrying.`,
      );
    }
  }
}
