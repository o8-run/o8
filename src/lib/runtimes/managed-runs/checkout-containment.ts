import { lstatSync, realpathSync } from 'node:fs';
import { dirname, basename, isAbsolute, join, sep } from 'node:path';

/** Resolve existing ancestors before appending a not-yet-created directory. */
function realRunDirectory(directory: string): string {
  try {
    return realpathSync.native(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A dangling symlink is not a directory that can safely be created here.
    try {
      if (lstatSync(directory).isSymbolicLink()) throw error;
    } catch (statError) {
      if (statError === error || (statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
    }
    const parent = dirname(directory);
    if (parent === directory) throw error;
    return join(realRunDirectory(parent), basename(directory));
  }
}

export function directoryInsideCheckout(cwd: string, checkout: string): boolean {
  if (!isAbsolute(cwd) || cwd.split(/[\\/]/).includes('..')) return false;
  try {
    const root = realpathSync.native(checkout);
    const directory = realRunDirectory(cwd);
    return directory === root || directory.startsWith(root.endsWith(sep) ? root : root + sep);
  } catch {
    return false;
  }
}
