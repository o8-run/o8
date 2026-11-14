/** AppImage-only lavapipe closure. Host glibc and compiler runtimes remain host-owned. */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export function bundleVulkan(appdir) {
  const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
  const destination = join(appdir, 'usr/lib/o8/vulkan');
  mkdirSync(destination);
  const icd = '/usr/share/vulkan/icd.d/lvp_icd.x86_64.json';
  const descriptor = JSON.parse(readFileSync(icd, 'utf8'));
  const driver = descriptor.ICD.library_path;
  const dependencies = run('ldd', [driver]);
  if (dependencies.includes('not found')) throw new Error('Incomplete lavapipe dependencies');
  const host = /^(?:ld-linux.*|lib(?:c|m|dl|rt|pthread|resolv|util|gcc_s|stdc\+\+)\.so(?:\..*)?)$/;
  const sources = new Map([[basename(driver), driver],
    ['libvulkan.so.1', run('cc', ['-print-file-name=libvulkan.so.1'])]]);
  for (const line of dependencies.split('\n')) {
    const match = line.match(/^\s*(\S+) => (\/\S+)/);
    if (match && !host.test(match[1])) sources.set(match[1], match[2]);
  }
  const bundled = [];
  for (const [name, source] of sources) {
    const real = realpathSync(source);
    let owner;
    for (const candidate of [source, real, real.replace(/^\/usr\/lib\//, '/lib/')]) {
      try { owner = run('dpkg-query', ['-S', candidate]).split(': /')[0].split(':')[0]; break; }
      catch { /* usr-merged distributions can record the pre-merge path. */ }
    }
    if (!owner) throw new Error(`Missing distribution ownership for ${name}`);
    cpSync(real, join(destination, name));
    const licenses = [
      [/^mesa-vulkan-drivers$/, 'MIT'], [/^libvulkan1$/, 'Apache-2.0'], [/^libllvm\d+$/, 'Apache-2.0 WITH LLVM-exception'],
      [/^(?:libdrm2|libexpat1|libxcb.*|libx11.*|libxau6|libxdmcp6|libxshmfence1|libwayland-client0|libffi8|libxml2|libz3-4|libicu\d+|libtinfo6)$/, 'MIT/X11'],
      [/^(?:libedit2|libbsd0|libmd0|libzstd1)$/, 'BSD'],
      [/^zlib1g$/, 'Zlib'], [/^liblzma5$/, 'public-domain/permissive'],
    ];
    const license = licenses.find(([pattern]) => pattern.test(owner))?.[1];
    if (!license) throw new Error(`Review redistribution license before bundling ${owner}`);
    const notice = `${owner}-copyright`;
    cpSync(`/usr/share/doc/${owner}/copyright`, join(appdir, 'usr/share/doc/o8', notice));
    bundled.push({ name: `usr/lib/o8/vulkan/${name}`, bytes: statSync(real).size, package: owner,
      license, version: run('dpkg-query', ['-W', '-f=${Version}', owner]), notice });
  }
  descriptor.ICD.library_path = './libvulkan_lvp.so';
  writeFileSync(join(destination, 'lvp_icd.json'), JSON.stringify(descriptor, null, 2) + '\n');
  bundled.push({ name: 'usr/lib/o8/vulkan/lvp_icd.json', bytes: statSync(join(destination, 'lvp_icd.json')).size });
  // Debian copyright files reference these common license texts.
  cpSync('/usr/share/common-licenses', join(appdir, 'usr/share/doc/o8/common-licenses'), { recursive: true, dereference: true });
  return bundled;
}
