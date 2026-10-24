export const SERVER_ENTRIES: Record<string, string>;
export function bundleServers(options: { root: string; outDir: string }): {
  outputs: Array<{ file: string; budgetKey: string; bytes: number }>;
  metafile: import('esbuild').Metafile;
};
