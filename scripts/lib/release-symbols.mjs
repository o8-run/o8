import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const metadata = filename => lstat(filename).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});

async function futureRealpath(filename) {
  if (await metadata(filename)) return realpath(filename);
  return path.join(await futureRealpath(path.dirname(filename)), path.basename(filename));
}

async function privateDirectory(directory, recursive = false) {
  await mkdir(directory, { recursive, mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Symbol retention directory is redirected or invalid.');
  await chmod(directory, 0o700);
}

async function digestBundle(root, tightenPermissions = false) {
  const hash = createHash('sha256');
  async function visit(directory) {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Symbol bundle directory is redirected or invalid.');
    if (tightenPermissions) await chmod(directory, 0o700);
    for (const name of (await readdir(directory)).sort()) {
      const filename = path.join(directory, name);
      const entry = await lstat(filename);
      if (entry.isSymbolicLink()) throw new Error('Symbol bundle contains a linked entry.');
      if (entry.isDirectory()) {
        hash.update(JSON.stringify(['directory', path.relative(root, filename)]));
        await visit(filename);
      } else if (entry.isFile()) {
        hash.update(JSON.stringify(['file', path.relative(root, filename), entry.size]));
        for await (const bytes of createReadStream(filename)) hash.update(bytes);
        if (tightenPermissions) await chmod(filename, 0o600);
      } else throw new Error('Symbol bundle contains an unsupported entry.');
    }
  }
  await visit(root);
  return hash.digest('hex');
}

async function uuids(filename) {
  const { stdout } = await runFile('dwarfdump', ['--uuid', filename], { timeout: 30_000 });
  const entries = stdout.trim().split('\n').map(line => {
    const match = /^UUID: ([\dA-F-]{36}) \((arm64|x86_64)\) /i.exec(line);
    if (!match) throw new Error('Symbol UUID inspection is incomplete.');
    return { uuid: match[1].toUpperCase(), cpu: match[2] };
  });
  if (new Set(entries.map(entry => entry.cpu)).size !== entries.length) throw new Error('Duplicate symbol CPU identity.');
  return entries.sort((left, right) => left.cpu.localeCompare(right.cpu));
}

/** Copy and verify private symbols before the only build copy can be deleted. */
export async function retainMacosReleaseSymbols(repoRoot, {
  symbolsRoot = process.env.O8_RELEASE_SYMBOLS_DIR || path.join(homedir(), '.o8-symbols'),
} = {}) {
  const sources = [];
  for (const triple of ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'universal-apple-darwin', '']) {
    const release = path.join(repoRoot, 'src-tauri/target', triple, 'release');
    const alias = path.join(release, 'o8.dSYM');
    if (!(await metadata(alias))) {
      if (triple !== 'universal-apple-darwin' && (triple || process.platform === 'darwin')
        && await metadata(path.join(release, 'o8'))) {
        throw new Error('Release executable has no dSYM; preserving build output.');
      }
      continue;
    }
    // Cargo links the release dSYM to its copy in release/deps. Resolve that
    // link only when the bundle stays inside this checkout's target tree.
    const source = await realpath(alias);
    const relative = path.relative(await realpath(path.join(repoRoot, 'src-tauri/target')), source);
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error('Build symbols are outside the target tree.');
    }
    const digest = await digestBundle(source);
    const identities = await uuids(source);
    const binary = path.join(release, 'o8');
    if (await metadata(binary)) {
      const binaryIds = await uuids(binary);
      if (JSON.stringify(binaryIds) !== JSON.stringify(identities)) throw new Error('Release executable and dSYM UUIDs differ.');
    }
    sources.push({ source, digest, identities });
  }
  // Tauri creates the universal executable with lipo; its two slice dSYMs
  // remain under the architecture targets, without a combined dSYM.
  const universal = path.join(repoRoot, 'src-tauri/target/universal-apple-darwin/release/o8');
  if (await metadata(universal)) {
    const identities = sources.flatMap(source => source.identities);
    for (const identity of await uuids(universal)) {
      if (!identities.some(candidate => candidate.cpu === identity.cpu && candidate.uuid === identity.uuid)) {
        throw new Error('Universal release is missing matching slice symbols.');
      }
    }
  }
  if (!sources.length) return;

  const { version } = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-preview\.\d+)?$/.test(version)) throw new Error('Symbol retention requires a release version.');
  if (!path.isAbsolute(symbolsRoot)) throw new Error('Symbol retention root must be absolute.');
  const selected = path.resolve(symbolsRoot);
  if ((await metadata(selected))?.isSymbolicLink()) throw new Error('Symbol retention root is redirected.');
  const store = await futureRealpath(selected);
  const relative = path.relative(await realpath(repoRoot), store);
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
    throw new Error('Symbol retention must be outside the build checkout.');
  }
  if (store === path.parse(store).root) throw new Error('Symbol retention cannot use the filesystem root.');
  await privateDirectory(store, true);
  const retained = [];
  for (const { source, digest, identities } of sources) {
    for (const { cpu, uuid } of identities) {
      let parent = store;
      for (const segment of [version, cpu, uuid]) {
        parent = path.join(parent, segment);
        await privateDirectory(parent);
      }
      const destination = path.join(parent, digest);
      const bundle = path.join(destination, 'o8.dSYM');
      if (!(await metadata(destination))) {
        const staging = await mkdtemp(path.join(parent, '.pending-'));
        await cp(source, path.join(staging, 'o8.dSYM'), { recursive: true, errorOnExist: true, force: false });
        if (await digestBundle(path.join(staging, 'o8.dSYM'), true) !== digest) throw new Error('Symbol retention copy differs from source.');
        await writeFile(path.join(staging, 'receipt.json'), JSON.stringify({ version, cpu, uuid, sha256: digest }), { mode: 0o600 });
        try {
          await rename(staging, destination);
        } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
          // A concurrent owner may have retained the same immutable artifact.
          await privateDirectory(destination);
          if (await digestBundle(bundle) !== digest) throw new Error('Existing retained symbols are incomplete or changed.');
          await rm(staging, { recursive: true });
        }
      }
      await privateDirectory(destination);
      if (await digestBundle(bundle, true) !== digest
        || JSON.stringify(await uuids(bundle)) !== JSON.stringify(identities)) {
        throw new Error('Retained symbols failed final verification; preserving build output.');
      }
      retained.push({ bundle, digest });
    }
  }
  // Recheck both copies immediately before allowing the caller to remove target.
  for (const { source, digest } of sources) {
    if (await digestBundle(source) !== digest) throw new Error('Build symbols changed during retention.');
  }
  for (const { bundle, digest } of retained) {
    if (await digestBundle(bundle) !== digest) throw new Error('Retained symbols changed before cleanup.');
  }
}
