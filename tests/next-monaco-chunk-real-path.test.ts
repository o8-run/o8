import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join, relative, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

// Cold Linux measurements: 84.8 s before; 82.3 s after when restricted to one
// CPU. Allow 3x that constrained build, rounded up to the next 30 seconds.
const BUILD_TIMEOUT_MS = 270_000;
const FIXTURE_TIMEOUT_MS = BUILD_TIMEOUT_MS + 60_000;

mkdirSync(resolve('work'), { recursive: true });
const root = mkdtempSync(join(resolve('work'), 'monaco-chunk-fixture-'));
const isolated = mkdtempSync(join(tmpdir(), 'o8-syntax-export-'));
let child: ChildProcess | undefined;
let tracedFiles: string[] = [];
let largest = 0;
let fixture: Promise<void> | undefined;
afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const force = setTimeout(() => child?.kill('SIGKILL'), 3_000);
    await exited;
    clearTimeout(force);
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(isolated, { recursive: true, force: true });
});

// Cache the build, including rejection, so both assertions run and fail when
// setup fails. A beforeAll failure would mark those assertions skipped.
function getFixture() {
  return fixture ??= buildFixture();
}

async function buildFixture() {
  const workspace = process.cwd();
  mkdirSync(join(root, 'app'));
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'junction');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
  // Evaluate the shipped configuration with its real directory and callbacks;
  // JSON serialization would silently drop splitChunks predicates.
  writeFileSync(join(root, 'next.config.js'), `
    const fs = require('node:fs');
    const Module = require('node:module');
    const ts = require('typescript');
    const file = ${JSON.stringify(resolve('next.config.ts'))};
    const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017, esModuleInterop: true }
    }).outputText;
    const configModule = new Module(file);
    configModule.filename = file;
    configModule.paths = Module._nodeModulePaths(${JSON.stringify(workspace)});
    configModule._compile(compiled, file);
    const shipped = configModule.exports.default;
    module.exports = { ...shipped,
      outputFileTracingRoot: ${JSON.stringify(workspace)},
      typescript: { ignoreBuildErrors: true },
      // There are only three pages. Extra prerender workers cost more than
      // their work, especially when other test files are building on a Mac.
      experimental: { ...shipped.experimental, cpus: 1 },
      // The fixture links its dependencies from the workspace. Apply the same
      // package exclusions to that location as to a regular local install.
      outputFileTracingExcludes: { ...shipped.outputFileTracingExcludes,
        '*': [ ...shipped.outputFileTracingExcludes['*'],
          ...shipped.outputFileTracingExcludes['*'].filter(value => value.startsWith('**/'))
            .map(value => ${JSON.stringify(relative(root, workspace))} + '/' + value)
        ]
      },
      webpack(config, context) {
        const result = shipped.webpack(config, context);
        result.resolve.alias['@'] = ${JSON.stringify(resolve('src'))};
        return result;
      }
    };
  `);
  writeFileSync(join(root, 'app/layout.js'), 'export default function Layout({children}) { return <html><body>{children}</body></html>; }');
  writeFileSync(join(root, 'app/page.js'), `
    'use client';
    import dynamic from 'next/dynamic';
    // Keep the real editor, languages and all five workers in the client build.
    // Like SourceEditor, Monaco is client-only; an SSR copy adds no coverage.
    const Editor = dynamic(() => import(${JSON.stringify(resolve('src/components/desktop/file-viewer/bundled-monaco.ts'))})
      .then(module => module.loadBundledMonacoEditor()), { ssr: false });
    export default function Page() { return <Editor value="const value = 42" language="typescript" />; }
  `);
  mkdirSync(join(root, 'app/api/highlight'), { recursive: true });
  writeFileSync(join(root, 'app/api/highlight/route.js'), `
    import ${JSON.stringify(resolve('src/components/desktop/pr-panel/pr-code-theme.ts'))};
    import { getSharedHighlighter } from '@pierre/diffs';
    export const dynamic = 'force-dynamic';
    export async function GET() {
      const highlighter = await getSharedHighlighter({ langs: ['typescript', 'python', 'json'], themes: ['o8-pr-code'], preferredHighlighter: 'shiki-js' });
      return Response.json({ langs: highlighter.getLoadedLanguages(), tokens: highlighter.codeToTokens('const value = 42;', { lang: 'typescript', theme: 'o8-pr-code' }).tokens });
    }
  `);
  const started = performance.now();
  try {
    execFileSync(process.execPath, [resolve('node_modules/next/dist/bin/next'), 'build', '--webpack'], {
      cwd: root, env: { PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', NODE_OPTIONS: '--max-old-space-size=8192' },
      stdio: 'pipe', timeout: BUILD_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    });
  } finally {
    console.info(`[monaco-fixture] build elapsed ${Math.round(performance.now() - started)} ms; deadline ${BUILD_TIMEOUT_MS} ms`);
  }
  const chunks = join(root, '.next/static/chunks');
  const vendors = readdirSync(chunks).filter(name => name.startsWith('vendor-monaco') && name.endsWith('.js'));
  expect(vendors.length).toBeGreaterThan(0);
  largest = Math.max(...vendors.map(name => statSync(join(chunks, name)).size));
  tracedFiles = JSON.parse(readFileSync(join(root, '.next/server/app/api/highlight/route.js.nft.json'), 'utf8')).files;
  const exported = join(isolated, 'server');
  cpSync(join(root, '.next/standalone'), exported, { recursive: true });
  const serverDir = join(exported, relative(workspace, root));
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const port = address.port;
  await new Promise<void>(done => reservation.close(() => done()));
  let diagnostic = '';
  child = spawn(process.execPath, [join(serverDir, 'server.js')], { cwd: serverDir,
    env: { PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', PORT: String(port), HOSTNAME: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-2000); });
  let result: { langs: string[]; tokens: Array<Array<{ color?: string }>> } | undefined;
  const startupDeadline = performance.now() + 15_000;
  while (performance.now() < startupDeadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/highlight`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { result = await response.json(); break; }
    } catch { /* the isolated production listener is starting */ }
    await new Promise(done => setTimeout(done, 25));
  }
  expect(result, diagnostic).toBeDefined();
  expect(result!.langs).toEqual(expect.arrayContaining(['typescript', 'python', 'json']));
  expect(result!.tokens.flat().some(token => token.color?.startsWith('var('))).toBe(true);
}

it('keeps worker runtimes out of the main-thread Monaco vendor chunk', async () => {
  await getFixture();
  expect(largest, 'the TypeScript worker compiler must stay in its worker entry').toBeLessThan(8_000_000);
}, FIXTURE_TIMEOUT_MS);

it('serves common highlighting from the isolated export without traced grammar duplicates', async () => {
  await getFixture();
  expect(tracedFiles.filter(file => /node_modules\/@shikijs\/(langs|themes)\/dist\/(?!index\.mjs)[^/]+\.mjs$/.test(file))).toEqual([]);
}, FIXTURE_TIMEOUT_MS);
