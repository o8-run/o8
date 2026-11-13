import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, expect, it, vi } from 'vitest';
const location = vi.hoisted(() => ({ url: '' }));
vi.mock('@/lib/pi/sdk/scripts', async original => {
  const actual = await original<typeof import('@/lib/pi/sdk/scripts')>();
  const resolve = (env = process.env) => (actual.piWriteHelperPath as (env: NodeJS.ProcessEnv, url: string) => string)(env, location.url);
  return { ...actual, piWriteHelperPath: resolve, nativeProcessHelperPath: resolve };
});
import { execDependencyInstallProcess } from '@/lib/workspace/dependency-install-process';
const root = mkdtempSync(join(tmpdir(), 'o8-helper-discovery-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function supervisorFixture(file: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '#!/usr/bin/env node\nconst fs=require("node:fs"),cp=require("node:child_process");const r=cp.spawnSync(process.argv[4],process.argv.slice(5),{stdio:"inherit"});fs.writeSync(3,JSON.stringify({confirmed:true}));process.exit(r.status??1);\n');
  chmodSync(file, 0o755);
}

it.each(['source', 'packaged'])('supervises preparation from a packet cwd using %s server resources', async kind => {
  const server = join(root, kind);
  location.url = pathToFileURL(kind === 'source' ? join(server, 'src/lib/pi/sdk/scripts.ts') : join(server, 'Contents/Resources/server/helper.mjs')).href;
  const helper = kind === 'source' ? join(server, 'src-tauri/sidecars/pi-write/target/release/o8-pi-write') : join(server, 'Contents/MacOS/o8-pi-write');
  supervisorFixture(helper);
  if (kind === 'source') writeFileSync(join(server, 'package.json'), JSON.stringify({ name: 'o8' }));
  const packet = join(root, `packet-${kind}`); mkdirSync(packet);
  const cwd = process.cwd();
  vi.stubEnv('O8_PI_WRITE_BIN', ''); vi.stubEnv('O8_PACKAGED_APP', kind === 'packaged' ? '1' : '');
  try {
    process.chdir(packet);
    const result = await execDependencyInstallProcess(process.execPath, ['-e', 'console.log("installer reached")'], { cwd: packet, timeout: 5000 });
    expect(result.stdout).toContain('installer reached');
  } finally { process.chdir(cwd); vi.unstubAllEnvs(); }
});

it('refuses a packet-controlled helper when trusted server resources are missing', async () => {
  const server = join(root, 'missing-server'); mkdirSync(server);
  writeFileSync(join(server, 'package.json'), JSON.stringify({ name: 'o8' }));
  location.url = pathToFileURL(join(server, 'src/lib/pi/sdk/scripts.ts')).href;
  const packet = join(root, 'decoy-packet'); mkdirSync(packet);
  supervisorFixture(join(packet, 'src-tauri/sidecars/pi-write/target/release/o8-pi-write'));
  const marker = join(root, 'untrusted-execution');
  const cwd = process.cwd();
  vi.stubEnv('O8_PI_WRITE_BIN', ''); vi.stubEnv('O8_PACKAGED_APP', '');
  try {
    process.chdir(packet);
    await expect(execDependencyInstallProcess(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1],"ran")', marker], { cwd: packet }))
      .rejects.toThrow(/helper.*missing/i);
    expect(existsSync(marker)).toBe(false);
  } finally { process.chdir(cwd); vi.unstubAllEnvs(); }
});
