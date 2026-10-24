import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHighlighterCore, type LanguageRegistration } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type * as Pierre from '@pierre/diffs';
import nextConfig from '../next.config';

async function referenceLanguage(lang: string): Promise<{ default: LanguageRegistration[] }> {
  const names: Record<string, string> = { 'c++': 'cpp', 'c#': 'csharp', 'f#': 'fsharp', '文言': 'wenyan' };
  return import(/* @vite-ignore */ `@shikijs/langs/${names[lang] ?? lang}`);
}

const root = mkdtempSync(join(tmpdir(), 'o8-syntax-bundle-'));
const remote = { requests: [] as string[], fail: false };
const host = globalThis as typeof globalThis & { syntaxFixture?: typeof remote };
let renderer: Pick<typeof Pierre, 'getSharedHighlighter' | 'renderFileWithHighlighter' | 'preloadHighlighter'> & { bundledLanguages: Record<string, unknown>; bundledThemes: Record<string, unknown> };
afterAll(() => { delete host.syntaxFixture; rmSync(root, { recursive: true, force: true }); });

beforeAll(async () => {
  host.syntaxFixture = remote;
  const config = nextConfig.webpack!({ resolve: { alias: {} } }, { dev: false } as never);
  // Compile the real app theme and Pierre entry point using the aliases from
  // production. Only the remote import boundary returns local grammar fixtures.
  const result = await build({
    stdin: { contents: "import '@/components/desktop/pr-panel/pr-code-theme'; export { getSharedHighlighter, renderFileWithHighlighter, preloadHighlighter } from '@pierre/diffs'; export { bundledLanguages, bundledThemes } from 'shiki';", resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'esm',
    alias: { '@': resolve('src') },
    plugins: [{ name: 'production-syntax-aliases', setup(builder) {
      for (const name of ['shiki', '@pierre/theming/themes']) {
        const replacement = config.resolve.alias[`${name}$`];
        if (replacement) builder.onResolve({ filter: new RegExp(`^${name}$`) }, () => ({ path: replacement }));
      }
      builder.onResolve({ filter: /remote-module$/ }, () => ({ path: 'remote-module', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
        resolveDir: process.cwd(),
        contents: `export async function importSyntaxModule(url) {
          globalThis.syntaxFixture.requests.push(url);
          if (globalThis.syntaxFixture.fail) throw new Error('fixture offline');
          if (url.endsWith('/scala.mjs')) return import('@shikijs/langs/scala');
          if (url.endsWith('/abap.mjs')) return import('@shikijs/langs/abap');
          if (url.endsWith('/nord.mjs')) return import('@shikijs/themes/nord');
          if (url.endsWith('/csharp.mjs')) return import('@shikijs/langs/csharp');
          if (url.endsWith('/fsharp.mjs')) return import('@shikijs/langs/fsharp');
          if (url.endsWith('/wenyan.mjs')) return import('@shikijs/langs/wenyan');
          throw new Error('Unexpected syntax asset');
        }`,
      }));
    } }],
  });
  const output = join(root, 'renderer.mjs');
  writeFileSync(output, result.outputFiles[0].contents);
  renderer = await import(/* @vite-ignore */ pathToFileURL(output).href);
});

const samples = [
  ['main.ts', 'typescript', 'export const greet = (name: string): string => `Hello ${name}`;'],
  ['View.tsx', 'tsx', 'export function View() { return <button disabled={false}>Hello</button>; }'],
  ['main.js', 'javascript', 'export const answer = async () => await Promise.resolve(42);'],
  ['View.jsx', 'jsx', 'export const View = () => <section title="hello">World</section>;'],
  ['main.py', 'python', 'def greet(name):\n    return f"Hello {name}" # greeting'],
  ['main.rs', 'rust', 'pub fn greet(name: &str) -> String { format!("Hello {}", name) }'],
  ['main.go', 'go', 'package main\nfunc main() { println("Hello") }'],
  ['style.css', 'css', '.button { color: red; padding: 4px; }'],
  ['index.html', 'html', '<button class="hello">Hello</button>'],
  ['data.json', 'json', '{"hello": true, "count": 42}'],
  ['config.yaml', 'yaml', 'hello: true\ncount: 42'],
  ['config.toml', 'toml', '[hello]\ncount = 42'],
  ['script.sh', 'shellscript', '#!/bin/sh\necho "Hello $USER"'],
  ['query.sql', 'sql', "SELECT name FROM users WHERE id = 42;"],
  ['README.md', 'markdown', '# Hello\n**World** and `code`'],
  ['main.rb', 'ruby', 'def greet(name)\n  "Hello #{name}"\nend'],
  ['data.xml', 'xml', '<hello count="42">World</hello>'],
  ['query.graphql', 'graphql', 'query Hello { viewer { name } }'],
  ['data.jsonc', 'jsonc', '{ // comment\n "enabled": true }'],
  ['style.scss', 'scss', '$color: red; .button { color: $color; }'],
  ['style.less', 'less', '@color: red; .button { color: @color; }'],
  ['Main.java', 'java', 'class Main { public static void main(String[] args) {} }'],
  ['main.c', 'c', '#include <stdio.h>\nint main(void) { return 42; }'],
  ['main.cpp', 'cpp', '#include <string>\nauto message = std::string("hello");'],
  ['alias.cpp', 'c++', '#include <string>\nauto message = std::string("hello");'],
  ['main.swift', 'swift', 'func greet(name: String) -> String { return "Hello" }'],
  ['main.kt', 'kotlin', 'fun greet(name: String): String = "Hello"'],
  ['main.r', 'r', 'greet <- function(name) { paste("Hello", name) }'],
  ['main.lua', 'lua', 'local function greet(name) return "Hello " .. name end'],
  ['main.php', 'php', '<?php function greet($name) { return "Hello " . $name; }'],
  ['main.perl', 'perl', 'my $message = "Hello"; print $message;'],
  ['config.ini', 'ini', '[hello]\ncount = 42'],
  ['Dockerfile', 'dockerfile', 'FROM node:22\nRUN echo "Hello"'],
  ['script.ps1', 'powershell', 'Write-Output "Hello $name"'],
  ['script.fish', 'fish', 'function greet\n  echo "Hello"\nend'],
  ['script.bat', 'bat', '@echo off\necho Hello %NAME%'],
] as const;

it.each(samples)('preserves offline highlighting for %s through the app theme and Pierre renderer', async (name, lang, contents) => {
  const { getSharedHighlighter, renderFileWithHighlighter } = renderer;
  const actual = await getSharedHighlighter({ langs: [lang], themes: ['o8-pr-code'], preferredHighlighter: 'shiki-js' });
  const expected = await createHighlighterCore({ langs: (await referenceLanguage(lang)).default, themes: [actual.getTheme('o8-pr-code')], engine: createJavaScriptRegexEngine() });
  const options = { theme: 'o8-pr-code', tokenizeMaxLineLength: 1000, useTokenTransformer: false };
  const file = { name, contents: `${contents}\n` };
  const rendered = renderFileWithHighlighter(file, actual, options);
  expect(rendered).toEqual(renderFileWithHighlighter(file, expected as Pierre.DiffsHighlighter, options));
  expect(remote.requests).toEqual([]);
  expected.dispose();
});

it('loads uncommon grammars and themes on demand and reuses the resolved assets', async () => {
  const { preloadHighlighter, getSharedHighlighter, renderFileWithHighlighter } = renderer;
  expect(remote.requests).toEqual([]);
  await preloadHighlighter({ langs: ['scala'], themes: ['nord'], preferredHighlighter: 'shiki-js' });
  expect(remote.requests).toHaveLength(2);
  expect(remote.requests).toEqual(expect.arrayContaining([
    expect.stringMatching(/\/syntax\/langs\/4\.5\.0\/scala\.mjs$/),
    expect.stringMatching(/\/syntax\/themes\/4\.5\.0\/nord\.mjs$/),
  ]));
  const actual = await getSharedHighlighter({ langs: ['scala'], themes: ['nord'] });
  const expected = await createHighlighterCore({ langs: (await referenceLanguage('scala')).default, themes: [(await import('@shikijs/themes/nord')).default], engine: createJavaScriptRegexEngine() });
  const file = { name: 'main.scala', contents: 'object Hello { val message = "Hello" }\n' };
  const options = { theme: 'nord', tokenizeMaxLineLength: 1000, useTokenTransformer: false };
  expect(renderFileWithHighlighter(file, actual, options)).toEqual(renderFileWithHighlighter(file, expected as Pierre.DiffsHighlighter, options));
  expect(remote.requests).toHaveLength(2);
  expected.dispose();
});

it('propagates an on-demand loading failure and permits a later retry', async () => {
  const { preloadHighlighter } = renderer;
  remote.fail = true;
  await expect(preloadHighlighter({ langs: ['abap'], themes: ['o8-pr-code'] })).rejects.toThrow('fixture offline');
  remote.fail = false;
  await expect(preloadHighlighter({ langs: ['abap'], themes: ['o8-pr-code'] })).resolves.toBeUndefined();
});

it('pins optional syntax URLs to the installed grammar and theme versions', async () => {
  for (const name of ['langs', 'themes']) {
    const installed = JSON.parse(readFileSync(resolve(`node_modules/@shikijs/${name}/package.json`), 'utf8')) as { version: string };
    expect(remote.requests).toContainEqual(expect.stringContaining(`/syntax/${name}/${installed.version}/`));
  }
});

it('preserves the full language and theme registries, including non-exported aliases', async () => {
  const { bundledLanguages } = await import('shiki/langs');
  const { bundledThemes } = await import('shiki/themes');
  expect(Object.keys(renderer.bundledLanguages).sort()).toEqual(Object.keys(bundledLanguages).sort());
  expect(Object.keys(renderer.bundledThemes).sort()).toEqual(Object.keys(bundledThemes).sort());
});

it.each([
  ['c#', 'csharp', 'public class Hello { public int Count = 42; }'],
  ['f#', 'fsharp', 'let message = "Hello"'],
  ['文言', 'wenyan', '吾有一數。曰三。名之曰「甲」。'],
])('loads the non-exported %s alias through its canonical grammar URL', async (lang, canonical, contents) => {
  const actual = await renderer.getSharedHighlighter({ langs: [lang], themes: ['o8-pr-code'] });
  const expected = await createHighlighterCore({ langs: (await referenceLanguage(lang)).default,
    themes: [actual.getTheme('o8-pr-code')], engine: createJavaScriptRegexEngine() });
  expect(actual.codeToTokens(contents, { lang, theme: 'o8-pr-code' })).toEqual(expected.codeToTokens(contents, { lang, theme: 'o8-pr-code' }));
  expect(remote.requests).toContainEqual(expect.stringContaining(`/${canonical}.mjs`));
  expected.dispose();
});
