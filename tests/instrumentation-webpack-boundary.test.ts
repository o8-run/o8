import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const sourceFile = path.resolve('src/instrumentation.ts');
const bootstrapRequests = [
  '@/lib/telemetry/crash-capture',
  '@/lib/startup/schedule',
  '@/lib/tts/ensure-edge-tts',
];

interface CompilationStats {
  toJson(options: { all: false; errors: true; modules: true }): {
    errors?: Array<{ message: string }>;
    modules?: Array<{ name?: string; identifier?: string }>;
  };
}

interface TestCompiler {
  outputFileSystem: unknown;
  run(callback: (error: Error | null, stats?: CompilationStats) => void): void;
  close(callback: (error?: Error | null) => void): void;
}

interface BundledWebpack {
  (config: Record<string, unknown>): TestCompiler;
  DefinePlugin: new (definitions: Record<string, string>) => unknown;
}

const { webpack } = require('next/dist/compiled/webpack/webpack') as { webpack: BundledWebpack };
const { getInstrumentationEntry } = require('next/dist/build/entries') as {
  getInstrumentationEntry(options: {
    absolutePagePath: string; isEdgeServer: boolean; isDev: boolean;
  }): { import: string; filename: string; layer: string };
};
const { defaultConfig } = require('next/dist/server/config-shared') as {
  defaultConfig: { experimental: Record<string, unknown>; [key: string]: unknown };
};
const { transformSync } = require('next/dist/build/swc') as {
  transformSync(source: string, options: Record<string, unknown>): unknown;
};

async function compileInstrumentation(runtime: 'edge' | 'nodejs') {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-instrumentation-webpack-'));
  let compiler: TestCompiler | undefined;
  try {
    const alias: Record<string, string> = {};
    for (const [index, request] of bootstrapRequests.entries()) {
      const fixture = path.join(fixtureDir, `node-bootstrap-${index}.mjs`);
      // Poison dependencies expose an accidental Edge traversal without loading
      // application state, native SQLite, or the full bootstrap dependency graph.
      fs.writeFileSync(fixture, "import fs from 'fs'; export const evidence = fs;\n");
      alias[`${request}$`] = fixture;
    }
    const constants = path.join(fixtureDir, 'constants.mjs');
    fs.writeFileSync(constants, "export const PHASE_PRODUCTION_BUILD = 'phase-production-build';\n");
    alias['next/constants$'] = constants;

    // Next normally primes these installed bindings before its loader runs.
    transformSync('', { jsc: { parser: { syntax: 'ecmascript' } } });
    const isEdgeServer = runtime === 'edge';
    compiler = webpack({
      mode: 'development', target: isEdgeServer ? 'webworker' : 'node',
      context: process.cwd(), cache: false, devtool: false,
      entry: { instrumentation: getInstrumentationEntry({ absolutePagePath: sourceFile, isEdgeServer, isDev: true }) },
      experiments: { layers: true }, externalsPresets: { node: !isEdgeServer },
      resolve: { alias, extensions: ['.ts', '.mjs', '.js'] },
      module: { rules: [{ test: /\.ts$/, use: [{
        loader: require.resolve('next/dist/build/webpack/loaders/next-swc-loader'),
        options: {
          isServer: true, compilerType: isEdgeServer ? 'edge-server' : 'server',
          rootDir: process.cwd(), appDir: path.resolve('src/app'), hasReactRefresh: false,
          nextConfig: { ...defaultConfig, experimental: { ...defaultConfig.experimental, useCache: false }, cacheComponents: false },
          jsConfig: { compilerOptions: {} }, serverComponents: true,
          serverReferenceHashSalt: 'instrumentation-boundary-test', bundleLayer: 'instrument', esm: true,
        },
      }] }] },
      plugins: [new webpack.DefinePlugin({ 'process.env.NEXT_RUNTIME': JSON.stringify(runtime) })],
      output: { path: path.join(fixtureDir, 'memory-output'), filename: '[name].js' },
      infrastructureLogging: { level: 'error' },
    });
    // Generated assets stay in memory and are never imported or executed.
    const assets = new Map<string, Buffer>();
    type WriteCallback = (error: NodeJS.ErrnoException | null) => void;
    compiler.outputFileSystem = {
      ...fs,
      mkdir(_target: string, options: unknown, callback?: WriteCallback) {
        (typeof options === 'function' ? options as WriteCallback : callback)?.(null);
      },
      writeFile(target: string, data: Buffer, options: unknown, callback?: WriteCallback) {
        assets.set(target, data);
        (typeof options === 'function' ? options as WriteCallback : callback)?.(null);
      },
    };
    const stats = await new Promise<CompilationStats>((resolve, reject) => {
      compiler!.run((error, result) => {
        if (error) reject(error);
        else if (!result) reject(new Error('Webpack returned no compilation stats'));
        else resolve(result);
      });
    });
    const report = stats.toJson({ all: false, errors: true, modules: true });
    return {
      errors: (report.errors ?? []).map((error) => error.message),
      bootstrapModules: (report.modules ?? []).flatMap((module) => {
        const name = module.name ?? module.identifier ?? '';
        const match = name.match(/node-bootstrap-\d+\.mjs/);
        return match ? [match[0]] : [];
      }).sort(),
    };
  } finally {
    try {
      if (compiler) {
        await new Promise<void>((resolve, reject) => {
          compiler!.close((error) => error ? reject(error) : resolve());
        });
      }
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  }
}

describe('instrumentation webpack runtime boundary', () => {
  it('compiles Edge instrumentation without collecting Node bootstrap dependencies', async () => {
    const result = await compileInstrumentation('edge');
    expect(result.errors).toEqual([]);
    expect(result.bootstrapModules).toEqual([]);
  });

  it('preserves all Node bootstrap dependencies in the Node compilation', async () => {
    const result = await compileInstrumentation('nodejs');
    expect(result.errors).toEqual([]);
    expect(result.bootstrapModules).toEqual(bootstrapRequests.map((_, index) => `node-bootstrap-${index}.mjs`));
  });
});
