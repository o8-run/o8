import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createRetainedGeneratedOutputFixture } from './generated-output-fixture';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);

it('builds and rebuilds retained real standalone output from pre-build reservations', async () => {
  const source = process.cwd();
  const root = await createRetainedGeneratedOutputFixture('o8-private-build-');
  const repo = path.join(root, 'repo');
  const data = path.join(root, 'data');
  for (const directory of [repo, data, path.join(repo, 'scripts'), path.join(repo, 'app')]) mkdirSync(directory);
  writeFileSync(path.join(repo, '.gitignore'), '.next\nnode_modules\n');
  writeFileSync(path.join(repo, 'package.json'), '{"name":"o8","version":"0.0.0"}');
  writeFileSync(path.join(repo, 'scripts/bust-stale-patch-cache.mjs'), 'process.exit(0);');
  writeFileSync(path.join(repo, 'app/layout.js'), 'export default function Layout({children}) { return <html><body>{children}</body></html>; }');
  writeFileSync(path.join(repo, 'app/page.js'), 'export default function Page() { return <main>Release fixture</main>; }');
  mkdirSync(path.join(repo, 'src/lib/panel'), { recursive: true });
  writeFileSync(path.join(repo, 'src/lib/panel/preview-document-policy.ts'),
    readFileSync(path.join(source, 'src/lib/panel/preview-document-policy.ts')));
  writeFileSync(path.join(repo, 'next.config.ts'), readFileSync(path.join(source, 'next.config.ts'), 'utf8')
    .replace('experimental: {', 'experimental: { cpus: 1,'));
  symlinkSync(path.join(source, 'node_modules'), path.join(repo, 'node_modules'), 'dir');
  for (const args of [['init', '-q', '--initial-branch=main'], ['add', '.'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']]) await exec('git', args, { cwd: repo });
  const url = (relative: string) => JSON.stringify(pathToFileURL(path.join(source, relative)).href);
  const script = `
    const producer = await import(${url('src/lib/workspace/generated-output-producer.ts')});
    const build = await import(${url('scripts/lib/registered-build.mjs')});
    await (producer.default ?? producer).runGeneratedOutputPrebuild({ workspacePath: process.cwd(), preflight() {},
      operation: context => context.runBuild(run => build.runRegisteredBuild(run)) });
  `;
  for (const generation of [1, 2]) {
    writeFileSync(path.join(repo, 'app/page.js'), `export default function Page() { return <main>Release fixture ${generation}</main>; }`);
    const result = await exec(process.execPath, ['--import', path.join(source, 'scripts/register-server-only-stub.mjs'),
      '--import', require.resolve('tsx'), '--input-type=module', '-e', script], { cwd: repo, timeout: 180_000,
      maxBuffer: 2 * 1024 ** 2, env: { ...process.env, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
        CORTEX_IDE_DB_PATH: path.join(data, 'fixture.db'), TSX_TSCONFIG_PATH: path.join(source, 'tsconfig.json'),
        O8_BUILD_HEAP_MIB: '1024', NEXT_TELEMETRY_DISABLED: '1' } });
    writeFileSync(path.join(root, `compiler-${generation}.log`), result.stdout + result.stderr);
    expect(readFileSync(path.join(repo, '.next/BUILD_ID'), 'utf8').trim()).not.toBe('');
    const entry = readFileSync(path.join(repo, '.next/standalone/server.js'), 'utf8');
    expect(entry).toContain('"distDir":".next"');
    expect(entry).not.toMatch(/"distDir":"\.next\/\.o8-release-/);
    expect(readFileSync(path.join(repo, '.next/standalone/.next/BUILD_ID'), 'utf8').trim()).not.toBe('');
    expect(readFileSync(path.join(repo, '.next/server/app/index.html'), 'utf8')).toContain(`Release fixture ${generation}`);
  }
}, 420_000);
