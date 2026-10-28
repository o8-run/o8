import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
        if (process.platform === 'darwin') {
          // Use the production bundle layout, with no build/Release fallback.
          const prebuild = join(moduleRoot, 'prebuilds', `node-v${process.versions.modules}`, `darwin-${process.arch}`);
          mkdirSync(prebuild, { recursive: true });
          selectedBinding = join(prebuild, 'better_sqlite3.node');
          renameSync(hostBinding, selectedBinding);
          rmSync(join(moduleRoot, 'build'), { recursive: true });
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
      expect(existsSync(join(profile, '.provider-keys.lock'))).toBe(true);
      expect(existsSync(selectedBinding)).toBe(true);
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
});
