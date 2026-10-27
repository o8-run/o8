// Conservative repository-file closure, available before npm ci. Native tests
// read Rust includes, route-host imports and fixture files outside their crate.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function nativeTestInputs(root) {
  const listing = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2,
  });
  if (listing.error || listing.status !== 0) throw new Error('Native input discovery unavailable');
  const files = new Set(listing.stdout.split('\0').filter(Boolean));
  const directories = new Map();
  const basenames = new Map();
  for (const file of files) {
    const name = path.posix.basename(file);
    if (!basenames.has(name)) basenames.set(name, []);
    basenames.get(name).push(file);
    for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir)) {
      if (!directories.has(dir)) directories.set(dir, []);
      directories.get(dir).push(file);
    }
  }
  // Rust compilation and generated fixture families cover the whole crate.
  // Start the read graph at Rust sources, then follow their actual host paths.
  const inputs = new Set([...files].filter(file => /^native\/o8-next\//.test(file)));
  inputs.add('scripts/register-server-only-stub.mjs');
  inputs.add('tsconfig.json');
  const pending = [...inputs].filter(file => file.endsWith('.rs'));
  const prefixes = new Set();
  const filenameReferences = new Set();
  pending.push('scripts/register-server-only-stub.mjs');
  const queued = new Set(pending);
  const add = file => {
    inputs.add(file);
    if (!queued.has(file)) { queued.add(file); pending.push(file); }
  };
  const extensions = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.rs'];
  function reference(value, origin, directory = false) {
    // A computed path selects its entire static prefix. This also covers
    // readdir/new URL discovery and Rust fixture families built with format!.
    const literal = value.split('${')[0];
    if (!literal || path.posix.isAbsolute(literal) || /[\r\n\0]/.test(literal) || literal.length > 512
      || !literal.includes('/') && !/\.[a-z0-9]+$/i.test(literal)) return;
    // A filename constant may be joined to a directory at runtime. Include
    // all matching repository files, including a removed file in the diff.
    if (!literal.includes('/') && /\.[a-z0-9]+$/i.test(literal)) {
      filenameReferences.add(literal);
      for (const file of basenames.get(literal) ?? []) add(file);
    }
    const candidates = literal.startsWith('@/') ? ['src/' + literal.slice(2)] : [
      path.posix.join(path.posix.dirname(origin), literal),
      path.posix.join('native/o8-next', literal),
      path.posix.normalize(literal),
    ];
    for (const candidate of candidates) {
      if (candidate.startsWith('../') || path.posix.isAbsolute(candidate)) continue;
      for (const extension of extensions) {
        const file = candidate + extension;
        if (files.has(file)) add(file);
        else inputs.add(file); // A deleted dependency still selects the gate.
        const index = path.posix.join(candidate, 'index' + extension);
        if (files.has(index)) add(index);
        else inputs.add(index);
      }
      if (directory && candidate !== '.') {
        prefixes.add(candidate.replace(/\/$/, '') + '/');
        for (const file of directories.get(candidate.replace(/\/$/, '')) ?? []) add(file);
      }
    }
  }
  while (pending.length) {
    const file = pending.pop();
    if (!/\.(?:[cm]?js|tsx?|rs)$/.test(file)) continue;
    let source;
    try { source = readFileSync(path.join(root, file), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    // File literals cover includes, filesystem reads and command arguments.
    // Module specifiers also need extensionless and index resolution. Only
    // discovery/import prefixes select directories, not ordinary path prose.
    const literals = file.endsWith('.rs') ? /"([^"\r\n]*)"/g
      : /"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`]*)`/g;
    for (const match of source.matchAll(literals)) {
      const value = match[1] ?? match[2] ?? match[3];
      if (/\.[a-z0-9]+$/i.test(value)) reference(value, file);
      else if (file.endsWith('.rs') && value.includes('/')) reference(value, file, true);
    }
    if (!file.endsWith('.rs')) {
      const modules = /\b(?:from|import)\s*['"]([^'"\r\n]+)['"]|\b(?:import|require)\s*\(\s*['"`]([^'"`]+)['"`]|\b(?:URL|readdirSync|readdir|readFileSync|readFile)\s*\(\s*['"`]([^'"`]+)['"`]/g;
      for (const match of source.matchAll(modules)) {
        const value = match[1] ?? match[2] ?? match[3];
        reference(value, file, !!match[3] || value.includes('${') || value.endsWith('/'));
      }
    }
  }
  return { has: file => inputs.has(file) || filenameReferences.has(path.posix.basename(file))
    || [...prefixes].some(prefix => file.startsWith(prefix)) };
}
