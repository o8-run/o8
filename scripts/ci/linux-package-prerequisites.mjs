#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const started = Date.now();
const [mode, ...options] = process.argv.slice(2);
const option = key => options.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3);
const groups = JSON.parse(readFileSync(new URL('./linux-package-prerequisites.json', import.meta.url), 'utf8'));
const group = option('group');
const packages = groups[group];
const systemArchives = '/var/cache/apt/archives';
const digest = value => createHash('sha256').update(value).digest('hex');
const output = fields => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    Object.entries(fields).map(([key, value]) => `${key}=${value}\n`).join(''));
};
function privileged(command, args) {
  const root = process.getuid?.() === 0;
  const result = spawnSync(root ? command : 'sudo', root ? args : [command, ...args], { stdio: 'inherit' });
  if (result.error || result.signal || result.status !== 0) throw new Error('Package prerequisite command failed');
}
const archiveName = name => /^[a-z0-9][a-z0-9+.-]*_[a-zA-Z0-9.+:~%_-]+_[a-z0-9-]+\.deb$/.test(name);
function archives(directory) {
  try {
    return readdirSync(directory).filter(archiveName).sort().flatMap(file => {
      const full = path.join(directory, file);
      const stat = lstatSync(full);
      return stat.isFile() && !stat.isSymbolicLink() ? [{ file, full }] : [];
    });
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function cleanSystemArchiveTypes() {
  for (const file of readdirSync(systemArchives).filter(archiveName)) {
    const full = path.join(systemArchives, file);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      console.log(`[linux-packages] discarded ${file}: system-cache symlink`);
      privileged('rm', ['--', full]);
    } else if (!stat.isFile()) throw new Error('System APT archive is not a regular file');
  }
}
function authenticated(entries) {
  const described = entries.flatMap(entry => {
    const result = spawnSync('dpkg-deb', ['--show', '--showformat=${Package}\t${Version}\t${Architecture}', entry.full], { encoding: 'utf8' });
    if (result.status !== 0) return [];
    const [name, version, arch] = result.stdout.trim().split('\t');
    if (!/^[a-z0-9][a-z0-9+.-]*$/.test(name ?? '') || !/^[a-zA-Z0-9.+:~_-]+$/.test(version ?? '') || !/^[a-z0-9-]+$/.test(arch ?? '')) return [];
    // The name suffix is the architecture or, on variant-enabled images, an
    // Architecture-Variant such as amd64v3; the signed record must declare it.
    const parts = entry.file.split('_');
    const variant = parts[2]?.slice(0, -'.deb'.length);
    try {
      if (parts.length !== 3 || parts[0] !== name || decodeURIComponent(parts[1]) !== version || !/^[a-z0-9-]+$/.test(variant)) return [];
    } catch { return []; }
    return [{ ...entry, name, version, arch, variant }];
  });
  if (!described.length) return [];
  // Only records with an archive Filename and SHA256 come from repository
  // indexes; installed-only dpkg status records are not authentication.
  const metadata = spawnSync('apt-cache', ['show', ...new Set(described.map(entry => `${entry.name}=${entry.version}`))],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (metadata.error || metadata.signal || ![0, 100].includes(metadata.status)) throw new Error('Cannot read authenticated APT package metadata');
  const hashes = new Map();
  for (const paragraph of metadata.stdout.split(/\n\s*\n/)) {
    const fields = Object.fromEntries(paragraph.split('\n').flatMap(line => {
      const match = /^([A-Za-z0-9-]+): (.*)$/.exec(line); return match ? [[match[1], match[2]]] : [];
    }));
    if (!fields.Filename || !/^[a-f0-9]{64}$/i.test(fields.SHA256 ?? '')) continue;
    const key = `${fields.Package}\0${fields.Version}\0${fields.Architecture}\0${fields['Architecture-Variant'] ?? fields.Architecture}`;
    if (!hashes.has(key)) hashes.set(key, new Set());
    hashes.get(key).add(fields.SHA256.toLowerCase());
  }
  return described.flatMap(entry => {
    const sha256 = digest(readFileSync(entry.full));
    return hashes.get(`${entry.name}\0${entry.version}\0${entry.arch}\0${entry.variant}`)?.has(sha256) ? [{ ...entry, sha256 }] : [];
  });
}
try {
  if (!['key', 'install'].includes(mode) || !Array.isArray(packages) || !packages.length
    || options.some(value => !/^--(?:group|cache)=/.test(value))) throw new Error('Use key|install --group=rust|resources [--cache=PATH]');
  if (!process.env.ImageOS || !process.env.ImageVersion) throw new Error('Runner image identity is required');
  if (![process.env.ImageOS, process.env.ImageVersion].every(value => /^[a-z0-9._-]+$/i.test(value))) throw new Error('Invalid runner image identity');
  if (!packages.every(name => /^[a-z0-9][a-z0-9+.-]*$/.test(name))) throw new Error('Invalid prerequisite package definition');
  const identity = { schema: 'o8/linux-package-cache/v2', group, packages,
    image: process.env.ImageOS, version: process.env.ImageVersion, arch: process.arch,
    installer: digest(readFileSync(fileURLToPath(import.meta.url))) };
  const key = `linux-packages-v2-${identity.image}-${identity.version}-${identity.arch}-${group}-${digest(JSON.stringify(identity))}`;
  const cache = path.resolve(option('cache') ?? path.join(process.cwd(), '.cache/linux-package-prerequisites', group));
  if (mode === 'key') { output({ key, path: cache }); console.log(key); }
  else {
    if (process.platform !== 'linux') throw new Error('Linux prerequisite installation requires Linux');
    // A cache is transport, not a trust root. Refresh signed metadata on hits
    // too. APT can trust same-size files already in its root-owned cache, so
    // compare their bytes with the signed index before normal installation.
    privileged('apt-get', ['--error-on=any', 'update']);
    cleanSystemArchiveTypes();
    let restored = 0;
    try {
      if (!lstatSync(cache).isDirectory() || lstatSync(cache).isSymbolicLink()) throw new Error('Invalid cache directory');
      const manifest = JSON.parse(readFileSync(path.join(cache, 'manifest.json'), 'utf8'));
      if (manifest.key !== key) throw new Error('Cache identity mismatch');
      const entries = archives(cache);
      const verified = authenticated(entries);
      for (const entry of entries) if (!verified.some(item => item.file === entry.file)) console.log(`[linux-packages] discarded ${entry.file}: signed index mismatch`);
      for (const entry of verified) privileged('install', ['-m', '0644', '--', entry.full, path.join(systemArchives, entry.file)]);
      restored = verified.length;
    } catch (error) {
      console.log(`[linux-packages] cache unavailable; using signed APT resolution (${error.code ?? error.message})`);
    }
    const existing = archives(systemArchives);
    const validExisting = authenticated(existing);
    for (const entry of existing) if (!validExisting.some(item => item.file === entry.file)) {
      console.log(`[linux-packages] discarded ${entry.file}: signed index mismatch`);
      privileged('rm', ['--', entry.full]);
    }
    const before = new Map(validExisting.map(entry => [entry.file, entry.sha256]));
    // Preserve authenticated payloads before installation hooks clean APT's
    // archive directory. Both passes use the normal signed repository state.
    privileged('apt-get', ['--yes', '--no-install-recommends', '--download-only', 'install', ...packages]);
    cleanSystemArchiveTypes();
    const downloaded = archives(systemArchives);
    const verified = authenticated(downloaded);
    if (verified.length !== downloaded.length) throw new Error('APT archive does not match the signed index');
    const source = verified.some(entry => before.get(entry.file) !== entry.sha256) ? 'download' : restored ? 'cache' : 'installed';
    mkdirSync(cache, { recursive: true });
    if (!lstatSync(cache).isDirectory() || lstatSync(cache).isSymbolicLink()) throw new Error('Cache must be a real directory');
    const staging = mkdtempSync(path.join(cache, '.write-'));
    let revision;
    try {
      const records = verified.map(({ file, sha256 }) => ({ file, sha256 }));
      for (const entry of verified) {
        copyFileSync(entry.full, path.join(staging, entry.file));
        renameSync(path.join(staging, entry.file), path.join(cache, entry.file));
      }
      for (const entry of archives(cache)) if (!records.some(record => record.file === entry.file)) rmSync(entry.full);
      revision = digest(JSON.stringify(records));
      writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({ ...identity, key, revision, archives: records }) + '\n');
      renameSync(path.join(staging, 'manifest.json'), path.join(cache, 'manifest.json'));
    } finally { rmSync(staging, { recursive: true, force: true }); }
    privileged('apt-get', ['--yes', '--no-install-recommends', 'install', ...packages]);
    for (const name of packages) {
      const result = spawnSync('dpkg-query', ['-W', '-f=${Status}', name], { encoding: 'utf8' });
      if (result.status !== 0 || result.stdout.trim() !== 'install ok installed') throw new Error('Requested package prerequisites are still missing');
    }
    const result = { source, elapsedMs: Date.now() - started, archives: verified.length, revision };
    output(result); console.log('[linux-packages]', JSON.stringify(result));
  }
} catch (error) { console.error('[linux-packages]', error.message); process.exitCode = 1; }
