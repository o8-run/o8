import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import nextConfig from '../next.config';

it('retries cached native module failures, including embedded grammar failures, through the real highlighter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o8-native-syntax-retry-'));
  const requests: string[] = [];
  let failedName = '';
  let healthy = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname === '/fail') {
      failedName = url.searchParams.get('name')!; healthy = false;
      response.end(); return;
    }
    if (url.pathname === '/ready') { healthy = true; response.end(); return; }
    requests.push(url.pathname);
    const name = url.pathname.split('/').pop()!;
    if (!healthy && name === failedName) {
      response.writeHead(502, { 'Cache-Control': 'no-store' }).end('Temporary fixture failure.'); return;
    }
    const parts = url.pathname.split('/');
    const kind = parts[2] === 'attempt' ? parts[4] : parts[2];
    const source = readFileSync(resolve(`node_modules/@shikijs/${kind}/dist`, name), 'utf8');
    response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(source);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const config = nextConfig.webpack!({ resolve: { alias: {} } }, { dev: false } as never);
    const result = await build({
      stdin: { contents: "import '@/components/desktop/pr-panel/pr-code-theme'; export { preloadHighlighter, getSharedHighlighter } from '@pierre/diffs';", resolveDir: process.cwd() },
      bundle: true, write: false, platform: 'node', format: 'esm', alias: { '@': resolve('src') },
      // The importer and highlighter are real. Only HTTP transport is supplied
      // to Node's native ESM loader, which owns the failed-module cache.
      plugins: [{ name: 'production-syntax-aliases', setup(builder) {
        for (const name of ['shiki', '@pierre/theming/themes']) {
          builder.onResolve({ filter: new RegExp(`^${name}$`) }, () => ({ path: config.resolve.alias[`${name}$`] }));
        }
      } }],
    });
    writeFileSync(join(root, 'renderer.mjs'), result.outputFiles[0].contents);
    writeFileSync(join(root, 'http-loader.mjs'), `
      let origin;
      export function initialize(data) { origin = data.origin; }
      export async function resolve(specifier, context, nextResolve) {
        if (specifier.startsWith('/syntax/')) return { url: origin + specifier, shortCircuit: true };
        if (context.parentURL?.startsWith(origin) && specifier.startsWith('.')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
        return nextResolve(specifier, context);
      }
      export async function load(url, context, nextLoad) {
        if (!url.startsWith(origin)) return nextLoad(url, context);
        const response = await fetch(url);
        if (!response.ok) throw new Error('fixture HTTP ' + response.status);
        return { format: 'module', source: await response.text(), shortCircuit: true };
      }
    `);
    writeFileSync(join(root, 'register.mjs'), `
      import { register } from 'node:module';
      register(new URL('./http-loader.mjs', import.meta.url), { data: { origin: ${JSON.stringify(origin)} } });
    `);
    writeFileSync(join(root, 'retry.mjs'), `
      import assert from 'node:assert/strict';
      import { preloadHighlighter, getSharedHighlighter } from './renderer.mjs';
      const origin = ${JSON.stringify(origin)};
      for (const [language, failedName] of [['scala', 'scala.mjs'], ['vue', 'vue-interpolations.mjs']]) {
        await fetch(origin + '/fail?name=' + failedName);
        await assert.rejects(preloadHighlighter({ langs: [language], themes: ['o8-pr-code'] }), /fixture HTTP 502/);
        await fetch(origin + '/ready');
        await preloadHighlighter({ langs: [language], themes: ['o8-pr-code'] });
        const highlighter = await getSharedHighlighter({ langs: [language], themes: ['o8-pr-code'] });
        assert(highlighter.getLoadedLanguages().includes(language));
        assert(highlighter.codeToTokens('const value = 42', { lang: language, theme: 'o8-pr-code' }).tokens.length > 0);
        await preloadHighlighter({ langs: [language], themes: ['o8-pr-code'] });
      }
    `);
    const run = promisify(execFile);
    try {
      await run(process.execPath, ['--import', pathToFileURL(join(root, 'register.mjs')).href, join(root, 'retry.mjs')], {
        cwd: root, timeout: 20_000,
      });
    } catch (error) {
      throw new Error(`Native retry failed after ${requests.length} HTTP requests.`, { cause: error });
    }
    for (const name of ['scala.mjs', 'vue.mjs', 'vue-interpolations.mjs']) {
      const urls = requests.filter(path => path.endsWith(`/${name}`));
      expect(urls, name).toHaveLength(2);
      expect(new Set(urls).size, name).toBe(2);
    }
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
