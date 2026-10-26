import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';

const entry = resolve('scripts/parity/next.mjs');
const run = (file: string, ...args: string[]) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', timeout: 5000 });

it('maps Workers through the real CLI with the existing route fixture and native selectors', () => {
  const result = run(entry, '--list');
  expect(result.status, result.stderr).toBe(0);
  const workers = JSON.parse(result.stdout).surfaces.find((row: { id: string }) => row.id === 'workers');
  expect(workers).toMatchObject({ tab: 'Workers', flags: ['--workers'], webRoute: '/dashboard', nativeSelectors: ['workers-pane', 'workers-list'] });
});

function unmappedFixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-parity-unmapped-'));
  const scripts = join(root, 'scripts/parity');
  const native = join(root, 'native/o8-next/src');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(native, { recursive: true });
  // Run the actual CLI source against a disposable inventory with one mapping
  // removed. The working registration file and production data remain untouched.
  for (const file of ['next.mjs', 'report.mjs', 'health.mjs']) copyFileSync(resolve('scripts/parity', file), join(scripts, file));
  copyFileSync('native/o8-next/src/shell.rs', join(native, 'shell.rs'));
  const manifest = JSON.parse(readFileSync('scripts/parity/surfaces.json', 'utf8'));
  manifest.surfaces = manifest.surfaces.filter((row: { id: string }) => row.id !== 'workers');
  writeFileSync(join(scripts, 'surfaces.json'), JSON.stringify(manifest));
  return { root, entry: join(scripts, 'next.mjs') };
}

it('names unmapped registered surfaces through the CLI instead of hiding inventory drift', () => {
  const fixture = unmappedFixture();
  try {
    const result = run(fixture.entry, '--check-surfaces');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unmapped registered surfaces:');
    expect(result.stderr).toMatch(/\bworkers\b/);
    expect(result.stderr).toContain('scripts/parity/surfaces.json');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

it('lists mappings and compares reports even when a registration has no capture mapping', () => {
  const fixture = unmappedFixture();
  try {
    const input = join(fixture.root, 'captures.json');
    writeFileSync(input, '[]');
    const listed = run(fixture.entry, '--list');
    expect(listed.status, listed.stderr).toBe(0);
    const result = run(fixture.entry, '--compare', input, '--output', join(fixture.root, 'report'));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(fixture.root, 'report/report.json'), 'utf8')).crashes).toBe(0);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

function alive(pid: number | undefined) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

it('rejects an unknown --only before starting hosts and leaves no capture processes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o8-parity-only-'));
  const pidFile = join(root, 'web.pid');
  const host = join(root, 'web.mjs');
  writeFileSync(host, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, [entry, '--only', 'not-a-surface', '--binary', process.execPath,
    '--nativeTest', process.execPath, '--webHost', host, '--output', join(root, 'output')], {
    detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, DISPLAY: ':parity-fixture' },
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const deadline = new AbortController();
  try {
    const exited = await Promise.race([
      once(child, 'exit').then(([code, signal]) => ({ code, signal })),
      delay(5000, null, { signal: deadline.signal }),
    ]);
    const hostPid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : undefined;
    expect({ exit: exited?.code ?? null, cliAlive: alive(child.pid), hostStarted: existsSync(pidFile), hostAlive: alive(hostPid) }, stderr)
      .toEqual({ exit: 1, cliAlive: false, hostStarted: false, hostAlive: false });
    expect(stderr).toContain('Unknown surface: not-a-surface');
  } finally {
    deadline.abort();
    // Clean up only this test's isolated process group, including on a red run.
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already exited. */ }
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

it('stops a started web host when native test compilation fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o8-parity-startup-'));
  const pidFile = join(root, 'web.pid');
  const host = join(root, 'web.mjs');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(host, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
  const cargo = join(bin, 'cargo');
  writeFileSync(cargo, `#!${process.execPath}\nconst fs=require('node:fs');const deadline=Date.now()+3000;while(!fs.existsSync(${JSON.stringify(pidFile)})&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);process.exit(1);`);
  chmodSync(cargo, 0o700);
  const child = spawn(process.execPath, [entry, '--only', 'session', '--binary', process.execPath,
    '--webHost', host, '--output', join(root, 'output')], {
    detached: true, stdio: 'ignore', env: { ...process.env, DISPLAY: ':parity-fixture', PATH: `${bin}:${process.env.PATH}` },
  });
  const deadline = new AbortController();
  try {
    const exited = await Promise.race([
      once(child, 'exit').then(([code]) => code),
      delay(7000, null, { signal: deadline.signal }),
    ]);
    expect(exited).toBe(1);
    expect(existsSync(pidFile)).toBe(true);
    expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false);
    expect(alive(child.pid)).toBe(false);
    expect(JSON.parse(readFileSync(join(root, 'output/report.json'), 'utf8')).crashes).toBe(2);
  } finally {
    deadline.abort();
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already exited. */ }
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
