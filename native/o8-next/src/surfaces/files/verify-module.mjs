// Compile only this surface and its registration against an owned checkout of main.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
const surface = basename(directory);
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: directory, encoding: 'utf8' }).trim();
const base = execFileSync('git', ['rev-parse', process.argv[2] || 'origin/main'], { cwd: root, encoding: 'utf8' }).trim();
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'o8-surface-compile-')));
try {
  execFileSync('git', ['clone', '--shared', '--quiet', '--no-checkout', root, fixture], { stdio: 'pipe' });
  execFileSync('git', ['-C', fixture, 'checkout', '--quiet', '--detach', base], { stdio: 'pipe' });
  const manifest = join(fixture, 'native/o8-next/Cargo.toml');
  let dependencies = readFileSync(manifest, 'utf8');
  for (const name of ['gpui', 'taffy']) {
    dependencies = dependencies.replace(`path = "vendor/${name}"`, 'path = ' + JSON.stringify(join(root, 'native/o8-next/vendor', name)));
  }
  writeFileSync(manifest, dependencies);
  const relative = 'native/o8-next/src/surfaces';
  cpSync(directory, join(fixture, relative, surface), { recursive: true });
  cpSync(join(root, relative, surface + '.rs'), join(fixture, relative, surface + '.rs'));
  const shellPath = 'native/o8-next/src/shell.rs';
  const registration = readFileSync(join(root, shellPath), 'utf8').split('\n').find(line => line.trim().startsWith(surface + ':'));
  if (!registration) throw new Error('Missing surface registration');
  const outside = execFileSync('git', ['diff', '--name-only', base, '--', 'native/o8-next/src'], { cwd: root, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).filter(path => path !== shellPath && path !== relative + '/' + surface + '.rs' && !path.startsWith(relative + '/' + surface + '/'));
  if (outside.length) throw new Error('Shared native files changed: ' + outside.join(', '));
  const actualShell = readFileSync(join(root, shellPath), 'utf8');
  const baselineShell = readFileSync(join(fixture, shellPath), 'utf8');
  const withoutRegistration = baselineShell.includes(registration.trim()) ? actualShell : actualShell.replace(registration + '\n', '');
  if (withoutRegistration !== baselineShell) throw new Error('Only one surface registration line may change');
  let shell = readFileSync(join(fixture, shellPath), 'utf8');
  if (!shell.includes(registration.trim())) shell = shell.replace('tabs {', 'tabs {\n' + registration);
  writeFileSync(join(fixture, shellPath), shell);
  const result = spawnSync('cargo', ['check', '--locked', '--offline', '--manifest-path', join(fixture, 'native/o8-next/Cargo.toml'), '--tests'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Read-only module must compile on main');
  const mainPath = join(fixture, 'native/o8-next/src/main.rs');
  writeFileSync(mainPath, readFileSync(mainPath, 'utf8') + '\nfn forbidden_file_save_probe(client: &crate::client::Client) { let _ = client.save_file(&serde_json::json!({})); }\n');
  const forbidden = spawnSync('cargo', ['check', '--locked', '--offline', '--manifest-path', manifest, '--bin', 'o8-next'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (forbidden.status === 0 || !forbidden.stderr.includes('error[E0599]') || !forbidden.stderr.includes('no method named `save_file`')) throw new Error('A file save API remains reachable');
  console.log('Read-only module compiles; Client::save_file is unavailable (E0599)');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
