import { createRequire } from 'node:module';
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Stage the host ABI in the layout shipped by the packaged native selector. */
export function stagePackagedNativeAddons(options: { projectRoot: string; serverRoot: string; platform?: NodeJS.Platform }) {
  const { projectRoot, serverRoot, platform = process.platform } = options;
  const modules = join(serverRoot, 'node_modules');
  for (const name of ['better-sqlite3', 'bindings', 'file-uri-to-path', 'node-pty']) {
    cpSync(join(projectRoot, 'node_modules', name), join(modules, name), { recursive: true });
  }
  cpSync(join(projectRoot, 'scripts/native-addon-runtime.cjs'), join(serverRoot, 'native-addon-runtime.cjs'));
  if (platform !== 'darwin') return;

  // Reuse installed host binaries, without downloads or signing. Only the active
  // ABI/architecture slot is needed to boot these fixtures. The platform override
  // lets Linux exercise the real Darwin selector with its own native binaries.
  const require = createRequire(join(projectRoot, 'package.json'));
  const bindingPath = require('bindings') as (options: { bindings: string; module_root: string; path: boolean }) => string;
  const sqliteSource = bindingPath({ bindings: 'better_sqlite3.node',
    module_root: join(projectRoot, 'node_modules/better-sqlite3'), path: true });
  const abiDirectory = join('prebuilds', `node-v${process.versions.modules}`, `darwin-${process.arch}`);
  const sqliteDestination = join(modules, 'better-sqlite3', abiDirectory);
  mkdirSync(sqliteDestination, { recursive: true });
  cpSync(sqliteSource, join(sqliteDestination, 'better_sqlite3.node'));

  const ptyUtilsPath = require.resolve('node-pty/lib/utils');
  const { loadNativeModule } = require(ptyUtilsPath) as { loadNativeModule(name: string): { dir: string } };
  const ptySource = resolve(dirname(ptyUtilsPath), loadNativeModule('pty').dir);
  const ptyHelper = join(projectRoot, 'node_modules/node-pty/prebuilds', `darwin-${process.arch}`, 'spawn-helper');
  for (const destination of [join(modules, 'node-pty', abiDirectory),
    join(modules, 'node-pty/prebuilds', `darwin-${process.arch}`)]) {
    mkdirSync(destination, { recursive: true });
    cpSync(join(ptySource, 'pty.node'), join(destination, 'pty.node'));
    cpSync(ptyHelper, join(destination, 'spawn-helper'));
  }
  // Match the export: macOS loads immutable prebuilds, never host build outputs.
  for (const name of ['better-sqlite3', 'node-pty']) rmSync(join(modules, name, 'build'), { recursive: true, force: true });
  const ptyPrebuilds = join(modules, 'node-pty/prebuilds');
  for (const name of readdirSync(ptyPrebuilds)) {
    if (name.startsWith('linux-') || name.startsWith('win32-')) rmSync(join(ptyPrebuilds, name), { recursive: true, force: true });
  }
}
