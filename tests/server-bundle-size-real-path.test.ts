import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
      expect(answer.selected).toBe(!['operator-mcp-proxy', 'codex-app-bridge'].includes(label));
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
