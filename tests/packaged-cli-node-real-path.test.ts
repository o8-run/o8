import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Execute the actual CLI export block, with a tiny build input and native ABI
// manifest, then invoke its emitted executable through a relative symlink.
// Optional so this same test also drives the inline shim on the unfixed base.
const packagedCliShim = existsSync('scripts/lib/packaged-cli-shim.mjs')
  ? (await import('../scripts/lib/packaged-cli-shim.mjs')).packagedCliShim : undefined;
const source = readFileSync('scripts/tauri-export.mjs', 'utf8');
const exportBlock = source.slice(source.indexOf('const CLI_BUILD ='), source.indexOf('// ── Sanity check:'));
let root: string;
let tools: string;
let shim: string;
let env: NodeJS.ProcessEnv;
function script(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${content}\n`); chmodSync(file, 0o755);
  return file;
}
function node(file: string, version: string, label: string) {
  return script(file, `if [ "\${1:-}" = --version ]; then echo ${version}; else printf '%s\\n' '${label}' "$@"; fi`);
}
function run() { return spawnSync(shim, ['status', 'two words'], { env, encoding: 'utf8', timeout: 5000 }); }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'o8-packaged-cli-'));
  const server = join(root, 'server');
  mkdirSync(server);
  writeFileSync(join(server, 'native-addon-abis.json'), JSON.stringify({ nodeAbis: { 22: '127', 24: '137' } }));
  mkdirSync(join(root, 'cli'));
  writeFileSync(join(root, 'cli/esbuild.config.mjs'), `import {mkdirSync,writeFileSync} from 'node:fs'; mkdirSync('dist'); for (const name of ['o8.mjs','worker-login.mjs']) writeFileSync('dist/'+name, '');`);
  runInNewContext(exportBlock, { root, server, join, existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, chmodSync,
    execFileSync, packagedCliShim, process, console: { log() {}, warn() {} }, canonicalizeServerOnlyStubEnv: (value: unknown) => value });
  tools = join(root, 'tools'); mkdirSync(tools);
  for (const tool of ['dirname', 'readlink']) symlinkSync(`/usr/bin/${tool}`, join(tools, tool));
  for (const shell of ['zsh', 'bash', 'sh']) script(join(tools, shell), 'command -v node');
  const entry = join(root, 'entry'); mkdirSync(entry);
  shim = join(entry, 'o8'); symlinkSync('../server/bin/o8', shim);
  env = { NODE_ENV: 'test', HOME: root, PATH: tools, HOMEBREW_PREFIX: join(root, 'brew') };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(process.platform === 'win32')('packaged CLI Node selection', () => {
  it('skips login-shell Node 23 and runs a supported later PATH candidate with intact arguments', () => {
    node(join(tools, 'node'), 'v23.6.0', 'unsupported');
    const supported = join(root, 'supported node'); node(join(supported, 'node'), 'v24.1.0', 'supported');
    env.PATH += `:${supported}`;
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['supported', join(root, 'server/bin/o8.mjs'), 'status', 'two words']);
  });
  it('refuses Node 23 with one clear line naming the found version and supported majors', () => {
    node(join(tools, 'node'), 'v23.6.0', 'unsupported');
    const result = run();
    expect(result.status).toBe(127);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().split('\n')).toEqual(['o8: Found Node.js v23.6.0; supported majors: 22 24. Set O8_NODE_BIN to a supported Node.js binary.']);
  });
  it('prefers a supported explicit override over the recorded and PATH runtimes', () => {
    env.O8_NODE_BIN = node(join(root, 'override'), 'v22.1.0', 'override');
    node(join(tools, 'node'), 'v24.1.0', 'path');
    expect(run().stdout.split('\n')[0]).toBe('override');
  });
  it('rejects an unsupported override and revalidates a desktop probe record before PATH', () => {
    env.O8_NODE_BIN = node(join(root, 'override'), 'v23.6.0', 'override');
    const recorded = node(join(root, 'recorded node'), 'v24.1.0', 'recorded');
    mkdirSync(join(root, '.o8'));
    // The cache can contain stale versions and has no final newline.
    writeFileSync(join(root, '.o8/node-abi-cache'), `${env.O8_NODE_BIN}\t0\t0\t22\tv22.0.0\n${recorded}\t0\t0\t24\tv24.1.0`);
    node(join(tools, 'node'), 'v22.1.0', 'path');
    expect(run().stdout.split('\n')[0]).toBe('recorded');
  });
  it('finds an installed nvm runtime when the default is unsupported', () => {
    node(join(tools, 'node'), 'v23.6.0', 'unsupported');
    node(join(root, '.nvm/versions/node/v22.15.0/bin/node'), 'v22.15.0', 'nvm');
    expect(run().stdout.split('\n')[0]).toBe('nvm');
  });
  it('prefers the supported nvm default and finds versioned Homebrew installs', () => {
    node(join(tools, 'node'), 'v23.6.0', 'unsupported');
    node(join(root, '.nvm/versions/node/v22.15.0/bin/node'), 'v22.15.0', 'other');
    node(join(root, '.nvm/versions/node/v24.1.0/bin/node'), 'v24.1.0', 'default');
    mkdirSync(join(root, '.nvm/alias'));
    writeFileSync(join(root, '.nvm/alias/default'), '24');
    expect(run().stdout.split('\n')[0]).toBe('default');
    rmSync(join(root, '.nvm'), { recursive: true });
    node(join(root, 'brew/opt/node@22/bin/node'), 'v22.15.0', 'brew');
    expect(run().stdout.split('\n')[0]).toBe('brew');
  });
  it('falls back to PATH after an unsupported override when no probe record exists', () => {
    env.O8_NODE_BIN = node(join(root, 'override'), 'v23.6.0', 'override');
    node(join(tools, 'node'), 'v22.15.0', 'path');
    expect(run().stdout.split('\n')[0]).toBe('path');
  });
  it('reports a missing runtime without shell errors', () => {
    const result = run();
    expect(result.status).toBe(127); expect(result.stdout).toBe('');
    expect(result.stderr.trim().split('\n')).toEqual(['o8: No Node.js found; supported majors: 22 24. Set O8_NODE_BIN to a supported Node.js binary.']);
  });
  it('keeps the caller stdin and NODE_PATH when a probe record selects Node', () => {
    const recorded = script(join(root, 'recorded node'), `if [ "\${1:-}" = --version ]; then echo v22.1.0; else printf 'NODE_PATH=%s\\n' "\${NODE_PATH:-}"; cat; fi`);
    mkdirSync(join(root, '.o8'));
    writeFileSync(join(root, '.o8/node-abi-cache'), `${recorded}\t0\t0\t22\tv22.1.0\n`);
    symlinkSync('/bin/cat', join(tools, 'cat'));
    env.NODE_PATH = '/caller/modules';
    const result = spawnSync(shim, ['status'], { env, input: 'piped\n', encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('NODE_PATH=/caller/modules\npiped\n');
  });
  it('never runs a node from the working directory through a relative override or empty PATH entry', () => {
    const cwd = join(root, 'untrusted'); mkdirSync(cwd);
    node(join(cwd, 'node'), 'v22.1.0', 'HIJACKED');
    env.O8_NODE_BIN = './node';
    env.PATH = `${tools}::.`;
    const result = spawnSync(shim, ['status'], { env, cwd, encoding: 'utf8', timeout: 5000 });
    expect(result.stdout).not.toContain('HIJACKED');
    expect(result.status).toBe(127);
  });
  it('uses the packaged manifest rather than accepting an unshipped major', () => {
    writeFileSync(join(root, 'server/native-addon-abis.json'), JSON.stringify({ nodeAbis: { 22: '127' } }));
    // Re-export so the packaged shim captures this bundle's supported majors.
    rmSync(join(root, 'cli/dist'), { recursive: true });
    runInNewContext(exportBlock, { root, server: join(root, 'server'), join, existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, chmodSync,
      execFileSync, packagedCliShim, process, console: { log() {}, warn() {} }, canonicalizeServerOnlyStubEnv: (value: unknown) => value });
    node(join(tools, 'node'), 'v24.1.0', 'unshipped');
    const result = run();
    expect(result.status).toBe(127); expect(result.stderr).toContain('supported majors: 22.');
  });
});
