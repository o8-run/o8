/** AppImage-only lavapipe closure. Host glibc and compiler runtimes remain host-owned. */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// The copyright covers the whole source package, including build tools. A
// directory reference is not a licence text. Resolve aliases before copying so
// fs.cp never receives a directory or a symlink, and retain each text once.
export function resolveVulkanLicenseFiles(copyright, commonRoot = '/usr/share/common-licenses') {
  const source = realpathSync(copyright);
  if (!statSync(source).isFile()) throw new Error('Expected a regular package copyright file');
  const common = new Map();
  for (const match of readFileSync(source, 'utf8')
    .matchAll(/\/usr\/share\/common-licenses\/([\w.+-]+)/g)) {
    const name = match[1].replace(/\.+$/, '');
    if (!name) continue;
    const target = realpathSync(join(commonRoot, name));
    if (statSync(target).isFile()) common.set(basename(target), { name: basename(target), source: target });
  }
  return { source, common: [...common.values()] };
}

// Present in both the pinned ubuntu:22.04 minimal image and its desktop
// package set. Keep these ABI-compatible base runtimes on the host. LLVM,
// libxml2 and libedit are absent from the minimal image and stay bundled.
const HOST_LIBRARIES = /^(?:ld-linux.*|lib(?:c|m|dl|rt|pthread|resolv|util|gcc_s|stdc\+\+|z|zstd|ffi|tinfo|lzma)\.so(?:\..*)?)$/;

export function assertVulkanInventory(notice, manifest) {
  const table = notice.split('### Bundled file inventory')[1] || '';
  const rows = [...table.matchAll(/^\| `([^`]+)` \| ([\d,]+) \| ([^|]+) \|/gm)];
  const inventory = new Map(rows.map(row => [row[1], { bytes: Number(row[2].replaceAll(',', '')), license: row[3].trim() }]));
  if (inventory.size !== rows.length || inventory.size !== manifest.length
    || manifest.some(file => inventory.get(file.name)?.bytes !== file.bytes
      || (file.license && inventory.get(file.name)?.license !== file.license))) {
    throw new Error('Bundled Vulkan inventory differs from NOTICE.md; review paths, sizes and licences.');
  }
}

// Each ELF resolves only its own private dependencies; children inherit no
// process-wide library search override. Verify the actual dynamic tag too.
export function setOriginRunpath(file, path = '$ORIGIN') {
  execFileSync('patchelf', ['--set-rpath', path, file]);
  const tags = execFileSync('readelf', ['-d', file], { encoding: 'utf8' });
  if (!tags.split('\n').some(line => line.includes('(RUNPATH)') && line.includes(`[${path}]`))) {
    throw new Error(`Missing private RUNPATH for ${basename(file)}`);
  }
}

export function bundleVulkan(appdir) {
  const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const destination = join(appdir, 'usr/lib/o8/vulkan');
  mkdirSync(destination);
  const icd = '/usr/share/vulkan/icd.d/lvp_icd.x86_64.json';
  const descriptor = JSON.parse(readFileSync(icd, 'utf8'));
  const driver = descriptor.ICD.library_path;
  const dependencies = run('ldd', [driver]);
  if (dependencies.includes('not found')) throw new Error('Incomplete lavapipe dependencies');
  const sources = new Map([[basename(driver), driver],
    ['libvulkan.so.1', run('cc', ['-print-file-name=libvulkan.so.1'])]]);
  for (const line of dependencies.split('\n')) {
    const match = line.match(/^\s*(\S+) => (\/\S+)/);
    if (match && !HOST_LIBRARIES.test(match[1])) sources.set(match[1], match[2]);
  }
  const bundled = [];
  const notices = new Map();
  const commonLicenses = new Map();
  for (const [name, source] of sources) {
    const real = realpathSync(source);
    let owner;
    for (const candidate of [source, real, real.replace(/^\/usr\/lib\//, '/lib/')]) {
      try { owner = run('dpkg-query', ['-S', candidate]).split(': /')[0].split(':')[0]; break; }
      catch { /* usr-merged distributions can record the pre-merge path. */ }
    }
    if (!owner) throw new Error(`Missing distribution ownership for ${name}`);
    const target = join(destination, name);
    cpSync(real, target);
    setOriginRunpath(target);
    const licenses = [
      [/^mesa-vulkan-drivers$/, 'MIT'], [/^libvulkan1$/, 'Apache-2.0'], [/^libllvm\d+$/, 'Apache-2.0 WITH LLVM-exception'],
      [/^(?:libdrm2|libexpat1|libxcb.*|libx11.*|libxau6|libxdmcp6|libxshmfence1|libwayland-client0|libffi8|libxml2|libz3-4|libtinfo6)$/, 'MIT/X11'],
      [/^(?:libedit2|libbsd0|libmd0|libzstd1)$/, 'BSD'],
      [/^libicu\d+$/, 'Unicode-DFS-2016'], [/^zlib1g$/, 'Zlib'], [/^liblzma5$/, 'public-domain/permissive'],
    ];
    const license = licenses.find(([pattern]) => pattern.test(owner))?.[1];
    if (!license) throw new Error(`Review redistribution license before bundling ${owner}`);
    const notice = `${owner}-copyright`;
    const legal = resolveVulkanLicenseFiles(`/usr/share/doc/${owner}/copyright`);
    cpSync(legal.source, join(appdir, 'usr/share/doc/o8', notice));
    notices.set(notice, { name: `usr/share/doc/o8/${notice}`, bytes: statSync(join(appdir, 'usr/share/doc/o8', notice)).size });
    for (const file of legal.common) commonLicenses.set(file.name, file.source);
    bundled.push({ name: `usr/lib/o8/vulkan/${name}`, bytes: statSync(target).size, package: owner,
      license, version: run('dpkg-query', ['-W', '-f=${Version}', owner]), notice });
  }
  descriptor.ICD.library_path = './libvulkan_lvp.so';
  writeFileSync(join(destination, 'lvp_icd.json'), JSON.stringify(descriptor, null, 2) + '\n');
  bundled.push({ name: 'usr/lib/o8/vulkan/lvp_icd.json', bytes: statSync(join(destination, 'lvp_icd.json')).size });
  // Debian copyright files reference these common license texts.
  const licenseRoot = join(appdir, 'usr/share/doc/o8/common-licenses');
  mkdirSync(licenseRoot);
  for (const [name, source] of [...commonLicenses].sort()) {
    cpSync(source, join(licenseRoot, name));
    notices.set(`common-licenses/${name}`, { name: `usr/share/doc/o8/common-licenses/${name}`, bytes: statSync(source).size });
  }
  return [...bundled, ...notices.values()];
}
