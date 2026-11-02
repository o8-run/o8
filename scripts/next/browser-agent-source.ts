/** Bake classic's canonical agent into the native host; --check detects drift. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
export function browserAgentSource(): string {
  // Use one deterministic compiler for both generation and the drift test.
  // keepNames would introduce external __name helpers inside serialized functions.
  const bundle = buildSync({
    entryPoints: [fileURLToPath(new URL('../../src/lib/browser/native-agent-source.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', keepNames: false,
    tsconfig: fileURLToPath(new URL('../../tsconfig.json', import.meta.url)),
  });
  const compiled = { exports: {} as { NATIVE_BROWSER_AGENT_SOURCE?: string } };
  runInNewContext(bundle.outputFiles[0].text, { module: compiled, exports: compiled.exports });
  return compiled.exports.NATIVE_BROWSER_AGENT_SOURCE! + '\n';
}
if (process.argv[1]?.endsWith('/browser-agent-source.ts')) {
  const path = new URL('../../native/o8-next/src/browser_panel/agent.js', import.meta.url);
  const source = browserAgentSource();
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== source) throw new Error('Regenerate with: tsx scripts/next/browser-agent-source.ts');
  } else writeFileSync(path, source);
}
