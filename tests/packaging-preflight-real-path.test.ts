import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectBuildTraces, makeIgnoreFn } from 'next/dist/build/collect-build-traces';
import { copyTracedFiles } from 'next/dist/build/utils';
import loadConfig from 'next/dist/server/config';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { Span } from 'next/dist/trace';
import nextConfig from '../next.config';
import { assertMacPackageSize } from '../scripts/lib/mac-package-size.mjs';
import { assertTauriExportInputsSafe } from '../scripts/lib/tauri-export-safety.mjs';
import { FOOTPRINT_BUDGET } from '../scripts/lib/footprint-budget.mjs';

const roots: string[] = [];
const sourceRoot = process.cwd();
const picomatch = createRequire(import.meta.url)('next/dist/compiled/picomatch') as (
  patterns: string[], options: { dot: boolean; contains: boolean },
) => (path: string) => boolean;

function thinMachO(cpuType: number) {
  const binary = Buffer.alloc(32);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(cpuType, 4);
  return binary;
}

function universalMachO() {
  const cpuTypes = [0x01000007, 0x0100000c];
  const slices = cpuTypes.map(thinMachO);
  const binary = Buffer.alloc(8 + slices.length * 20 + slices.reduce((sum, slice) => sum + slice.length, 0));
  binary.writeUInt32BE(0xcafebabe, 0);
  binary.writeUInt32BE(slices.length, 4);
  let offset = 8 + slices.length * 20;
  slices.forEach((slice, index) => {
    const entry = 8 + index * 20;
    binary.writeUInt32BE(cpuTypes[index], entry);
    binary.writeUInt32BE(offset, entry + 8);
    binary.writeUInt32BE(slice.length, entry + 12);
    slice.copy(binary, offset);
    offset += slice.length;
  });
  return binary;
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-package-preflight-')));
  roots.push(root);
  const app = join(root, 'src-tauri/target/universal-apple-darwin/release/bundle/macos/o8.app');
  const server = join(app, 'Contents/Resources/server');
  for (const file of ['server.js', '.next/server/app/page.js', '.next/static/chunks/main.js',
    '.next/required-server-files.json', 'node_modules/better-sqlite3/binding.node']) {
    mkdirSync(dirname(join(server, file)), { recursive: true });
    writeFileSync(join(server, file), `runtime:${file}`);
  }
  for (const name of ['o8', 'speech_recognizer', 'speech-local', 'o8-pi-write', 'o8-next']) {
    mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
    writeFileSync(join(app, 'Contents/MacOS', name), universalMachO(), { mode: 0o755 });
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.742' }));
  return { root, app, server };
}

function putCache(server: string, kind: 'cache' | 'dev' | 'trace' | 'trace-build' = 'cache') {
  const relative = kind === 'dev' ? '.next/dev/cache/turbopack/v16.3.4/00000098.sst'
    : kind === 'cache' ? '.next/cache/webpack/server-production/3.pack'
      : `.next/${kind}`;
  const file = join(server, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'compiler-only');
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('packaging preflight through real filesystem and script entry points', () => {
  it('filters checkout metadata through Next trace processing before its standalone copy', async () => {
    const { root } = fixture();
    const dist = join(root, '.next');
    const route = join(dist, 'server/app/api/fixture/route.js');
    const outside = join(root, 'external-checkout');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep'), 'outside sentinel');
    const privateFiles = ['.git/config', '.env', '.env.production.local', '.mcp.json',
      '.agents/instructions.md', '.claude/settings.json', '.codex/config.toml', '.o8-generated-output-store',
      'packet-explainer.html'];
    const runtimeFiles = ['.next/server/app/api/fixture/route.js', 'node_modules/example/.data/runtime.json',
      'node_modules/example/template.html', 'src/runtime/schema.json', 'public/icon.svg'];
    for (const file of [...privateFiles, ...runtimeFiles]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), `fixture:${file}`);
    }
    const link = '.claude/worktrees/plugin';
    mkdirSync(dirname(join(root, link)), { recursive: true });
    symlinkSync(outside, join(root, link), 'dir');
    writeFileSync(`${route}.nft.json`, JSON.stringify({ version: 1,
      files: [...privateFiles, ...runtimeFiles, link].map(file => relative(dirname(route), join(root, file))) }));
    writeFileSync(join(dist, 'next-server.js.nft.json'), '{"version":1,"files":[]}');
    // Supply a compiler trace, bypassing the expensive framework dependency graph.
    // Next's actual per-route exclusions and standalone copier run unchanged.
    const span = new Span({ name: 'fixture-build' });
    const traceChild = span.traceChild.bind(span);
    vi.spyOn(span, 'traceChild').mockImplementation((name, attrs) => {
      const child = traceChild(name, attrs);
      if (name === 'node-file-trace-build') vi.spyOn(child, 'traceAsyncFn').mockImplementation(async () => undefined as never);
      return child;
    });
    const config = await loadConfig(PHASE_PRODUCTION_BUILD, root, {
      customConfig: { ...nextConfig, outputFileTracingRoot: root }, silent: true,
    });
    const sharedIgnore = makeIgnoreFn(root, config.outputFileTracingExcludes['*']);
    for (const file of [...privateFiles, link]) expect(sharedIgnore(join(root, file)), file).toBe(true);
    for (const file of runtimeFiles) expect(sharedIgnore(join(root, file)), file).toBe(false);
    await collectBuildTraces({ dir: root, distDir: dist, outputFileTracingRoot: root, config,
      nextBuildSpan: span, edgeRuntimeRoutes: {}, staticPages: [], buildTraceContext: { chunksTrace: {
        action: { action: 'annotate', input: [], contextDirectory: root, processCwd: root },
        outputPath: dist, entryNameFilesMap: { 'app/api/fixture/route': [] },
      } } });
    await copyTracedFiles(root, dist, [], ['api/fixture/route'], root, config,
      { version: 3, middleware: {}, functions: {}, sortedMiddleware: [] }, false, false, new Set());
    for (const file of [...privateFiles, link]) expect(existsSync(join(dist, 'standalone', file)), file).toBe(false);
    for (const file of runtimeFiles) expect(readFileSync(join(dist, 'standalone', file), 'utf8')).toBe(`fixture:${file}`);
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('outside sentinel');
    expect(() => assertTauriExportInputsSafe(join(dist, 'standalone'))).not.toThrow();
  });

  it('removes Next explicit environment copies through the production build entry point', () => {
    const { root } = fixture();
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts/bust-stale-patch-cache.mjs'), '');
    const bin = join(root, 'node_modules/next/dist/bin/next.js');
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, `const fs = require('node:fs');
      fs.mkdirSync('.next/standalone/.next/server', { recursive: true });
      for (const name of ['.env', '.env.production']) fs.copyFileSync(name, '.next/standalone/' + name);
      fs.writeFileSync('.next/standalone/.next/server/runtime.js', 'runtime');`);
    for (const name of ['.env', '.env.production']) writeFileSync(join(root, name), 'SYNTHETIC_FIXTURE=preserve-source');
    const result = spawnSync(process.execPath, [join(sourceRoot, 'scripts/build.mjs')], {
      cwd: root, encoding: 'utf8', timeout: 20_000,
      env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: root },
    });
    expect(result.status, result.stderr).toBe(0);
    for (const name of ['.env', '.env.production']) {
      expect(existsSync(join(root, '.next/standalone', name)), name).toBe(false);
      expect(readFileSync(join(root, name), 'utf8')).toBe('SYNTHETIC_FIXTURE=preserve-source');
    }
    expect(readFileSync(join(root, '.next/standalone/.next/server/runtime.js'), 'utf8')).toBe('runtime');
  });

  it('refuses a standalone asset link that detours outside before resolving back inside', () => {
    const { root, server } = fixture();
    const outside = join(root, 'outside-link');
    const asset = join(server, 'public/linked');
    symlinkSync(join(server, '.next'), outside, 'dir');
    mkdirSync(dirname(asset), { recursive: true });
    symlinkSync(outside, asset, 'dir');
    expect(() => assertTauriExportInputsSafe(server)).toThrow('standalone asset link escapes the package');
    expect(readFileSync(join(server, '.next/server/app/page.js'), 'utf8')).toContain('runtime:');
  });

  it.each(['next', 'standalone', 'environment'])('refuses linked %s output before removing an environment copy', kind => {
    const { root } = fixture();
    const outside = join(root, 'outside-output');
    mkdirSync(join(outside, 'standalone'), { recursive: true });
    for (const parent of [outside, join(outside, 'standalone')]) writeFileSync(join(parent, '.env'), 'outside sentinel');
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/bust-stale-patch-cache.mjs'), '');
    const bin = join(root, 'node_modules/next/dist/bin/next.js');
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, `const fs = require('node:fs');
      const outside = ${JSON.stringify(outside)};
      const kind = ${JSON.stringify(kind)};
      if (kind === 'next') fs.symlinkSync(outside, '.next', 'dir');
      else {
        fs.mkdirSync('.next', { recursive: true });
        if (kind === 'standalone') fs.symlinkSync(outside, '.next/standalone', 'dir');
        else {
          fs.mkdirSync('.next/standalone');
          fs.symlinkSync(outside + '/.env', '.next/standalone/.env');
        }
      }`);
    const result = spawnSync(process.execPath, [join(sourceRoot, 'scripts/build.mjs')], {
      cwd: root, encoding: 'utf8', timeout: 20_000,
      env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: root },
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(kind === 'environment'
      ? 'Standalone environment copy must be a regular generated file.'
      : 'Standalone output must be an isolated generated directory.');
    for (const parent of [outside, join(outside, 'standalone')]) expect(readFileSync(join(parent, '.env'), 'utf8')).toBe('outside sentinel');
  });

  it.each(['.git/config', '.env.local', '.mcp.json', '.claude/settings.json', '.codex/config.toml', '.agents/rules.md'])(
    'refuses checkout metadata %s before the actual exporter clears staging', file => {
      const { root } = fixture();
      const standalone = join(root, '.next/standalone');
      mkdirSync(dirname(join(standalone, file)), { recursive: true });
      writeFileSync(join(standalone, file), 'synthetic metadata');
      mkdirSync(join(root, 'out'));
      writeFileSync(join(root, 'out/keep'), 'previous staging');
      for (const script of ['tauri-export.mjs', 'native-bundle.mjs', 'tauri-hook-resources.mjs', 'run-lib.mjs',
        'lib/release-config.mjs', 'lib/tauri-export-safety.mjs', 'lib/packaged-build-inputs.mjs',
        'next/verify-app-bundle.mjs', 'next/build-identity.mjs', 'lib/macos-release-artifacts.mjs']) {
        const destination = join(root, 'scripts', script);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(join(sourceRoot, 'scripts', script), destination);
      }
      const result = spawnSync(process.execPath, [join(root, 'scripts/tauri-export.mjs')], {
        cwd: root, encoding: 'utf8', timeout: 10_000, env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: root },
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
      expect(result.stderr).toContain('standalone build contains checkout metadata');
      expect(readFileSync(join(root, 'out/keep'), 'utf8')).toBe('previous staging');
      expect(readFileSync(join(standalone, file), 'utf8')).toBe('synthetic metadata');
    },
  );
  it.each(['missing', 'existing', 'repo-denied', 'releases-denied', 'limited', 'ambiguous', 'wrong-tag', 'invalid-json', 'output-existing', 'output-bound', 'output-linked'] as const)(
    'checks release absence through the actual preflight with REST response %s', (scenario) => {
      const f = fixture();
      mkdirSync(join(f.root, '.tauri'));
      writeFileSync(join(f.root, '.tauri/cortex-ide.key'), 'fixture-key');
      writeFileSync(join(f.root, 'o8.release.json'), JSON.stringify({
        clerkPublishableKey: 'pk_test_synthetic', githubOAuthClientId: 'synthetic',
        sentryDsn: 'https://synthetic@example.invalid/1',
      }));
      const existingOutput = scenario.startsWith('output-');
      if (existingOutput) {
        if (scenario === 'output-linked') {
          symlinkSync(join(f.root, 'missing-output'), join(f.root, '.next'), 'dir');
        } else {
          mkdirSync(join(f.root, '.next'));
          writeFileSync(join(f.root, '.next', 'keep'), 'existing-output');
        }
        if (scenario === 'output-bound') writeFileSync(join(f.root, '.o8-generated-output-store'), 'existing-store');
      }
      const log = join(f.root, 'preflight-calls.jsonl');
      const childProcess = `import { appendFileSync } from 'node:fs';
export function execFileSync() { throw new Error('UNEXPECTED_PLATFORM_EXEC'); }
export function spawnSync(command, args) {
  appendFileSync(process.env.O8_PREFLIGHT_TEST_LOG, JSON.stringify({command, args}) + '\\n');
  const ok = stdout => ({ status: 0, stdout, stderr: '' });
  const fail = stderr => ({ status: 1, stdout: '', stderr });
  const scenario = process.env.O8_PREFLIGHT_TEST_SCENARIO;
  if (command === 'git') {
    if (args[0] === 'rev-parse' || args[0] === 'rev-list') return ok('a'.repeat(40));
    if (args[0] === 'ls-remote') return ok('a'.repeat(40) + '\\trefs/tags/v0.1.742');
    if (args[0] === 'remote') return ok('https://github.com/example/release-repo.git');
    return ok('');
  }
  if (command === 'gh') {
    if (args[0] === '--version') return ok('fixture-version');
    if (args[0] !== 'api') return fail('GraphQL: API rate limit already exceeded');
    if (args[1] === 'repos/example/release-repo') {
      return scenario === 'repo-denied' ? fail('gh: Not Found (HTTP 404)')
        : ok(JSON.stringify({ full_name: 'example/release-repo' }));
    }
    if (args[1] === 'repos/example/release-repo/releases?per_page=1') {
      return scenario === 'releases-denied' ? fail('gh: Not Found (HTTP 404)') : ok('[]');
    }
    if (args[1] !== 'repos/example/release-repo/releases/tags/v0.1.742') throw new Error('unexpected endpoint');
    if (scenario === 'limited') return fail('gh: rate limit exceeded (HTTP 403)');
    if (scenario === 'ambiguous') return fail('connection not found');
    if (scenario === 'existing') return ok(JSON.stringify({ tag_name: 'v0.1.742' }));
    if (scenario === 'wrong-tag') return ok(JSON.stringify({ tag_name: 'v0.1.741' }));
    if (scenario === 'invalid-json') return ok('not-json');
    return fail('gh: Not Found (HTTP 404)');
  }
  return ok(command === 'ps' ? '' : 'fixture-version');
}`;
      writeFileSync(join(f.root, 'preflight-loader.mjs'), `export async function load(url, context, nextLoad) {
  return url === 'node:child_process' ? { format: 'module', shortCircuit: true, source: ${JSON.stringify(childProcess)} } : nextLoad(url, context);
}`);
      writeFileSync(join(f.root, 'preflight-register.mjs'), "import { register } from 'node:module'; register(new URL('./preflight-loader.mjs', import.meta.url));");
      const result = spawnSync(process.execPath, ['--import', join(f.root, 'preflight-register.mjs'), join(sourceRoot, 'scripts/ship-preflight.mjs')], {
        cwd: f.root, encoding: 'utf8', timeout: 10_000,
        env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: f.root,
          APPLE_SIGNING_IDENTITY: 'fixture', APPLE_ID: 'fixture', APPLE_PASSWORD: 'fixture', APPLE_TEAM_ID: 'fixture',
          O8_RELEASE_MIN_FREE_GIB: '0.001', O8_PREFLIGHT_TEST_LOG: log, O8_PREFLIGHT_TEST_SCENARIO: scenario },
      });
      expect(existsSync(log), result.stderr).toBe(true);
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { command: string; args: string[] });
      const github = calls.filter(call => call.command === 'gh' && call.args[0] !== '--version');
      expect(github.every(call => call.args[0] === 'api'), result.stderr).toBe(true);
      expect(github[0]?.args[1]).toBe('repos/example/release-repo');
      expect(github.length).toBe(scenario === 'repo-denied' ? 1 : scenario === 'releases-denied' ? 2 : 3);
      expect(result.status, result.stderr).toBe(scenario === 'missing' ? 0 : 1);
      if (scenario === 'missing') expect(result.stdout).toContain('preflight passed for v0.1.742');
      else if (existingOutput) {
        expect(result.stderr).toMatch(/\.next.*already exists/);
        expect(result.stderr).toContain('clean release checkout');
        expect(result.stdout).not.toContain('preflight passed');
        expect(calls.some(call => call.args.includes('scripts/bench/quick.mjs'))).toBe(false);
        if (scenario !== 'output-linked') expect(readFileSync(join(f.root, '.next', 'keep'), 'utf8')).toBe('existing-output');
        if (scenario === 'output-bound') expect(readFileSync(join(f.root, '.o8-generated-output-store'), 'utf8')).toBe('existing-store');
      } else expect(result.stderr).toMatch(/could not verify|already exists|invalid.*release/i);
      expect(calls.some(call => ['npm', 'cargo', 'codesign', 'xcrun'].includes(call.command)
        && !call.args.includes('--version'))).toBe(false);
    },
  );

  it('keeps development startup from rewriting repository-authored agent instructions', () => {
    expect(nextConfig.agentRules).toBe(false);
  });

  it('uses the tracing matcher to exclude build-only output without excluding runtime assets', () => {
    const patterns = nextConfig.outputFileTracingExcludes!['*'].map(pattern => join(sourceRoot, pattern));
    const excluded = picomatch(patterns, { dot: true, contains: true });
    for (const file of ['.next/cache/.tsbuildinfo', '.next/cache/webpack/server-production/3.pack',
      '.next/cache/webpack/client-production/index.pack.old',
      '.next/dev/cache/turbopack/v16.3.4/00000098.sst', '.next/dev/server/app/page.js',
      '.next/trace', '.next/trace-build']) {
      expect(excluded(join(sourceRoot, file)), file).toBe(true);
    }
    for (const file of ['.next/server/app/page.js', '.next/static/chunks/main.js',
      '.next/prerender-manifest.json', '.next/required-server-files.json',
      '.next/server/app/page.js.nft.json', '.next/next-server.js.nft.json',
      'node_modules/better-sqlite3/binding.node']) {
      expect(excluded(join(sourceRoot, file)), file).toBe(false);
    }
  });

  it.each(['cache', 'dev', 'trace', 'trace-build'] as const)('rejects build-only %s and a dangling link without changing input', (kind) => {
    const f = fixture();
    const cacheFile = putCache(f.server, kind);
    expect(() => assertTauriExportInputsSafe(f.server)).toThrow(`contains .next/${kind}`);
    expect(readFileSync(cacheFile, 'utf8')).toBe('compiler-only');
    const linked = fixture();
    symlinkSync(join(linked.root, 'missing-cache'), join(linked.server, '.next', kind), 'dir');
    expect(() => assertTauriExportInputsSafe(linked.server)).toThrow(`contains .next/${kind}`);
  });

  it.each(['cache', 'dev', 'trace', 'trace-build'] as const)('rejects traced %s before the actual exporter clears previous staging', (kind) => {
    const f = fixture();
    const standalone = join(f.root, '.next/standalone');
    const cacheFile = putCache(standalone, kind);
    const sentinel = join(f.root, 'out/keep.txt');
    mkdirSync(dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, 'previous-output');
    for (const file of ['tauri-export.mjs', 'native-bundle.mjs', 'tauri-hook-resources.mjs',
      'run-lib.mjs', 'lib/release-config.mjs', 'lib/tauri-export-safety.mjs', 'lib/packaged-build-inputs.mjs',
      'next/verify-app-bundle.mjs', 'next/build-identity.mjs', 'lib/macos-release-artifacts.mjs']) {
      const destination = join(f.root, 'scripts', file);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(sourceRoot, 'scripts', file), destination);
    }
    const result = spawnSync(process.execPath, [join(f.root, 'scripts/tauri-export.mjs')], {
      cwd: f.root, encoding: 'utf8', timeout: 10_000,
      env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: f.root },
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(`contains .next/${kind}`);
    expect(readFileSync(sentinel, 'utf8')).toBe('previous-output');
    expect(readFileSync(cacheFile, 'utf8')).toBe('compiler-only');
  });

  it('measures a fresh archive and preserves runtime files and an older updater', () => {
    const f = fixture();
    writeFileSync(`${f.app}.tar.gz`, 'older-updater');
    const result = assertMacPackageSize(f.app);
    expect(result.appBundleBytes).toBeGreaterThan(0);
    expect(result.updaterArchiveBytes).toBeGreaterThan('older-updater'.length);
    expect(result.updaterArchiveBytes).toBeLessThan(FOOTPRINT_BUDGET.regressionCeilings.updaterArchiveBytes);
    expect(readFileSync(`${f.app}.tar.gz`, 'utf8')).toBe('older-updater');
    expect(readFileSync(join(f.server, '.next/static/chunks/main.js'), 'utf8')).toBe('runtime:.next/static/chunks/main.js');
    expect(existsSync(join(f.server, 'node_modules/better-sqlite3/binding.node'))).toBe(true);
    expect(() => assertMacPackageSize(f.app, join(f.root, 'missing.tar.gz'))).toThrow();
  });

  it('rejects an oversized final archive without deleting the evidence', () => {
    const f = fixture();
    const archive = `${f.app}.tar.gz`;
    writeFileSync(archive, 'final-archive');
    truncateSync(archive, FOOTPRINT_BUDGET.regressionCeilings.updaterArchiveBytes + 1);
    expect(() => assertMacPackageSize(f.app, archive)).toThrow('updaterArchiveBytes');
    expect(existsSync(archive)).toBe(true);
  });

  it('uses the shared package ceiling and preserves oversized archive evidence', () => {
    const f = fixture();
    const archive = `${f.app}.tar.gz`;
    writeFileSync(archive, 'final-archive');
    truncateSync(archive, 95 * 1024 * 1024);
    expect(assertMacPackageSize(f.app, archive).updaterArchiveBytes).toBe(95 * 1024 * 1024);
    truncateSync(archive, 100 * 1024 * 1024);
    expect(assertMacPackageSize(f.app, archive).updaterArchiveBytes).toBe(100 * 1024 * 1024);
    truncateSync(archive, 100 * 1024 * 1024 + 1);
    expect(() => assertMacPackageSize(f.app, archive)).toThrow('updaterArchiveBytes');
    expect(existsSync(archive)).toBe(true);
  });

  it.each(['bundle', 'archive', 'cache', 'dev', 'trace', 'trace-build', 'safe', 'missing-sidecar'] as const)(
    'guards the actual signing entry point for %s input before platform operations', (scenario) => {
      const f = fixture();
      if (scenario === 'missing-sidecar') rmSync(join(f.app, 'Contents/MacOS/o8-next'));
      const buildOnly = scenario === 'cache' || scenario === 'dev' || scenario === 'trace' || scenario === 'trace-build';
      if (buildOnly) putCache(f.server, scenario);
      const log = join(f.root, 'calls.jsonl');
      // Simulate only process/platform edges. The actual signing entry point,
      // size policy, cache guard, stat reads and temp cleanup execute unchanged.
      const childProcess = `import { appendFileSync, readFileSync, writeFileSync, truncateSync } from 'node:fs';
export function spawnSync() { throw new Error('UNEXPECTED_PLATFORM_SPAWN'); }
export function execFileSync(command, args) {
  appendFileSync(process.env.O8_SIZE_TEST_LOG, JSON.stringify({command, args}) + '\\n');
  if (command === 'cat') return readFileSync(args[0], 'utf8');
  if (command === 'du') return process.env.O8_SIZE_TEST_KIB + '\\tfixture\\n';
  if (command === 'tar') {
    writeFileSync(args[1], 'fresh-archive');
    truncateSync(args[1], Number(process.env.O8_SIZE_TEST_ARCHIVE));
    return '';
  }
  throw new Error('PLATFORM_BOUNDARY_REACHED');
}`;
      writeFileSync(join(f.root, 'loader.mjs'), `export async function load(url, context, nextLoad) {
  return url === 'node:child_process' ? { format: 'module', shortCircuit: true, source: ${JSON.stringify(childProcess)} } : nextLoad(url, context);
}`);
      writeFileSync(join(f.root, 'register.mjs'), "import { register } from 'node:module'; register(new URL('./loader.mjs', import.meta.url));");
      const ceilings = FOOTPRINT_BUDGET.regressionCeilings;
      const result = spawnSync(process.execPath, ['--import', join(f.root, 'register.mjs'), join(sourceRoot, 'scripts/sign-and-notarize.mjs')], {
        cwd: f.root, encoding: 'utf8', timeout: 10_000,
        env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: f.root, TMPDIR: f.root,
          APPLE_SIGNING_IDENTITY: 'fixture', APPLE_ID: 'fixture', APPLE_PASSWORD: 'fixture', APPLE_TEAM_ID: 'fixture',
          O8_SIZE_TEST_LOG: log, O8_SIZE_TEST_KIB: String(scenario === 'bundle' ? ceilings.appBundleBytes / 1024 + 1 : 8),
          O8_SIZE_TEST_ARCHIVE: String(scenario === 'archive' ? ceilings.updaterArchiveBytes + 1 : 16) },
      });
      expect(result.status).toBe(1);
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { command: string });
      if (scenario === 'safe') {
        expect(result.stderr).toContain('PLATFORM_BOUNDARY_REACHED');
        expect(calls.at(-1)?.command).toBe('codesign');
      } else if (scenario === 'missing-sidecar') {
        expect(result.stderr).toContain('Contents/MacOS/o8-next is missing from the macOS app bundle');
        expect(calls.every(call => call.command === 'cat')).toBe(true);
      } else {
        expect(result.stderr).toContain(buildOnly ? `contains .next/${scenario}`
          : scenario === 'bundle' ? 'appBundleBytes' : 'updaterArchiveBytes');
        expect(calls.every(call => ['cat', 'du', 'tar'].includes(call.command))).toBe(true);
      }
      expect(readdirSync(f.root).filter(name => name.startsWith('o8-package-size-'))).toEqual([]);
    },
  );

  it.each([false, true])('packages through the actual entry point with existing DMG parent=%s', (existingParent) => {
    const f = fixture();
    const bundle = dirname(dirname(f.app));
    const dmgParent = join(bundle, 'dmg');
    const dmg = join(dmgParent, 'o8_0.1.742_universal.dmg');
    const sentinel = join(dmgParent, 'keep.txt');
    if (existingParent) {
      mkdirSync(dmgParent);
      writeFileSync(sentinel, 'unrelated-output');
      writeFileSync(dmg, 'previous-image');
    }
    expect(existsSync(dmgParent)).toBe(existingParent);
    mkdirSync(join(f.root, '.tauri'));
    writeFileSync(join(f.root, '.tauri/cortex-ide.key'), 'fixture-key');
    const log = join(f.root, 'calls.jsonl');
    // Real app/archive/filesystem validation runs. Only signing/notary and
    // platform process edges are simulated; no Apple tool or credential is used.
    const childProcess = `import { appendFileSync, cpSync, existsSync, writeFileSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
const real = process.getBuiltinModule('node:child_process');
export function spawnSync() { throw new Error('UNEXPECTED_PLATFORM_SPAWN'); }
export function execFileSync(command, args = [], options = {}) {
  appendFileSync(process.env.O8_DMG_TEST_LOG, JSON.stringify({ command, args }) + '\\n');
  if (['cat', 'du', 'tar'].includes(command)) return real.execFileSync(command, args, options);
  if (command === '/usr/bin/ditto') { cpSync(args[0], args[1], { recursive: true }); return ''; }
  if (command === 'hdiutil') {
    if (args[0] !== 'create') throw new Error('unexpected image operation');
    const destination = args.at(-1);
    if (!existsSync(dirname(destination))) throw new Error('DMG_DESTINATION_PARENT_MISSING');
    const staging = args[args.indexOf('-srcfolder') + 1];
    if (!existsSync(join(staging, 'o8.app/Contents/MacOS/o8'))
      || readlinkSync(join(staging, 'Applications')) !== '/Applications') throw new Error('invalid staging');
    writeFileSync(destination, 'fixture-image');
    return '';
  }
  if (command === 'cargo') { writeFileSync(args.at(-1) + '.sig', 'fixture-signature'); return ''; }
  if (['file', 'codesign', 'ditto', 'xcrun'].includes(command)) return '';
  throw new Error('unexpected process: ' + command);
}`;
    // The production script's fixed notary zip must never touch another fixture
    // or host artifact. All other filesystem operations execute unchanged.
    const fileSystem = `const fs = process.getBuiltinModule('node:fs');
export const { appendFileSync, writeFileSync, readdirSync, statSync, readFileSync, mkdirSync, symlinkSync, cpSync,
  lstatSync, mkdtempSync, readlinkSync, realpathSync, closeSync, openSync, readSync, chmodSync, renameSync } = fs;
export const existsSync = path => path === '/tmp/o8-notarize.zip' ? false : fs.existsSync(path);
export const rmSync = (path, options) => {
  if (path === '/tmp/o8-notarize.zip') throw new Error('unexpected shared zip removal');
  return fs.rmSync(path, options);
};`;
    writeFileSync(join(f.root, 'loader.mjs'), `const modules = ${JSON.stringify({ 'node:child_process': childProcess, 'node:fs': fileSystem })};
export async function load(url, context, nextLoad) {
  return modules[url] ? { format: 'module', shortCircuit: true, source: modules[url] } : nextLoad(url, context);
}`);
    writeFileSync(join(f.root, 'register.mjs'), "import { register } from 'node:module'; register(new URL('./loader.mjs', import.meta.url));");
    const result = spawnSync(process.execPath, ['--import', join(f.root, 'register.mjs'), join(sourceRoot, 'scripts/sign-and-notarize.mjs')], {
      cwd: f.root, encoding: 'utf8', timeout: 15_000,
      env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: f.root, TMPDIR: f.root,
        APPLE_SIGNING_IDENTITY: 'fixture', APPLE_ID: 'fixture', APPLE_PASSWORD: 'fixture', APPLE_TEAM_ID: 'fixture',
        O8_DMG_TEST_LOG: log },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(dmg, 'utf8')).toBe('fixture-image');
    expect(existsSync(join(bundle, 'dmg-staging'))).toBe(false);
    if (existingParent) expect(readFileSync(sentinel, 'utf8')).toBe('unrelated-output');
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { command: string; args: string[] });
    const image = calls.findIndex(call => call.command === 'hdiutil');
    expect(calls[image].args).toEqual(['create', '-volname', 'o8 0.1.742', '-srcfolder', join(bundle, 'dmg-staging'), '-ov', '-format', 'ULMO', dmg]);
    expect(calls[image - 2].command).toBe('cargo');
    expect(calls[image - 1]).toEqual({ command: '/usr/bin/ditto', args: [f.app, join(bundle, 'dmg-staging', 'o8.app')] });
    expect(calls.slice(image + 1).map(call => [call.command, ...call.args.slice(0, 2)])).toEqual([
      ['codesign', '--force', '--sign'],
      ['xcrun', 'notarytool', 'submit'],
      ['xcrun', 'stapler', 'staple'],
      ['xcrun', 'stapler', 'validate'],
    ]);
  });

});
