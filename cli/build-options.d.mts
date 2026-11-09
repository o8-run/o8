// Types for build-options.mjs (allowJs is off repo-wide).
import type { BuildOptions } from 'esbuild';

export declare const ESM_BANNER: string;
export declare function cliBuildOptions(options: { outfile: string; version: string }): BuildOptions;
