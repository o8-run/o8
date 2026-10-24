import { languageNames, languageAliasNames } from '@shikijs/langs';
import { themeNames } from '@shikijs/themes';
import { createBundledHighlighter, createSingletonShorthands, guessEmbeddedLanguages } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { DynamicImportLanguageRegistration, DynamicImportThemeRegistration } from 'shiki/core';
import { importSyntaxModule } from './remote-module';
import { syntaxModulePath } from './asset-manifest';

export * from 'shiki/core';
export { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
export { createOnigurumaEngine } from 'shiki/engine/oniguruma';

// These are the languages shown by code blocks and the file/diff viewers.
// Import the same grammars as Shiki's full bundle, preserving token colors.
const common: Record<string, DynamicImportLanguageRegistration> = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  python: () => import('@shikijs/langs/python'),
  rust: () => import('@shikijs/langs/rust'),
  go: () => import('@shikijs/langs/go'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  less: () => import('@shikijs/langs/less'),
  html: () => import('@shikijs/langs/html'),
  xml: () => import('@shikijs/langs/xml'),
  markdown: () => import('@shikijs/langs/markdown'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  sql: () => import('@shikijs/langs/sql'),
  graphql: () => import('@shikijs/langs/graphql'),
  ruby: () => import('@shikijs/langs/ruby'),
  java: () => import('@shikijs/langs/java'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  swift: () => import('@shikijs/langs/swift'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  r: () => import('@shikijs/langs/r'),
  lua: () => import('@shikijs/langs/lua'),
  php: () => import('@shikijs/langs/php'),
  perl: () => import('@shikijs/langs/perl'),
  ini: () => import('@shikijs/langs/ini'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  powershell: () => import('@shikijs/langs/powershell'),
  fish: () => import('@shikijs/langs/fish'),
  bat: () => import('@shikijs/langs/bat'),
};
const aliases: Record<string, string> = {
  ts: 'typescript', cts: 'typescript', mts: 'typescript',
  js: 'javascript', cjs: 'javascript', mjs: 'javascript',
  py: 'python', rs: 'rust', yml: 'yaml', md: 'markdown', gql: 'graphql',
  properties: 'ini', batch: 'bat', sh: 'shellscript', bash: 'shellscript',
  shell: 'shellscript', zsh: 'shellscript', rb: 'ruby',
  kt: 'kotlin', kts: 'kotlin', ps: 'powershell', ps1: 'powershell', pwsh: 'powershell',
  cmd: 'bat', cxx: 'cpp', h: 'c', hpp: 'cpp', docker: 'dockerfile', pl: 'perl',
};
// Shiki's public registry differs from the package export list: these four
// aliases are not export paths, and the embedded grammars are not public IDs.
const nonExportedAliases: Record<string, string> = {
  'c++': 'cpp', 'c#': 'csharp', 'f#': 'fsharp', '文言': 'wenyan',
};
const embeddedOnly = new Set([
  'angular-expression', 'angular-inline-style', 'angular-inline-template',
  'angular-let-declaration', 'angular-template', 'angular-template-blocks',
  'cpp-macro', 'es-tag-css', 'es-tag-glsl', 'es-tag-html', 'es-tag-sql', 'es-tag-xml',
  'jinja-html', 'markdown-nix', 'markdown-vue', 'vue-directives',
  'vue-interpolations', 'vue-sfc-style-variable-injection',
]);

// Pin to the installed grammar/theme versions. Tests check these against the
// dependency manifests so upgrades cannot silently mix grammar versions.
export const bundledLanguages: Record<string, DynamicImportLanguageRegistration> = Object.fromEntries(
  [...languageNames, ...languageAliasNames, ...Object.keys(nonExportedAliases)]
    .filter(name => !embeddedOnly.has(name))
    .map(name => {
      const canonical = nonExportedAliases[name] ?? aliases[name] ?? name;
      return [name, common[canonical] ?? (() => importSyntaxModule(
        syntaxModulePath('langs', canonical),
      ) as ReturnType<DynamicImportLanguageRegistration>)];
    }),
);

export const bundledThemes: Record<string, DynamicImportThemeRegistration> = {
  ...Object.fromEntries(themeNames.map(name => [name,
    () => importSyntaxModule(syntaxModulePath('themes', name))])),
  'github-dark': () => import('@shikijs/themes/github-dark'),
  'github-light': () => import('@shikijs/themes/github-light'),
} as Record<string, DynamicImportThemeRegistration>;

export const createHighlighter = createBundledHighlighter({
  langs: bundledLanguages,
  themes: bundledThemes,
  engine: createJavaScriptRegexEngine,
});
export const { codeToHtml, codeToHast, codeToTokens, codeToTokensBase, codeToTokensWithThemes, getSingletonHighlighter, getLastGrammarState } = createSingletonShorthands(createHighlighter, { guessEmbeddedLanguages });
