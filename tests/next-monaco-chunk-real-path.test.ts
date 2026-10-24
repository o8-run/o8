import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

mkdirSync(resolve('work'), { recursive: true });
const root = mkdtempSync(join(resolve('work'), 'monaco-chunk-fixture-'));
const isolated = mkdtempSync(join(tmpdir(), 'o8-syntax-export-'));
let child: ChildProcess | undefined;
let tracedFiles: string[] = [];
let largest = 0;
afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(isolated, { recursive: true, force: true });
});

beforeAll(async () => {
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
    import { loadBundledMonacoEditor } from ${JSON.stringify(resolve('src/components/desktop/file-viewer/bundled-monaco.ts'))};
    export default function Page() { return <button onClick={() => loadBundledMonacoEditor()}>Open editor</button>; }
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
  execFileSync(process.execPath, [resolve('node_modules/next/dist/bin/next'), 'build', '--webpack'], {
    cwd: root, env: { PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', NODE_OPTIONS: '--max-old-space-size=8192' },
    stdio: 'pipe', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
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
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/highlight`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { result = await response.json(); break; }
    } catch { /* the isolated production listener is starting */ }
    await new Promise(done => setTimeout(done, 25));
  }
  expect(result, diagnostic).toBeDefined();
  expect(result!.langs).toEqual(expect.arrayContaining(['typescript', 'python', 'json']));
  expect(result!.tokens.flat().some(token => token.color?.startsWith('var('))).toBe(true);
}, 150_000);

it('keeps worker runtimes out of the main-thread Monaco vendor chunk', () => {
  expect(largest, 'the TypeScript worker compiler must stay in its worker entry').toBeLessThan(8_000_000);
});

it('serves common highlighting from the isolated export without traced grammar duplicates', () => {
  expect(tracedFiles.filter(file => /node_modules\/@shikijs\/(langs|themes)\/dist\/(?!index\.mjs)[^/]+\.mjs$/.test(file))).toEqual([]);
});
