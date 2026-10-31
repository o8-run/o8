#!/usr/bin/env node
/** Assemble an unpublished Linux GPUI payload from explicit, already-built inputs. */
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function parse() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('stage-payload.mjs --server EXPORTED_SERVER --node-root NODE_DISTRIBUTION --next-binary O8_NEXT --output NEW_DIRECTORY');
    process.exit(0);
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!['--server', '--node-root', '--next-binary', '--output'].includes(name)
      || !args[i + 1] || args[i + 1].startsWith('--') || options[name]) throw new Error('Invalid staging arguments. See --help.');
    options[name] = resolve(args[i + 1]);
  }
  if (Object.keys(options).length !== 4) throw new Error('All four staging inputs are required. See --help.');
  return options;
}

function assertLinuxX64(file) {
  const header = readFileSync(file).subarray(0, 20);
  if (header.subarray(0, 4).toString('hex') !== '7f454c46' || header[4] !== 2
    || header[5] !== 1 || header.readUInt16LE(18) !== 62) throw new Error('Expected a Linux x64 ELF executable.');
}

function stage() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Stage the Linux x64 payload on Linux x64.');
  const options = parse();
  const server = realpathSync(options['--server']);
  const runtime = realpathSync(options['--node-root']);
  const next = realpathSync(options['--next-binary']);
  const output = options['--output'];
  if (existsSync(output)) throw new Error('Output already exists; choose a new staging directory.');
  const destination = join(realpathSync(dirname(output)), relative(dirname(output), output));
  for (const input of [server, runtime, next, root]) {
    if (input === destination || input.startsWith(destination + sep)
      || (input !== root && destination.startsWith(input + sep))) throw new Error('Staging output overlaps an input.');
  }
  for (const file of ['server.js', 'ws-server.mjs', 'bin/o8.mjs', 'native-addon-runtime.cjs',
    'node_modules/better-sqlite3/package.json', 'node_modules/node-pty/package.json']) {
    if (!existsSync(join(server, file))) throw new Error(`Incomplete exported server: missing ${file}`);
  }
  if (!existsSync(join(runtime, 'LICENSE'))) throw new Error('The Node distribution LICENSE is required.');
  assertLinuxX64(join(runtime, 'bin/node'));
  assertLinuxX64(next);
  const version = spawnSync(join(runtime, 'bin/node'), ['-p', 'JSON.stringify({major:process.versions.node.split(".")[0],platform:process.platform,arch:process.arch})'], { encoding: 'utf8', timeout: 10_000 });
  if (version.error || version.status !== 0) throw new Error('The bundled Node runtime cannot execute.');
  const identity = JSON.parse(version.stdout);
  if (identity.major !== '22' || identity.platform !== 'linux' || identity.arch !== 'x64') throw new Error('The payload requires Linux x64 Node 22.');

  const payload = join(output, 'usr/lib/o8');
  const stagedServer = join(payload, 'server');
  mkdirSync(output); // Exclusive: never replace an existing stage.
  mkdirSync(payload, { recursive: true });
  cpSync(server, stagedServer, { recursive: true, dereference: true });
  cpSync(join(runtime, 'bin/node'), join(payload, 'node'));
  cpSync(next, join(payload, 'o8-next'));
  for (const name of ['node', 'o8-next']) chmodSync(join(payload, name), 0o755);
  const cli = join(stagedServer, 'cli');
  mkdirSync(cli, { recursive: true });
  cpSync(join(stagedServer, 'bin/o8.mjs'), join(cli, 'o8.mjs'));
  if (existsSync(join(stagedServer, 'bin/worker-login.mjs'))) {
    cpSync(join(stagedServer, 'bin/worker-login.mjs'), join(cli, 'worker-login.mjs'));
  }
  buildSync({
    entryPoints: [join(root, 'cli/src/linux-desktop.ts')], outfile: join(cli, 'desktop.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    define: { __O8_CLI_VERSION__: JSON.stringify(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version) },
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  });
  for (const [source, target, executable] of [
    ['scripts/linux/o8', 'usr/bin/o8', true],
    ['scripts/linux/AppRun', 'AppRun', true],
    ['scripts/linux/o8.desktop', 'usr/share/applications/o8.desktop', false],
    ['assets/o8-icon.png', 'usr/share/icons/hicolor/256x256/apps/o8.png', false],
  ]) {
    const destination = join(output, target);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(root, source), destination);
    if (executable) chmodSync(destination, 0o755);
  }
  const doc = join(output, 'usr/share/doc/o8');
  mkdirSync(doc, { recursive: true });
  cpSync(join(runtime, 'LICENSE'), join(doc, 'node-LICENSE'));
  cpSync(join(root, 'LICENSE'), join(doc, 'LICENSE'));
  // Load both shipped native addons with the actual bundled runtime. Never
  // silently accept a stage that only works with the builder's system Node.
  const probe = spawnSync(join(payload, 'node'), ['-e', `
    const { createRequire } = require('node:module');
    const requireServer = createRequire(process.argv[1] + '/package.json');
    requireServer('./native-addon-runtime.cjs').prepareNativeAddons(process.argv[1]);
    const db = requireServer('better-sqlite3')(':memory:');
    if (db.prepare('select 1 as ready').get().ready !== 1) process.exit(1);
    db.close();
    const pty = requireServer('node-pty').spawn(process.execPath,
      ['-e', 'process.stdout.write("payload-pty-ready")'], { name: 'xterm', cols: 80, rows: 24 });
    let output = '';
    pty.onData(data => { output += data; });
    pty.onExit(({ exitCode }) => { process.exit(exitCode === 0 && output.includes('payload-pty-ready') ? 0 : 1); });
  `, stagedServer], { encoding: 'utf8', timeout: 10_000 });
  if (probe.error || probe.status !== 0) throw new Error('Bundled native addon probe failed; the incomplete stage is retained for diagnosis.');
  console.log('Staged Linux x64 o8 next, Node 22, CLI and server; native addons loaded.');
}

try { stage(); } catch (error) {
  console.error(`Linux payload staging failed: ${error.message}`);
  process.exitCode = 1;
}
