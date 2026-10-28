import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function assertTauriExportInputsSafe(standaloneRoot) {
  for (const [label, path] of [
    ['standalone build', standaloneRoot],
    ['standalone node_modules', join(standaloneRoot, 'node_modules')],
  ]) {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (!entry?.isSymbolicLink()) continue;
    throw new Error(
      `${label} is a symbolic link (${path}); install dependencies inside this worktree and rebuild before packaging`,
    );
  }

  // lstat catches dangling links before the general link scan below.
  for (const entry of ['cache', 'dev', 'trace', 'trace-build']) {
    const generated = join(standaloneRoot, '.next', entry);
    if (lstatSync(generated, { throwIfNoEntry: false })) {
      throw new Error(`standalone build contains .next/${entry}; exclude build-only files from tracing and rebuild before packaging`);
    }
  }

  for (const entry of readdirSync(standaloneRoot)) {
    if (/^\.(?:git|env)/.test(entry) || /^\.o8/.test(entry)
      || ['.mcp.json', '.agents', '.claude', '.codex', '.cortex-worktrees'].includes(entry)
      || entry.endsWith('.html')) {
      throw new Error(`standalone build contains checkout metadata: ${entry}; exclude it from tracing and rebuild before packaging`);
    }
  }

  // Dependency and asset links must stay in the standalone tree, both at
  // their immediate target and after resolution on the build host.
  {
    const pending = [standaloneRoot];
    while (pending.length > 0) {
      const directory = pending.pop();
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(path);
        } else if (entry.isSymbolicLink()) {
          const label = relative(standaloneRoot, path).startsWith(`node_modules${sep}`) ? 'dependency' : 'standalone asset';
          const immediate = relative(standaloneRoot, resolve(dirname(path), readlinkSync(path)));
          if (immediate === '..' || immediate.startsWith(`..${sep}`) || isAbsolute(immediate)) {
            throw new Error(`${label} link escapes the package: ${relative(standaloneRoot, path)}`);
          }
          let resolved;
          try {
            resolved = realpathSync(path);
          } catch {
            throw new Error(`${label} link is dangling: ${relative(standaloneRoot, path)}`);
          }
          const destination = relative(standaloneRoot, resolved);
          if (destination === '..' || destination.startsWith(`..${sep}`) || isAbsolute(destination)) {
            throw new Error(`${label} link escapes the package: ${relative(standaloneRoot, path)}`);
          }
        }
      }
    }
  }
  assertNextRuntimeFilesPresent(standaloneRoot);
}

/** Resolve compiled route externals from the package, never the build checkout. */
export function assertNextRuntimeFilesPresent(serverRoot) {
  const compiled = join(serverRoot, '.next/server');
  if (!lstatSync(compiled, { throwIfNoEntry: false })) return;
  const root = realpathSync(serverRoot);
  const pending = [compiled];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { pending.push(file); continue; }
      if (!entry.isFile() || !/\.[cm]?js$/.test(entry.name)) continue;
      const require = createRequire(resolve(file));
      const references = readFileSync(file, 'utf8').matchAll(
        /["'`](next\/dist\/compiled\/next-server\/[^"'`\s]+)["'`]/g,
      );
      for (const [, specifier] of references) {
        let resolved;
        try { resolved = realpathSync(require.resolve(specifier)); } catch {
          throw new Error(`Missing packaged Next runtime: ${specifier} (required by ${relative(serverRoot, file)})`);
        }
        const destination = relative(root, resolved);
        if (destination === '..' || destination.startsWith(`..${sep}`) || isAbsolute(destination)) {
          throw new Error(`Next runtime resolves outside the package: ${specifier}`);
        }
      }
    }
  }
}
