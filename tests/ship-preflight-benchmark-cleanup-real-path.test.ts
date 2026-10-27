import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runQuickBenchmarkPreflight, shipPreflightInternals } from '../scripts/lib/ship-preflight.mjs';

// The ship preflight runs the advisory quick benchmark inside the release
// checkout. Its servers start in their own process groups, so a timeout used
// to orphan them, and an orphaned dev server wrote `.next`, which the prebuild
// then refused as unknown generated output. These cases run a stand-in
// benchmark that leaves real detached descendants behind.

const roots: string[] = [];

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
    return Boolean(state) && !state.startsWith('Z');
  } catch {
    return false;
  }
}

// Teardown signals a recorded PID only while its command line still names
// this fixture root, so a reused PID can never be signaled.
function stopOwned(root: string) {
  for (const name of ['grandchild.pid', 'interrupted.pid']) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    const pid = Number(readFileSync(file, 'utf8'));
    const command = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
    if (command.includes(root)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ }
    }
  }
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    stopOwned(root);
    rmSync(shipPreflightInternals.benchmarkStatePath(root), { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// `hang` keeps the stand-in benchmark running until the preflight timeout;
// otherwise it prints a valid receipt and exits, leaving its descendant behind.
// `hidden` starts the descendant as /bin/bash in the benchmark's own process
// group; macOS hides the environment of system binaries from `ps`, so only the
// process group identifies it.
function fixture({ writeOutput, hang, hidden = false }: { writeOutput: boolean; hang: boolean; hidden?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'o8-ship-benchmark-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts', 'bench'), { recursive: true });
  const grandchild = [
    "const fs = require('node:fs');",
    writeOutput ? "fs.mkdirSync('.next/dev', { recursive: true }); fs.writeFileSync('.next/dev/lock', 'held');" : '',
    'setInterval(() => {}, 1000);',
  ].join(' ');
  const receipt = JSON.stringify({ schema: 'o8/benchmark-quick-preflight/v1', status: 'ok', regressions: [], missing: [] });
  writeFileSync(join(root, 'scripts', 'bench', 'quick.mjs'), [
    "import { spawn } from 'node:child_process';",
    "import { existsSync, writeFileSync } from 'node:fs';",
    hidden
      ? `const child = spawn('/bin/bash', ['-c', 'while true; do sleep 0.2; done', ${JSON.stringify(root)}], { cwd: process.cwd(), stdio: 'ignore', env: process.env });`
      : `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, ${JSON.stringify(root)}], { cwd: process.cwd(), detached: true, stdio: 'ignore', env: process.env });`,
    'child.unref();',
    "writeFileSync('grandchild.pid', String(child.pid));",
    // Wait until the descendant has written its output before exiting or hanging.
    `const deadline = Date.now() + 5000; while (${writeOutput} && !existsSync('.next/dev/lock') && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 20)); }`,
    hang ? 'setInterval(() => {}, 1000);' : `console.log('O8_BENCH_QUICK_RECEIPT=' + ${JSON.stringify(receipt)});`,
  ].join('\n'));
  return root;
}

function grandchildPid(root: string) {
  return Number(readFileSync(join(root, 'grandchild.pid'), 'utf8'));
}

describe('ship preflight quick benchmark cleanup', () => {
  it('stops orphaned benchmark descendants and removes the output they created after a timeout', () => {
    const root = fixture({ writeOutput: true, hang: true });

    const receipt = runQuickBenchmarkPreflight({ root, timeoutMs: 3000 });

    expect(receipt.status).toBe('unavailable');
    expect(alive(grandchildPid(root))).toBe(false);
    expect(existsSync(join(root, '.next'))).toBe(false);
    expect(receipt.cleanup).toMatchObject({ confirmed: true, removedOutput: true });
    expect(receipt.cleanup?.stoppedProcesses).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('stops a descendant that outlives a benchmark which exited on its own', () => {
    const root = fixture({ writeOutput: false, hang: false });

    const receipt = runQuickBenchmarkPreflight({ root, timeoutMs: 15_000 });

    expect(receipt.status).toBe('ok');
    expect(alive(grandchildPid(root))).toBe(false);
    expect(receipt.cleanup).toMatchObject({ confirmed: true, removedOutput: false });
    expect(receipt.cleanup?.stoppedProcesses).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('stops a descendant whose environment ps cannot show through the benchmark process group', () => {
    const root = fixture({ writeOutput: false, hang: false, hidden: true });

    const receipt = runQuickBenchmarkPreflight({ root, timeoutMs: 15_000 });

    expect(alive(grandchildPid(root))).toBe(false);
    expect(receipt.cleanup).toMatchObject({ confirmed: true });
    expect(receipt.cleanup?.stoppedProcesses).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('finishes the cleanup of an interrupted earlier run before the next benchmark', () => {
    const root = fixture({ writeOutput: false, hang: false });
    const marker = 'interrupted-run-marker';
    // A launcher that exits leaves the server re-parented to init, as an
    // interrupted ship leaves it.
    const server = "require('node:fs').mkdirSync('.next/dev', { recursive: true }); require('node:fs').writeFileSync('.next/dev/lock', 'held'); setInterval(() => {}, 1000);";
    const launcher = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(server)}, ${JSON.stringify(root)}], { detached: true, stdio: 'ignore' }); c.unref(); require('node:fs').writeFileSync('interrupted.pid', String(c.pid));`;
    spawnSync(process.execPath, ['-e', launcher], { cwd: root, env: { ...process.env, O8_SHIP_BENCHMARK_RUN: marker } });
    const orphan = { pid: Number(readFileSync(join(root, 'interrupted.pid'), 'utf8')) };
    writeFileSync(shipPreflightInternals.benchmarkStatePath(root), JSON.stringify({ runs: [{ marker, outputExisted: false }] }));
    const deadline = Date.now() + 5000;
    while (!existsSync(join(root, '.next', 'dev', 'lock')) && Date.now() < deadline) spawnSync('sleep', ['0.05']);

    const receipt = runQuickBenchmarkPreflight({ root, timeoutMs: 15_000 });

    expect(alive(orphan.pid)).toBe(false);
    expect(existsSync(join(root, '.next'))).toBe(false);
    expect(receipt.cleanup?.recoveredPrevious).toEqual([
      expect.objectContaining({ confirmed: true, removedOutput: true }),
    ]);
    expect(existsSync(shipPreflightInternals.benchmarkStatePath(root))).toBe(false);
  }, 30_000);

  it('refuses to start a benchmark against existing output and preserves it', () => {
    const root = fixture({ writeOutput: true, hang: true });
    mkdirSync(join(root, '.next'), { recursive: true });
    writeFileSync(join(root, '.next', 'BUILD_ID'), 'prior-build');

    expect(() => runQuickBenchmarkPreflight({ root, timeoutMs: 3000 }))
      .toThrow(/\.next.*already exists.*node scripts\/postship-cleanup\.mjs/);

    expect(existsSync(join(root, 'grandchild.pid'))).toBe(false);
    expect(existsSync(join(root, '.next', 'dev', 'lock'))).toBe(false);
    expect(readFileSync(join(root, '.next', 'BUILD_ID'), 'utf8')).toBe('prior-build');
    expect(existsSync(shipPreflightInternals.benchmarkStatePath(root))).toBe(false);
  }, 30_000);
});
