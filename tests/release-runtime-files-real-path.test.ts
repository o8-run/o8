import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);

// Keep Next's dependencies inside its tracing root. A linked node_modules
// traces files outside the fixture and does not exercise standalone packaging.
function installFixtureDependencies(repo: string) {
  const copied = new Set<string>();
  const copy = (name: string, from = require) => {
    if (copied.has(name)) return;
    copied.add(name);
    let directory = path.dirname(from.resolve(name));
    while (!existsSync(path.join(directory, 'package.json'))
      || JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')).name !== name) {
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`Package root not found: ${name}`);
      directory = parent;
    }
    const manifest = path.join(directory, 'package.json');
    const metadata = JSON.parse(readFileSync(manifest, 'utf8'));
    cpSync(directory, path.join(repo, 'node_modules', name), { recursive: true });
    for (const dependency of Object.keys(metadata.dependencies ?? {})) copy(dependency, createRequire(manifest));
  };
  for (const name of ['next', 'react', 'react-dom',
    `@next/swc-${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : process.platform === 'win32' ? '-msvc' : ''}`]) copy(name);
}

async function assertPackagedHealth(server: string) {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const child = spawn(process.execPath, ['server.js'], { cwd: server, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', NODE_OPTIONS: '', HOSTNAME: '127.0.0.1', PORT: String(port) } });
  const closed = once(child, 'exit');
  let output = '';
  for (const stream of [child.stdout!, child.stderr!]) stream.on('data', chunk => { output += chunk; });
  try {
    for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
      if (child.exitCode !== null) throw new Error(`Packaged server exited: ${output}`);
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
      if (response) {
        expect(response.status, output).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        return;
      }
      await delay(50);
    }
    throw new Error(`Packaged health did not answer: ${output}`);
  } finally {
    child.kill();
    await Promise.race([closed, delay(3000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}

it('packages the route runtime from the real release dist build and serves health', async () => {
  const source = process.cwd();
  const root = mkdtempSync(path.join(tmpdir(), 'o8-release-runtime-'));
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, 'app/api/health'), { recursive: true });
  try {
    writeFileSync(path.join(repo, 'package.json'), '{"name":"release-runtime-fixture","version":"0.0.0"}');
    writeFileSync(path.join(repo, 'app/layout.js'), 'export default function Layout({children}) { return <html><body>{children}</body></html>; }');
    writeFileSync(path.join(repo, 'app/page.js'), 'export default function Page() { return <main>Release fixture</main>; }');
    writeFileSync(path.join(repo, 'app/api/health/route.js'),
      'export const dynamic = "force-dynamic"; export function GET() { return Response.json({ ok: true }); }');
    mkdirSync(path.join(repo, 'src/lib/panel'), { recursive: true });
    cpSync(path.join(source, 'src/lib/panel/preview-document-policy.ts'), path.join(repo, 'src/lib/panel/preview-document-policy.ts'));
    writeFileSync(path.join(repo, 'next.config.ts'), readFileSync(path.join(source, 'next.config.ts'), 'utf8')
      .replace('experimental: {', 'experimental: { cpus: 1,'));
    installFixtureDependencies(repo);
    await exec(process.execPath, [path.join(repo, 'node_modules/next/dist/bin/next'), 'build', '--webpack'], {
      cwd: repo, timeout: 90_000, maxBuffer: 2 * 1024 ** 2,
      env: { ...process.env, NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=1024',
        O8_RELEASE_NEXT_DIST_DIR: '.next/.o8-release-build', NEXT_TELEMETRY_DISABLED: '1' },
    });
    const packaged = path.join(root, 'server');
    // Next's standalone output is the whole dependency tree tauri-export copies.
    cpSync(path.join(repo, '.next/.o8-release-build/standalone'), packaged, { recursive: true });
    expect(existsSync(path.join(packaged,
      'node_modules/next/dist/compiled/next-server/app-route.runtime.prod.js'))).toBe(true);
    await assertPackagedHealth(packaged);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
