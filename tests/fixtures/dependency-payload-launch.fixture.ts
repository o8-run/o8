import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, vi } from 'vitest';
import { materializeDependencyInstall } from '@/lib/workspace/dependency-materializer';
import { dependencyDirectoryPoolStatus, waitForDependencyDirectoryPool } from '@/lib/workspace/dependency-directory-pool';
import { getDataDir } from '@/lib/data-dir-migration';

export async function installPayloadBaseline(source: string, version: string) {
  if (process.env.O8_SPEED_DEPENDENCY_DEFECT === 'contained-link') {
    writeFileSync(path.join(source, 'node_modules/shared.js'), 'module.exports = 42;\n');
    unlinkSync(path.join(source, 'node_modules/fixture/index.js'));
    symlinkSync('../shared.js', path.join(source, 'node_modules/fixture/index.js'));
  }
  await materializeDependencyInstall(source, 'npm ci --offline', {
    useDependencyPool: false, resolveVersion: async () => version, run: async () => {},
    env: { O8_APFS_DEPENDENCY_IMAGES: '0' },
  });
}

export async function preparePayloadPool(root: string, source: string, version: string) {
  const defect = process.env.O8_SPEED_DEPENDENCY_DEFECT!;
  if (defect === 'absolute-link') {
    const target = path.join(source, 'node_modules/shared.js');
    writeFileSync(target, 'module.exports = 42;\n');
    unlinkSync(path.join(source, 'node_modules/fixture/index.js'));
    symlinkSync(target, path.join(source, 'node_modules/fixture/index.js'));
  }
  const seed = path.join(root, 'payload-seed');
  execFileSync('git', ['clone', '--local', '-q', source, seed]);
  await materializeDependencyInstall(seed, 'npm ci --offline', {
    cloneSourceWorkspace: source, useDependencyPool: true, resolveVersion: async () => version,
    env: { O8_APFS_DEPENDENCY_IMAGES: '0' },
  });
  await waitForDependencyDirectoryPool();
  const status = await dependencyDirectoryPoolStatus();
  expect(status, JSON.stringify(status)).toMatchObject({ readyTrees: 2 });
  if (['absolute-link', 'hidden-escape', 'truncated', 'missing', 'same-size'].includes(defect)) for (let index = 0; index < 2; index++) {
    const file = path.join(getDataDir(), `dependency-directory-pool-v1/slot-${index}/node_modules/fixture/index.js`);
    if (defect === 'absolute-link') {
      unlinkSync(file);
      symlinkSync(path.join(source, 'node_modules/shared.js'), file);
    } else if (defect === 'hidden-escape') {
      const cache = path.join(path.dirname(path.dirname(file)), '.cache');
      mkdirSync(cache);
      symlinkSync('../../../README.md', path.join(cache, 'escape'));
    } else if (defect === 'missing') unlinkSync(file);
    else writeFileSync(file, defect === 'same-size' ? 'module.exports = 13;\n' : 'module.exports =');
  }
}

/** Independent kernel-resolution oracle over every worker file and link. */
function fileIdentities(workspace: string) {
  const root = realpathSync(path.join(workspace, 'node_modules'));
  const identities = new Set<string>();
  const unsafeLinks: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name);
      const entry = lstatSync(file);
      if (entry.isSymbolicLink()) {
        const relative = path.relative(root, realpathSync(file));
        if (path.isAbsolute(readlinkSync(file)) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) unsafeLinks.push(path.relative(root, file));
      }
      if (entry.isDirectory()) visit(file);
      else {
        const target = statSync(file);
        if (target.isFile()) identities.add(`${target.dev}:${target.ino}`);
      }
    }
  };
  visit(root);
  return { identities, unsafeLinks };
}

export async function assertPayloadWorkers(input: {
  source: string;
  workers: string[];
  observe: (workspace: string) => { pid?: number; prepared: boolean } | undefined;
  selections: Array<{ stage?: unknown; path?: unknown; reason?: unknown }>;
}) {
  for (const workspace of input.workers) await vi.waitFor(() => expect(input.observe(workspace)?.prepared).toBe(true), { timeout: 10_000 });
  for (const workspace of input.workers) expect(() => process.kill(input.observe(workspace)!.pid!, 0)).not.toThrow();
  const trees = [input.source, ...input.workers].map(fileIdentities);
  const sharedFiles = trees.flatMap(({ identities }, index) => trees.slice(index + 1).flatMap(other => [...identities].filter(file => other.identities.has(file))));
  const unsafeLinks = trees.slice(1).flatMap(tree => tree.unsafeLinks);
  const file = 'node_modules/fixture/index.js';
  const original = 'module.exports = 42;\n';
  writeFileSync(path.join(input.workers[0], 'write-payload'), 'write');
  await vi.waitFor(() => expect(existsSync(path.join(input.workers[0], 'payload-written'))).toBe(true));
  const donor = readFileSync(path.join(input.source, file), 'utf8');
  const other = readFileSync(path.join(input.workers[1], file), 'utf8');
  const distinctFiles = new Set([input.source, ...input.workers].map(workspace => {
    const entry = statSync(path.join(workspace, file)); return `${entry.dev}:${entry.ino}`;
  })).size;
  const receipt = { defect: process.env.O8_SPEED_DEPENDENCY_DEFECT, liveWorkers: 2,
    isolated: donor === original && other === original && distinctFiles === 3 && sharedFiles.length === 0 && unsafeLinks.length === 0,
    sharedFiles: sharedFiles.length, unsafeLinks,
    selections: input.selections.filter(event => event.stage === 'dependency_selection') };
  process.stdout.write('[dependency-payload-workers] ' + JSON.stringify(receipt) + '\n');
  if (process.env.O8_SPEED_RECEIPT) writeFileSync(process.env.O8_SPEED_RECEIPT, JSON.stringify(receipt));
  expect(donor).toBe(original);
  expect(other).toBe(original);
  expect(distinctFiles).toBe(3);
  expect(sharedFiles).toEqual([]);
  expect(unsafeLinks).toEqual([]);
  expect(readFileSync(path.join(input.workers[0], file), 'utf8')).toBe('module.exports = 99;\n');
  if (['healthy', 'contained-link'].includes(process.env.O8_SPEED_DEPENDENCY_DEFECT!)) {
    expect(receipt.selections).toHaveLength(2);
    expect(receipt.selections.every(event => event.path === 'dependency-pool')).toBe(true);
  } else {
    const reason = ({ missing: 'pool-payload-entrypoint-missing', 'absolute-link': 'pool-payload-absolute-link',
      'hidden-escape': 'pool-payload-escaping-link' } as Record<string, string>)[process.env.O8_SPEED_DEPENDENCY_DEFECT!] ?? 'pool-payload-changed';
    expect(receipt.selections[0]).toMatchObject({ path: 'native-install', reason });
    // The first fresh install can refill a healthy slot before the next tick.
    expect(receipt.selections.every(event => event.path === 'native-install' && event.reason === reason
      || event.path === 'dependency-pool' && event.reason === 'matching-inputs')).toBe(true);
  }
}
