import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bundleServers, SERVER_ENTRIES } from '../scripts/lib/server-bundles.mjs';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const check = join(process.cwd(), 'scripts/check-server-bundle-size.mjs');
const entries = ['src/ws-server.ts', 'src/lib/ws-server/terminal-host-entry.ts',
  'src/lib/mcp/operator-mcp-server.ts', 'src/lib/mcp/operator-mcp-server-bundle-entry.ts',
  'src/lib/mcp/operator-mcp-proxy.ts', 'src/lib/codex/app-server-exec-bridge.ts',
  'src/lib/mcp/cortex-mcp-server.ts'];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-size-check-'));
  roots.push(root);
  for (const entry of entries) {
    mkdirSync(dirname(join(root, entry)), { recursive: true });
    writeFileSync(join(root, entry), 'console.log("small fixture");\n');
  }
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/server-only-stub.js'), '');
  const budget = join(root, 'budget.json');
  writeFileSync(budget, JSON.stringify({ outputs: {}, totalBytes: 10_000 }));
  return { root, budget };
}

function run(root: string, budget: string) {
  return spawnSync(process.execPath, [check, '--root', root, '--budget', budget], {
    encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
  });
}

describe('server size check CLI', () => {
  it('keeps the actual server export inside the committed size gate', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'o8-previous-ceiling-'));
    roots.push(temporary);
    const committed = JSON.parse(readFileSync('scripts/server-bundle-budget.json', 'utf8'));
    const previousBudget = join(temporary, 'budget.json');
    writeFileSync(previousBudget, JSON.stringify({ ...committed,
      totalBytes: Math.min(committed.totalBytes, 13_077_919) }));
    const result = spawnSync(process.execPath, [check, '--budget', previousBudget], {
      encoding: 'utf8', timeout: 120_000,
      env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Server bundle size check passed.');
    expect(committed.totalBytes + 1_000_000).toBeLessThanOrEqual(14_077_919);
  }, 120_000);

  it('retains upstream copyright and permission notices in exported sidecars', () => {
    const { root } = fixture();
    mkdirSync(join(root, 'licenses'));
    const notice = readFileSync('NOTICE.md', 'utf8');
    const license = readFileSync('licenses/t3code-MIT.txt', 'utf8');
    writeFileSync(join(root, 'NOTICE.md'), notice);
    writeFileSync(join(root, 'licenses/t3code-MIT.txt'), license);
    const outDir = join(root, 'exported');
    bundleServers({ root, outDir });
    expect(readFileSync(join(outDir, 'NOTICE.md'), 'utf8')).toBe(notice);
    expect(readFileSync(join(outDir, 'licenses/t3code-MIT.txt'), 'utf8')).toBe(license);
  });

  it('rejects an oversized export against the unchanged committed total gate', () => {
    const { root } = fixture();
    const committedBudget = join(process.cwd(), 'scripts/server-bundle-budget.json');
    const originalBudget = readFileSync(committedBudget, 'utf8');
    const budget = JSON.parse(originalBudget);
    const ceiling = budget.totalBytes + 1_000_000;
    const oversizedBytes = ceiling + 26_719;
    const entry = join(root, entries[0]);
    writeFileSync(entry, 'console.log("");\n');
    const initial = bundleServers({ root, outDir: join(root, 'sizing') }).outputs
      .reduce((sum, output) => sum + output.bytes, 0);
    writeFileSync(entry, `console.log(${JSON.stringify('x'.repeat(oversizedBytes - initial))});\n`);
    const red = run(root, committedBudget);
    expect(red.status, red.stdout + red.stderr).toBe(1);
    expect(red.stdout).toContain(`total: ${oversizedBytes} bytes (budget ${budget.totalBytes}, delta 1026719)`);
    expect(red.stderr).toContain('total exceeds budget by 1026719 bytes (allowed growth: 1 MB).');
    expect(readFileSync(committedBudget, 'utf8')).toBe(originalBudget);
    console.info(red.stdout.split('\n').filter(line => line.startsWith('total:')).join('\n'));
    console.info(red.stderr.trim());
  });

  it('preserves original framework class identity and HTTP semantics through the packaged launcher', () => {
    const { root } = fixture();
    mkdirSync(join(root, 'scripts/lib'));
    cpSync('scripts/lib/next-server-exports.mjs', join(root, 'scripts/lib/next-server-exports.mjs'));
    symlinkSync(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'junction');
    writeFileSync(join(root, entries[0]), `
      import { NextRequest, NextResponse } from 'next/server';
      import { NextRequest as OriginalRequest } from 'next/dist/server/web/spec-extension/request.js';
      import { NextResponse as OriginalResponse } from 'next/dist/server/web/spec-extension/response.js';
      const request = new NextRequest('http://localhost/api/fixture?value=one', { headers: { cookie: 'fixture=two' } });
      const response = NextResponse.json({ value: request.nextUrl.searchParams.get('value') });
      response.cookies.set('fixture', 'three');
      console.log(JSON.stringify({ sameRequest: NextRequest === OriginalRequest, sameResponse: NextResponse === OriginalResponse,
        instance: response instanceof OriginalResponse, body: await response.json(), cookie: request.cookies.get('fixture').value,
        setCookie: response.cookies.get('fixture').value, continuation: NextResponse.next().headers.get('x-middleware-next'),
        redirect: NextResponse.redirect(new URL('/target', request.url)).status }));
    `);
    const outDir = join(root, 'built');
    bundleServers({ root, outDir });
    writeFileSync(join(outDir, 'native-addon-runtime.cjs'), 'exports.prepareNativeAddons = () => {};');
    const executed = spawnSync(process.execPath, [join(outDir, 'ws-server.mjs')], { encoding: 'utf8', timeout: 10_000 });
    expect(executed.status, executed.stderr).toBe(0);
    expect(JSON.parse(executed.stdout)).toEqual({ sameRequest: true, sameResponse: true, instance: true, body: { value: 'one' },
      cookie: 'two', setCookie: 'three', continuation: '1', redirect: 307 });
  });

  it.each(['native', 'darwin'])('shares the lazy compiler runtime through a packaged CLI against saved source on %s', platform => {
    const { root } = fixture();
    symlinkSync(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'junction');
    const saved = join(root, 'saved.ts');
    writeFileSync(saved, "import type { Value } from './value';\nexport function fixture(value: Value) { return value; }\n");
    writeFileSync(join(root, entries[0]), `
      import { readFileSync } from 'node:fs';
      import { loadTypeScriptCompiler } from ${JSON.stringify(join(process.cwd(), 'src/lib/typescript-compiler.ts'))};
      const [compiler, same] = await Promise.all([loadTypeScriptCompiler(), loadTypeScriptCompiler()]);
      const source = readFileSync(process.argv[2], 'utf8');
      const parsed = compiler.createSourceFile('saved.ts', source, compiler.ScriptTarget.Latest, true);
      const names = [];
      compiler.forEachChild(parsed, node => {
        if (compiler.isFunctionDeclaration(node) && node.name) names.push(node.name.text);
      });
      const config = compiler.parseConfigFileTextToJson('config.json', '{"compilerOptions":{"baseUrl":"."}}');
      console.log(JSON.stringify({ same: compiler === same, names,
        imports: compiler.preProcessFile(source, true, true).importedFiles.map(entry => entry.fileName),
        baseUrl: config.config.compilerOptions.baseUrl }));
    `);
    const outDir = join(root, 'built');
    const report = bundleServers({ root, outDir });
    rmSync(join(root, 'node_modules'), { recursive: true, force: true });
    writeFileSync(join(outDir, 'native-addon-runtime.cjs'), 'exports.prepareNativeAddons = () => {};');
    const preload = join(root, 'platform.cjs');
    writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'darwin' });");
    const executed = spawnSync(process.execPath, [...(platform === 'darwin' ? ['--require', preload] : []), join(outDir, 'ws-server.mjs'), saved], {
      encoding: 'utf8', timeout: 10_000,
    });
    expect(executed.status, executed.stderr).toBe(0);
    expect(JSON.parse(executed.stdout)).toEqual({ same: true, names: ['fixture'], imports: ['./value'], baseUrl: '.' });
    expect(Object.keys(report.metafile.inputs).some(input => /node_modules\/typescript\//.test(input))).toBe(false);
    expect(existsSync(join(outDir, 'node_modules/typescript/lib/typescript.js'))).toBe(true);
  });

  it('excludes orphan lazy chunks and executes retained lazy imports', () => {
    const { root, budget } = fixture();
    writeFileSync(join(root, 'optional.ts'), `
      export const marker = 'entry';
      export async function unusedFeature() { return import('./orphan'); }
    `);
    writeFileSync(join(root, 'orphan.ts'), `export const payload = ${JSON.stringify('unreachable payload '.repeat(90_000))};`);
    writeFileSync(join(root, 'retained.ts'), "export const value = 'reachable lazy import';");
    writeFileSync(join(root, entries[0]), `
      import { marker } from '../optional';
      console.log(marker);
      if (process.argv[2] === 'lazy') console.log((await import('../retained')).value);
    `);
    const checked = run(root, budget);
    expect(checked.status, checked.stdout + checked.stderr).toBe(0);
    const outDir = join(root, 'built');
    const report = bundleServers({ root, outDir });
    expect(report.outputs.some(output => output.budgetKey === 'shared:entry:orphan.ts')).toBe(false);
    expect(report.outputs.some(output => output.budgetKey === 'shared:entry:retained.ts')).toBe(true);
    expect(readdirSync(outDir).sort()).toEqual(report.outputs.map(output => output.file).sort());
    writeFileSync(join(outDir, 'native-addon-runtime.cjs'), 'exports.prepareNativeAddons = () => {};');
    const executed = spawnSync(process.execPath, [join(outDir, 'ws-server.mjs'), 'lazy'], {
      encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    });
    expect(executed.status, executed.stderr).toBe(0);
    expect(executed.stdout.trim().split('\n')).toEqual(['entry', 'reachable lazy import']);
  });

  it('rejects a large dependency imported by an entry and accepts an explicit budget edit', () => {
    const { root, budget } = fixture();
    expect(run(root, budget).status).toBe(0);
    const dependency = join(root, 'node_modules/large-fixture');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'large-fixture', main: 'index.js' }));
    writeFileSync(join(dependency, 'index.js'), `module.exports = ${JSON.stringify('fixture payload '.repeat(100_000))};`);
    writeFileSync(join(root, entries[0]), 'console.log(require("large-fixture"));\n');
    const red = run(root, budget);
    expect(red.status).toBe(1);
    expect(red.stderr).toContain('ws-server-impl.mjs exceeds budget by');
    expect(red.stderr).toContain('total exceeds budget by');
    expect(red.stderr).toContain('1 MB');
    console.info(red.stderr.trim());
    writeFileSync(budget, JSON.stringify({ outputs: { 'ws-server-impl.mjs': 1_600_000 }, totalBytes: 1_650_000 }));
    expect(run(root, budget).status).toBe(0);
  });

  it('allows exactly 1 MB of growth and rejects one more byte for an output or total', () => {
    const { root, budget } = fixture();
    writeFileSync(join(root, entries[0]), `console.log(${JSON.stringify('threshold fixture '.repeat(70_000))});`);
    const outputs = bundleServers({ root, outDir: join(root, 'built') }).outputs;
    const baseline = { outputs: Object.fromEntries(outputs.map(output => [output.budgetKey, output.bytes])),
      totalBytes: outputs.reduce((sum, output) => sum + output.bytes, 0) };
    baseline.outputs['ws-server-impl.mjs'] -= 1_000_000;
    baseline.totalBytes -= 1_000_000;
    writeFileSync(budget, JSON.stringify(baseline));
    expect(run(root, budget).status).toBe(0);
    baseline.outputs['ws-server-impl.mjs']--;
    writeFileSync(budget, JSON.stringify(baseline));
    expect(run(root, budget).stderr).toContain('ws-server-impl.mjs exceeds budget by 1000001');
    baseline.outputs['ws-server-impl.mjs']++;
    baseline.totalBytes--;
    writeFileSync(budget, JSON.stringify(baseline));
    const red = run(root, budget);
    expect(red.status).toBe(1);
    expect(red.stderr).toContain('total exceeds budget by 1000001');
    expect(red.stderr).not.toContain('ws-server-impl.mjs exceeds');
  });

  it('runs every minified launcher with native selection before imports and readable function names', () => {
    const { root } = fixture();
    writeFileSync(join(root, 'common.ts'), `
      import { fileURLToPath } from 'node:url';
      export function namedBundleFixture() {
        return { name: namedBundleFixture.name, stack: new Error('fixture').stack,
          selected: Boolean(globalThis.__nativeSelected), adjacent: fileURLToPath(new URL('./adjacent.txt', import.meta.url)) };
      }
    `);
    for (const entry of entries) writeFileSync(join(root, entry),
      `import { namedBundleFixture } from '${'../'.repeat(entry.split('/').length - 1)}common'; console.log(JSON.stringify(namedBundleFixture()));`);
    const built = join(root, 'built');
    mkdirSync(built);
    const outDir = join(root, 'built-alias');
    symlinkSync(built, outDir, 'junction');
    bundleServers({ root, outDir });
    writeFileSync(join(outDir, 'adjacent.txt'), 'fixture');
    writeFileSync(join(outDir, 'native-addon-runtime.cjs'), 'exports.prepareNativeAddons = () => { globalThis.__nativeSelected = true; };');
    const preload = join(root, 'platform.cjs');
    writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'darwin' });");
    for (const label of Object.keys(SERVER_ENTRIES)) {
      const result = spawnSync(process.execPath, ['--require', preload, join(outDir, `${label}.mjs`)], { encoding: 'utf8', timeout: 5000 });
      expect(result.status).toBe(0);
      const answer = JSON.parse(result.stdout);
      expect(answer.name).toBe('namedBundleFixture');
      expect(answer.stack).toContain('at namedBundleFixture');
      expect(answer.selected).toBe(label !== 'operator-mcp-proxy');
      expect(realpathSync(answer.adjacent)).toBe(realpathSync(join(outDir, 'adjacent.txt')));
    }
  });

  it('checks shared outputs and total bytes even when every entry stays small', () => {
    const { root, budget } = fixture();
    writeFileSync(join(root, 'shared.ts'), `export const payload = ${JSON.stringify('shared fixture '.repeat(100_000))};`);
    for (const entry of entries) writeFileSync(join(root, entry), 'import { payload } from "../../../shared"; console.log(payload);\n'.replace('../../../shared', '../'.repeat(entry.split('/').length - 1) + 'shared'));
    const red = run(root, budget);
    expect(red.status).toBe(1);
    expect(red.stderr).toContain('shared:');
    expect(red.stderr).toContain('exceeds budget by');
    expect(red.stderr).toContain('total exceeds budget by');
  });
});
