import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';

const root = process.cwd();
const require = createRequire(import.meta.url);

describe('built CLI SQLite lookup', () => {
  it.each(['packaged', 'standalone'] as const)('loads the %s module through its own native binding path', (mode) => {
    const directory = mkdtempSync(join(tmpdir(), 'o8-cli-sqlite-'));
    const server = join(directory, 'server');
    const cli = join(server, 'bin', 'o8.mjs');
    const profile = join(directory, 'profile');
    const loadedAddons = join(directory, 'loaded-addons.jsonl');
    const trace = join(directory, 'trace.cjs');
    const env: NodeJS.ProcessEnv = { ...process.env, O8_DATA_DIR: profile, CORTEX_IDE_DATA_DIR: profile,
      O8_WORKER_TOKEN: '', O8_WORKER_PACKET_ID: '', O8_REVIEW_MODE: 'manual' };
    delete env.NODE_OPTIONS;
    const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], {
      cwd: directory, env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let started = false;
    try {
      mkdirSync(join(server, 'bin'), { recursive: true });
      mkdirSync(profile);
      writeFileSync(trace, `const Module = require('node:module');
        const load = Module._extensions['.node'];
        Module._extensions['.node'] = (module, file) => {
          require('node:fs').appendFileSync(${JSON.stringify(loadedAddons)}, JSON.stringify(file) + '\\n');
          return load(module, file);
        };`);
      env.NODE_OPTIONS = `--require=${JSON.stringify(trace)}`;
      for (const name of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
        cpSync(dirname(require.resolve(`${name}/package.json`)), join(server, 'node_modules', name), { recursive: true });
      }
      const moduleRoot = join(server, 'node_modules', 'better-sqlite3');
      const hostBinding = join(moduleRoot, 'build', 'Release', 'better_sqlite3.node');
      let selectedBinding = hostBinding;
      if (mode === 'packaged') {
        copyFileSync(join(root, 'scripts', 'native-addon-runtime.cjs'), join(server, 'native-addon-runtime.cjs'));
        const nativeRuntime = require(join(server, 'native-addon-runtime.cjs'));
        if (process.platform === 'darwin' || (process.platform === 'linux' && nativeRuntime.hasMultiAbiBetterSqlite3)) {
          // Use the production bundle layout, with no build/Release fallback.
          const prebuild = join(moduleRoot, 'prebuilds', `node-v${process.versions.modules}`, `${process.platform}-${process.arch}`);
          mkdirSync(prebuild, { recursive: true });
          selectedBinding = join(prebuild, 'better_sqlite3.node');
          renameSync(hostBinding, selectedBinding);
          rmSync(join(moduleRoot, 'build'), { recursive: true });
        }
        if (process.platform === 'darwin') {
          // The shared loader validates PTY presence, but this fixture only loads SQLite.
          for (const layout of [`node-v${process.versions.modules}/darwin-${process.arch}`, `darwin-${process.arch}`]) {
            const prebuild = join(server, 'node_modules', 'node-pty', 'prebuilds', layout);
            mkdirSync(prebuild, { recursive: true });
            for (const name of ['pty.node', 'spawn-helper']) writeFileSync(join(prebuild, name), 'unused PTY fixture');
          }
        }
      }
      // The listeners are protocol peers; process identity and the provider lock
      // run inside the real bundled CLI, where the lookup regression occurred.
      writeFileSync(join(server, 'server.js'), `require('node:http').createServer((q, r) => {
        r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({product:'o8'}));
      }).listen(Number(process.env.PORT), '127.0.0.1');`);
      writeFileSync(join(server, 'ws-server.mjs'), `import {createServer} from 'node:net';
        createServer(s => s.end()).listen(Number(process.env.WS_PORT), '127.0.0.1');`);
      execFileSync(process.execPath, [join(root, 'cli/esbuild.config.mjs'), '--worker-output', cli], { cwd: root });
      const standaloneCli = join(directory, 'o8.mjs');
      copyFileSync(cli, standaloneCli);
      const version = execFileSync(process.execPath, [standaloneCli, 'version'], { cwd: directory, env, encoding: 'utf8' });
      expect(version).toContain('version');
      const status = JSON.parse(run('serve'));
      started = true;
      expect(status).toMatchObject({ running: true, healthy: true, mode: 'packaged' });
      expect(JSON.parse(run('serve', 'status')).pid).toBe(status.pid);
      expect(existsSync(selectedBinding)).toBe(true);
      // Linux uses /proc for identity and does not open the provider-store lock.
      if (process.platform === 'darwin') {
        expect(existsSync(join(profile, '.provider-keys.lock'))).toBe(true);
        const loaded = readFileSync(loadedAddons, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(loaded).toContain(realpathSync(selectedBinding));
      } else if (process.platform === 'linux') {
        expect(existsSync(join(profile, '.provider-keys.lock'))).toBe(false);
      }
      // Exercise the same bundled bridge explicitly on platforms whose identity
      // checks do not open SQLite, including Linux's multi-ABI packaged layout.
      const probe = join(server, 'bin', 'sqlite-probe.mjs');
      buildSync({ stdin: { contents: `import Database from ${JSON.stringify(join(root, 'cli/src/sqlite-runtime.ts'))};
          const db = new Database(${JSON.stringify(join(profile, 'probe.db'))});
          db.exec('CREATE TABLE probe (value INTEGER)'); db.close();`, resolveDir: root }, outfile: probe,
        bundle: true, platform: 'node', format: 'esm',
        banner: { js: "import { createRequire as probeRequire } from 'node:module'; const require = probeRequire(import.meta.url);" } });
      execFileSync(process.execPath, [probe], { cwd: directory, env });
      expect(existsSync(join(profile, 'probe.db'))).toBe(true);
      const loaded = readFileSync(loadedAddons, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(loaded).toContain(realpathSync(selectedBinding));
      expect(existsSync(join(server, 'build', 'Release', 'better_sqlite3.node'))).toBe(false);
      run('serve', 'stop');
      started = false;
      const receipt = JSON.parse(readFileSync(join(profile, 'serve-stop.json'), 'utf8'));
      expect(receipt).toMatchObject({ confirmedDead: true, cleanupCommitted: true });
      expect(receipt.processes.length).toBeGreaterThanOrEqual(3);
      expect(JSON.parse(run('serve', 'status')).running).toBe(false);
    } finally {
      if (started || existsSync(join(profile, 'serve-state.json'))) run('serve', 'stop');
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it.each([
    ['modern', 'darwin', 'prepareNativeAddons'],
    ['modern', 'linux', 'prepareNativeAddons'],
    ['legacy', 'darwin', 'prepareBetterSqlite3'],
    ['legacy', 'linux', null],
  ] as const)('uses the %s loader on %s', (shape, platform, expected) => {
    const server = mkdtempSync(join(tmpdir(), 'o8-cli-sqlite-loader-'));
    try {
      const calls = join(server, 'calls.json');
      const output = join(server, 'bin', 'runtime.mjs');
      mkdirSync(join(server, 'node_modules', 'better-sqlite3'), { recursive: true });
      writeFileSync(join(server, 'node_modules', 'better-sqlite3', 'index.js'), 'module.exports = {};');
      for (const name of ['server.js', 'ws-server.mjs']) writeFileSync(join(server, name), '');
      const method = (name: string) => `(...args) => require('node:fs').writeFileSync(${JSON.stringify(calls)}, JSON.stringify({name:${JSON.stringify(name)},args}))`;
      writeFileSync(join(server, 'native-addon-runtime.cjs'), `module.exports = {
        prepareBetterSqlite3: ${method('prepareBetterSqlite3')},
        ${shape === 'modern' ? `prepareNativeAddons: ${method('prepareNativeAddons')},` : ''}
      };`);
      buildSync({ entryPoints: [join(root, 'cli/src/sqlite-runtime.ts')], outfile: output,
        bundle: true, platform: 'node', format: 'esm', external: ['better-sqlite3'],
        define: { 'process.platform': JSON.stringify(platform) } });
      execFileSync(process.execPath, [output]);
      if (expected) expect(JSON.parse(readFileSync(calls, 'utf8'))).toEqual({ name: expected, args: [realpathSync(server)] });
      else expect(existsSync(calls)).toBe(false);
    } finally {
      rmSync(server, { recursive: true, force: true });
    }
  });
});
