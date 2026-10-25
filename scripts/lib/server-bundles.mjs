// One build contract for the desktop export, size gate, and packaged-layout tests.
import { buildSync } from 'esbuild';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const SERVER_ENTRIES = {
  'ws-server': 'src/ws-server.ts',
  'terminal-host': 'src/lib/ws-server/terminal-host-entry.ts',
  'operator-mcp-server-main': 'src/lib/mcp/operator-mcp-server.ts',
  'operator-mcp-server': 'src/lib/mcp/operator-mcp-server-bundle-entry.ts',
  'operator-mcp-proxy': 'src/lib/mcp/operator-mcp-proxy.ts',
  'codex-app-bridge': 'src/lib/codex/app-server-exec-bridge.ts',
  'cortex-mcp-server': 'src/lib/mcp/cortex-mcp-server.ts',
};
const PURE_NODE_ENTRIES = new Set(['operator-mcp-proxy']);
// CJS dependencies need these globals in entries AND shared chunks. Chunks stay
// beside the entries so import.meta.url based prompts, forks and addons resolve.
const ESM_BANNER = [
  'import { createRequire as __o8_createRequire } from "module";',
  'import { fileURLToPath as __o8_fileURLToPath } from "url";',
  'import { dirname as __o8_dirname } from "path";',
  'const require = __o8_createRequire(import.meta.url);',
  'const __filename = __o8_fileURLToPath(import.meta.url);',
  'const __dirname = __o8_dirname(__filename);',
].join(' ');

// esbuild can emit a lazy entry even after its importer was tree-shaken.
// Package the full import closure of every shipped entry, including lazy edges.
function pruneOrphanOutputs(root, outDir, metafile) {
  const files = new Map(Object.entries(metafile.outputs).map(([file, output]) => {
    const absolute = resolve(root, file);
    const local = relative(outDir, absolute);
    if (!local || isAbsolute(local) || local === '..' || local.startsWith('..' + sep)) {
      throw new Error('Server output escapes the bundle directory');
    }
    return [absolute, { file, output }];
  }));
  const pending = Object.keys(SERVER_ENTRIES).map(label => join(outDir, `${label}-impl.mjs`));
  const reachable = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (reachable.has(file)) continue;
    const entry = files.get(file);
    if (!entry) throw new Error('Server output references a missing bundled dependency');
    reachable.add(file);
    const dependencies = entry.output.imports.filter(item => !item.external).map(item => item.path);
    if (entry.output.cssBundle) dependencies.push(entry.output.cssBundle);
    for (const dependency of dependencies) {
      const fromRoot = resolve(root, dependency);
      pending.push(files.has(fromRoot) ? fromRoot : resolve(dirname(file), dependency));
    }
  }
  for (const [absolute, { file }] of files) {
    if (reachable.has(absolute)) continue;
    rmSync(absolute);
    delete metafile.outputs[file];
  }
}

export function bundleServers({ root, outDir }) {
  root = resolve(root);
  outDir = resolve(outDir);
  mkdirSync(outDir, { recursive: true });
  const options = {
    absWorkingDir: root,
    outdir: outDir,
    outExtension: { '.js': '.mjs' },
    chunkNames: 'server-chunk-[hash]',
    bundle: true,
    minify: true,
    keepNames: true,
    sourcemap: false,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: { 'server-only': join(root, 'scripts/server-only-stub.js') },
    banner: { js: ESM_BANNER },
    metafile: true,
    logLevel: 'warning',
  };
  const entryPoints = Object.entries(SERVER_ENTRIES).map(([label, entry]) => ({ in: entry, out: `${label}-impl` }));
  const { metafile } = buildSync({
    ...options,
    entryPoints: entryPoints.filter(entry => !PURE_NODE_ENTRIES.has(entry.out.replace(/-impl$/, ''))),
    splitting: true,
    external: ['node-pty', 'better-sqlite3', 'bindings'],
  });
  // Sharing can hoist an otherwise-unused native import into a common chunk.
  // Keep the dependency-light proxy standalone: it does not run the native-addon
  // selector and must work without native modules installed.
  for (const label of PURE_NODE_ENTRIES) {
    const result = buildSync({ ...options,
      entryPoints: [{ in: SERVER_ENTRIES[label], out: `${label}-impl` }],
    });
    Object.assign(metafile.inputs, result.metafile.inputs);
    Object.assign(metafile.outputs, result.metafile.outputs);
  }

  pruneOrphanOutputs(root, outDir, metafile);

  for (const label of Object.keys(SERVER_ENTRIES)) {
    // Selection must precede the dynamic import: shared modules may load SQLite.
    const bootstrap = PURE_NODE_ENTRIES.has(label) ? '' : `import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (process.platform === 'darwin') {
  require('./native-addon-runtime.cjs').prepareNativeAddons(dirname(fileURLToPath(import.meta.url)));
}
`;
    writeFileSync(join(outDir, `${label}.mjs`), `// Generated entry for ${label}.\n${bootstrap}await import('./${label}-impl.mjs');\n`);
  }

  // Content hashes change on ordinary edits. Key each shared output by its
  // source identity: a lazy entry's path, or the first input in a shared chunk.
  // This keeps the per-output budgets independent of generated filenames.
  const rows = Object.entries(metafile.outputs).map(([file, output]) => {
    const name = relative(outDir, resolve(root, file)).replaceAll('\\', '/');
    const identity = output.entryPoint ? `entry:${output.entryPoint}`
      : `common:${Object.keys(output.inputs).sort()[0] ?? 'runtime'}`;
    return { file: name, budgetKey: name.startsWith('server-chunk-') ? `shared:${identity}` : name, bytes: output.bytes };
  });
  if (new Set(rows.map(row => row.budgetKey)).size !== rows.length) {
    throw new Error('Server outputs must have distinct budget identities');
  }
  for (const label of Object.keys(SERVER_ENTRIES)) {
    const file = `${label}.mjs`;
    rows.push({ file, budgetKey: file, bytes: statSync(join(outDir, file)).size });
  }
  return { outputs: rows.sort((a, b) => a.budgetKey.localeCompare(b.budgetKey)), metafile };
}
