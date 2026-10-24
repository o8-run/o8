import { languageNames, languageAliasNames } from '@shikijs/langs';
import { themeNames } from '@shikijs/themes';
import { themeNames as pierreThemeNames } from '@pierre/theme';

type SyntaxAssetKind = 'langs' | 'themes' | 'pierre';
const packages = {
  langs: { npm: '@shikijs/langs', version: '4.5.0', names: new Set<string>([...languageNames, ...languageAliasNames]) },
  themes: { npm: '@shikijs/themes', version: '4.5.0', names: new Set<string>(themeNames) },
  pierre: { npm: '@pierre/theme', version: '2.0.0', names: new Set<string>(pierreThemeNames) },
};

/** Versioned same-origin paths work with the desktop's script-src 'self'. */
export function syntaxModulePath(kind: SyntaxAssetKind, name: string): string {
  return `/syntax/${kind}/${packages[kind].version}/${encodeURIComponent(name)}.mjs`;
}

/** The public asset route can fetch only these installed, pinned package files. */
export function syntaxAssetUrl(kind: string, version: string, name: string): string | null {
  if (!Object.hasOwn(packages, kind) || !name.endsWith('.mjs')) return null;
  const pkg = packages[kind as SyntaxAssetKind];
  const id = name.slice(0, -4);
  if (version !== pkg.version || !pkg.names.has(id)) return null;
  return `https://cdn.jsdelivr.net/npm/${pkg.npm}@${pkg.version}/dist/${encodeURIComponent(id)}.mjs`;
}
