import { createHash } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { dependencyCloneNativeFiles, type NativePackageMetadata } from './dependency-clone-native';
import { dependencyCloneSnapshot, dependencyCloneSnapshotMatches, DependencyCloneSourceChanged, type DependencyCloneSnapshot } from './dependency-clone-snapshot';

interface LockedPackage extends NativePackageMetadata {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  optional?: boolean;
  os?: string[];
  cpu?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function permits(values: string[] | undefined, actual: string): boolean {
  return !values || (!values.includes(`!${actual}`)
    && (!values.some((value) => !value.startsWith('!')) || values.includes(actual)));
}

/** npm's installed lock is independent evidence of the installed resolution. */
export async function validateDependencyCloneGraph(workspace: string, lockfilePath = 'package-lock.json'): Promise<{ digest: string; nativeFiles: string[]; snapshot: DependencyCloneSnapshot } | null> {
  if (!['package-lock.json', 'npm-shrinkwrap.json'].includes(lockfilePath)) return null;
  try {
    const capture = dependencyCloneSnapshot(workspace);
    const read = async (relative: string) => JSON.parse(await capture.read(relative)) as {
      lockfileVersion?: number; packages?: Record<string, LockedPackage>;
    };
    const [lock, installed, manifest] = await Promise.all([read(lockfilePath), read('node_modules/.package-lock.json'), read('package.json')]);
    if (installed.lockfileVersion !== 3 || !lock.packages || !installed.packages) return null;
    const inspectModules = async (relative: string): Promise<boolean> => {
      let entries;
      try {
        const directory = await capture.record(relative);
        if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
        entries = await readdir(path.join(workspace, relative), { withFileTypes: true });
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isSymbolicLink()) return false;
        if (!entry.isDirectory()) continue;
        const name = `${relative}/${entry.name}`;
        if (entry.name.startsWith('@')) {
          if (!await inspectModules(name)) return false;
        } else {
          if (!installed.packages![name] || !await inspectModules(`${name}/node_modules`)) return false;
        }
      }
      return true;
    };
    if (!await inspectModules('node_modules')) return null;
    const hash = createHash('sha256').update(JSON.stringify(lock)).update(JSON.stringify(installed)).update(JSON.stringify(manifest));
    const nativeFiles: string[] = [];
    const canonicalRoot = await realpath(workspace);
    const contained = (target: string) => { const relative = path.relative(canonicalRoot, target); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
    const bins = new Set<string>();
    for (const [name, entry] of Object.entries(installed.packages)) {
      const wanted = lock.packages[name];
      if (!name || !wanted || entry.link || wanted.link
        || entry.version !== wanted.version || entry.resolved !== wanted.resolved
        || entry.integrity !== wanted.integrity) return null;
      if (!/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(name) || name.split('/').includes('..')) return null;
      const directory = await capture.record(name);
      if (!directory.isDirectory() || directory.isSymbolicLink()) return null;
      const bytes = await capture.read(`${name}/package.json`);
      hash.update(name).update(bytes);
      const manifest = JSON.parse(bytes) as LockedPackage & { bin?: string | Record<string, string> };
      if (manifest.version !== entry.version) return null;
      for (const target of typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {})) {
        const bin = await realpath(path.join(workspace, name, target));
        if (!contained(bin)) return null;
        bins.add(bin);
      }
      nativeFiles.push(...await dependencyCloneNativeFiles({ workspace, name, manifest,
        lockNative: Boolean(entry.hasInstallScript || wanted.hasInstallScript || entry.os || entry.cpu || wanted.os || wanted.cpu), capture,
      }));
    }
    const selected = (entry: LockedPackage) => permits(entry.os, process.platform) && permits(entry.cpu, process.arch);
    const resolve = (parent: string, name: string) => {
      let current = parent;
      for (;;) {
        const candidate = `${current ? `${current}/` : ''}node_modules/${name}`;
        if (lock.packages![candidate]) return candidate;
        if (!current) return null;
        current = current.includes('/node_modules/') ? current.slice(0, current.lastIndexOf('/node_modules/')) : '';
      }
    };
    // An omitted optional subtree is legitimate only when no selected installed
    // parent requires it. This includes dependencies of excluded platform packages.
    for (const [name, entry] of Object.entries(lock.packages)) {
      if (name && !installed.packages[name]) {
        if (!entry.optional && selected(entry)) return null;
        continue;
      }
      for (const dependency of Object.keys({
        ...entry.dependencies, ...entry.optionalDependencies,
        ...(name === '' ? entry.devDependencies : {}),
      })) {
        const resolved = resolve(name, dependency);
        if (!resolved || (selected(lock.packages[resolved]!) && !installed.packages[resolved])) return null;
      }
    }
    // npm creates executable links from the installed package manifests. A
    // clone may retain those contained relative links, never links to the donor.
    const checkBins = async (relative: string) => {
      let entries;
      try {
        const directory = await capture.record(relative);
        if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
        entries = await readdir(path.join(workspace, relative), { withFileTypes: true });
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
      for (const file of entries) {
        if (!file.isSymbolicLink() || !bins.has(await realpath(path.join(workspace, relative, file.name)))) return false;
      }
      return true;
    };
    for (const relative of new Set(['node_modules/.bin', ...Object.keys(installed.packages).map((name) => `${name}/node_modules/.bin`)])) {
      if (!await checkBins(relative)) return null;
    }
    const native = [...new Set(nativeFiles)].sort();
    const snapshot = capture.receipt();
    if (!await dependencyCloneSnapshotMatches(workspace, snapshot)) return null;
    return { digest: hash.update(JSON.stringify(native)).digest('hex'), nativeFiles: native, snapshot };
  } catch (error) {
    if (error instanceof DependencyCloneSourceChanged || error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
