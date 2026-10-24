import { normalizeTheme } from 'shiki/core';
import { bundledThemes } from './shiki-bundle';
import { importSyntaxModule } from './remote-module';
import { syntaxModulePath } from './asset-manifest';
import type { CreateThemeOptions } from '@pierre/theming/themes';

type Theme = Parameters<typeof normalizeTheme>[0];

export function createTheme({ load, ...descriptor }: CreateThemeOptions) {
  return { ...descriptor, load: async () => {
    const loaded = await load();
    return normalizeTheme(('default' in loaded ? loaded.default : loaded) as Theme);
  } };
}

// The app registers o8-pr-code itself. Keep Pierre's two fallback themes local;
// its optional palettes and Shiki themes resolve only when explicitly selected.
const pierreLoaders = {
  'pierre-dark': () => import('@pierre/theme/pierre-dark'),
  'pierre-light': () => import('@pierre/theme/pierre-light'),
};
export const pierreThemes = {
  getThemes: () => Object.entries(pierreLoaders).map(([name, load]) => ({
    name, load: async () => normalizeTheme((await load()).default as unknown as Theme),
  })),
};
export const shikiThemes = {
  getTheme: (name: string) => {
    const loader = bundledThemes[name];
    if (loader) return { name, load: async () => normalizeTheme((await loader()).default) };
    if (/^pierre-(dark|light)-(soft|vibrant|protanopia-deuteranopia|tritanopia)$/.test(name)) {
      return { name, load: async () => normalizeTheme((await importSyntaxModule(
        syntaxModulePath('pierre', name),
      )).default as Parameters<typeof normalizeTheme>[0]) };
    }
    return undefined;
  },
};
