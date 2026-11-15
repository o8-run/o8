import { access } from 'node:fs/promises';
import path from 'node:path';

/**
 * Guards the dispatch typecheck gates against worktrees where the compiler
 * can't actually run: repos with `installOnCreateWorkspace: false` produce a
 * worktree with no `node_modules`. The gate read the resulting failure as a
 * type error and bounced the packet into the layer-1 auto-retry forever
 * (#1255). This module lets both gates SKIP-with-warning instead of looping.
 */

/** Recorded when the repository's install has no TypeScript compiler; no other compiler is used. */
export const NO_REPOSITORY_TYPESCRIPT = 'no TypeScript install in the repository';

/** The compiler a lane's typecheck runs: the repository's own install, never the lane's checkout. */
export function repositoryTypeScriptCompiler(installRoot: string): string {
  return path.join(installRoot, 'node_modules', 'typescript', 'bin', 'tsc');
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export interface TypecheckSkip {
  skip: boolean;
  reason?: string;
}

export type TypecheckAvailability = 'no-project' | 'missing-compiler' | 'available';

/** Shared project/compiler observation; callers decide how to report unavailable checks. */
export async function detectTypecheckAvailability(cwd: string): Promise<TypecheckAvailability> {
  const hasTsconfig = await exists(path.join(cwd, 'tsconfig.json'));
  if (!hasTsconfig) return 'no-project';
  const hasLocalTsc =
    (await exists(path.join(cwd, 'node_modules', '.bin', 'tsc')))
    || (await exists(path.join(cwd, 'node_modules', 'typescript', 'package.json')));
  return hasLocalTsc ? 'available' : 'missing-compiler';
}

/**
 * Decide whether `tsc --noEmit` should run in this worktree at all. Skips
 * when there's no TS project (no tsconfig) or no local compiler to run it
 * (deps not installed). Returns `skip: false` for a normal TS worktree so the
 * typecheck runs exactly as before.
 */
export async function detectTypecheckSkip(cwd: string): Promise<TypecheckSkip> {
  const availability = await detectTypecheckAvailability(cwd);
  if (availability === 'no-project') {
    return { skip: true, reason: 'no tsconfig.json (not a TypeScript project)' };
  }
  if (availability === 'missing-compiler') {
    return { skip: true, reason: 'no local TypeScript installed (node_modules missing)' };
  }
  return { skip: false };
}
