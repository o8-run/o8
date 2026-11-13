import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectBuildTraces } from 'next/dist/build/collect-build-traces';
import { copyTracedFiles } from 'next/dist/build/utils';
import loadConfig from 'next/dist/server/config';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { Span } from 'next/dist/trace';
import nextConfig from '../next.config';
import { piWriteHelperPath } from '@/lib/pi/sdk/scripts';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('native helper compiler output at the standalone trace boundary', () => {
  it.each([false, true])('keeps Cargo targets out of standalone output with compiler churn=%s', async churn => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-native-trace-')));
    roots.push(root);
    const dist = join(root, '.next');
    const route = join(dist, 'server/app/api/status/route.js');
    const compilerFiles = [
      'src-tauri/sidecars/pi-write/target/.rustc_info.json',
      'src-tauri/sidecars/pi-write/target/release/deps/temporary.rcgu.o',
      'src-tauri/sidecars/pi-write/target/release/.fingerprint/helper/lib-helper',
      'src-tauri/sidecars/pi-write/target/aarch64-apple-darwin/release/build/helper/out/generated.rs',
      'src-tauri/sidecars/pi-write/target/release/o8-pi-write',
    ];
    const runtimeFiles = [
      '.next/server/app/api/status/route.js',
      'src-tauri/helpers/o8-pi-write',
      'src-tauri/helpers/o8-pi-write-universal-apple-darwin',
      'node_modules/example/prebuilds/linux-x64/binding.node',
      'pi-sdk/worker.mjs',
    ];
    const put = (file: string) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), `fixture:${file}`);
    };
    for (const file of [...compilerFiles, ...runtimeFiles]) put(file);
    put('package.json');
    writeFileSync(join(root, 'package.json'), '{"name":"trace-fixture"}');
    const traced = (file: string) => relative(dirname(route), join(root, file));
    writeFileSync(`${route}.nft.json`, JSON.stringify({ version: 1,
      files: [...compilerFiles, ...runtimeFiles].map(traced) }));
    writeFileSync(join(dist, 'next-server.js.nft.json'), '{"version":1,"files":[]}');

    // Seed the compiler's route trace, as in packaging-preflight-real-path.
    // Run Next's production exclusion processing and standalone copier unchanged.
    const span = new Span({ name: 'fixture-build' });
    const traceChild = span.traceChild.bind(span);
    vi.spyOn(span, 'traceChild').mockImplementation((name, attrs) => {
      const child = traceChild(name, attrs);
      if (name === 'node-file-trace-build') vi.spyOn(child, 'traceAsyncFn').mockImplementation(async () => undefined as never);
      return child;
    });
    const config = await loadConfig(PHASE_PRODUCTION_BUILD, root, {
      customConfig: { ...nextConfig, outputFileTracingRoot: root }, silent: true,
    });
    await collectBuildTraces({ dir: root, distDir: dist, outputFileTracingRoot: root, config,
      nextBuildSpan: span, edgeRuntimeRoutes: {}, staticPages: [], buildTraceContext: { chunksTrace: {
        action: { action: 'annotate', input: [], contextDirectory: root, processCwd: root },
        outputPath: dist, entryNameFilesMap: { 'app/api/status/route': [] },
      } } });

    // Simulate a compiler removing an object after tracing but before copying.
    if (churn) rmSync(join(root, compilerFiles[1]));
    const warnings = vi.spyOn(console, 'warn');
    await copyTracedFiles(root, dist, [], ['api/status/route'], root, config,
      { version: 3, middleware: {}, functions: {}, sortedMiddleware: [] }, false, false, new Set());
    expect(warnings).not.toHaveBeenCalled();
    const trace = JSON.parse(readFileSync(`${route}.nft.json`, 'utf8')) as { files: string[] };
    expect(trace.files).toEqual(runtimeFiles.map(traced));
    const standalone = join(dist, 'standalone');
    for (const file of compilerFiles) expect(existsSync(join(standalone, file)), file).toBe(false);
    for (const file of runtimeFiles) expect(readFileSync(join(standalone, file), 'utf8')).toBe(`fixture:${file}`);
    for (const file of compilerFiles.filter(file => !churn || file !== compilerFiles[1])) {
      expect(readFileSync(join(root, file), 'utf8')).toBe(`fixture:${file}`);
    }

    // The shell supplies its separately staged helper in packaged mode.
    const helper = join(standalone, 'src-tauri/helpers/o8-pi-write');
    chmodSync(helper, 0o755);
    expect(piWriteHelperPath({ O8_PACKAGED_APP: '1', O8_PI_WRITE_BIN: helper })).toBe(helper);
    expect(() => piWriteHelperPath({ O8_PACKAGED_APP: '1' })).toThrow('Pi write helper is missing from this build');
  });
});
