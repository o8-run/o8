#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const started = Date.now();
const [mode, ...options] = process.argv.slice(2);
const option = key => options.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3);
const groups = JSON.parse(readFileSync(new URL('./linux-package-prerequisites.json', import.meta.url), 'utf8'));
const group = option('group');
const packages = groups[group];
const digest = value => createHash('sha256').update(value).digest('hex');
const output = fields => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    Object.entries(fields).map(([key, value]) => `${key}=${value}\n`).join(''));
};

function missingPackages() {
  return packages.filter(name => {
    const result = spawnSync('dpkg-query', ['-W', '-f=${Status}', name], { encoding: 'utf8' });
    return result.status !== 0 || result.stdout.trim() !== 'install ok installed';
  });
}
function apt(args) {
  const root = process.getuid?.() === 0;
  const result = spawnSync(root ? 'apt-get' : 'sudo', root ? args : ['apt-get', ...args], { stdio: 'inherit' });
  if (result.error || result.signal || result.status !== 0) throw new Error('Package installation command failed');
}
function archiveName(name) {
  return !name.includes('/') && !name.includes('\\') && name.endsWith('.deb');
}

try {
  if (!['key', 'install'].includes(mode) || !Array.isArray(packages) || !packages.length
    || options.some(value => !/^--(?:group|cache)=/.test(value))) throw new Error('Use key|install --group=rust|resources [--cache=PATH]');
  if (!process.env.ImageOS || !process.env.ImageVersion) throw new Error('Runner image identity is required');
  if (![process.env.ImageOS, process.env.ImageVersion].every(value => /^[a-z0-9._-]+$/i.test(value))) throw new Error('Invalid runner image identity');
  if (!packages.every(name => /^[a-z0-9][a-z0-9+.-]*$/.test(name))) throw new Error('Invalid prerequisite package definition');
  const identity = { schema: 'o8/linux-package-cache/v1', group, packages,
    image: process.env.ImageOS, version: process.env.ImageVersion, arch: process.arch,
    installer: digest(readFileSync(fileURLToPath(import.meta.url))) };
  const key = `linux-packages-v1-${identity.image}-${identity.version}-${identity.arch}-${group}-${digest(JSON.stringify(identity))}`;
  const cache = path.resolve(option('cache') ?? path.join(process.cwd(), '.cache/linux-package-prerequisites', group));
  if (mode === 'key') { output({ key, path: cache }); console.log(key); }
  else {
    if (process.platform !== 'linux') throw new Error('Linux prerequisite installation requires Linux');
    let source = 'installed';
    let count = 0;
    if (missingPackages().length) {
      const temporary = mkdtempSync(path.join(tmpdir(), 'o8-linux-packages-'));
      try {
        const emptyLists = path.join(temporary, 'empty-lists');
        mkdirSync(emptyLists);
        const emptySources = path.join(temporary, 'sources.list');
        writeFileSync(emptySources, '');
        const install = manifest => {
          if (!manifest.archives.length) throw new Error('No cached package archives');
          apt(['--yes', '--no-install-recommends', '--no-download',
            '-o', `Dir::Cache::archives=${cache}`,
            '-o', `Dir::Etc::sourcelist=${emptySources}`, '-o', `Dir::Etc::sourceparts=${emptyLists}`,
            '-o', `Dir::State::lists=${emptyLists}`, 'install',
            ...manifest.archives.map(archive => path.join(cache, archive.file))]);
          if (missingPackages().length) throw new Error('Requested package prerequisites are still missing');
          count = manifest.archives.length;
        };
        let cached;
        try {
          cached = JSON.parse(readFileSync(path.join(cache, 'manifest.json'), 'utf8'));
          if (cached.key !== key || !Array.isArray(cached.archives) || !cached.archives.length) throw new Error('Cache identity mismatch');
          for (const archive of cached.archives) {
            if (!archiveName(archive.file)) throw new Error('Invalid cached archive path');
            const file = path.join(cache, archive.file);
            if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()
              || digest(readFileSync(file)) !== archive.sha256) throw new Error('Invalid cached archive');
          }
          install(cached);
          source = 'cache';
        } catch {
          console.log('[linux-packages] cache unavailable; resolving prerequisites through APT');
        }
        if (source !== 'cache') {
          const archives = path.join(temporary, 'archives');
          mkdirSync(archives);
          apt(['update']);
          apt(['--yes', '--no-install-recommends', '--download-only', '--fix-broken',
            '-o', `Dir::Cache::archives=${archives}`, 'install', ...missingPackages()]);
          mkdirSync(cache, { recursive: true });
          if (!lstatSync(cache).isDirectory() || lstatSync(cache).isSymbolicLink()) throw new Error('Cache must be a real directory');
          const staging = mkdtempSync(path.join(cache, '.write-'));
          const files = readdirSync(archives).filter(archiveName).sort();
          const manifest = { ...identity, key, archives: files.map(file => {
            const original = path.join(archives, file);
            if (!lstatSync(original).isFile() || lstatSync(original).isSymbolicLink()) throw new Error('Invalid downloaded archive');
            const destination = path.join(cache, file);
            const pending = path.join(staging, file);
            copyFileSync(original, pending);
            renameSync(pending, destination);
            return { file, sha256: digest(readFileSync(destination)) };
          }) };
          install(manifest);
          writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest) + '\n');
          renameSync(path.join(staging, 'manifest.json'), path.join(cache, 'manifest.json'));
          rmSync(staging, { recursive: true, force: true });
          source = 'download';
        }
      } finally { rmSync(temporary, { recursive: true, force: true }); }
    }
    const result = { source, elapsedMs: Date.now() - started, archives: count };
    output(result);
    console.log('[linux-packages]', JSON.stringify(result));
  }
} catch (error) {
  console.error('[linux-packages]', error.message);
  process.exitCode = 1;
}
