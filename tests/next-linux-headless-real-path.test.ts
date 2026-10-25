import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
const cli = resolve('scripts/next/linux-headless.mjs');
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-next-budget-'));
  roots.push(root);
  const budget = join(root, 'budget.json');
  const receipt = join(root, 'receipt.json');
  writeFileSync(budget, JSON.stringify({ schema: 1, launchToFirstFrameMs: 200, idleRssMiB: 80,
    baseline: [1, 2, 3].map(() => ({ launchToFirstFrameMs: 160, idleRssMiB: 64 })) }));
  const samples = [1, 2, 3].map(() => ({ launchToFirstFrameMs: 200, idleRssMiB: 80 }));
  writeFileSync(receipt, JSON.stringify({ schema: 1, runs: samples }));
  return { root, budget, receipt, samples };
}
function check(receipt: string, budget: string) {
  return spawnSync(process.execPath, [cli, '--check', receipt, '--budget', budget], {
    encoding: 'utf8', timeout: 10_000,
  });
}

it('accepts the recorded limit and fails either budget one unit beyond it through the CI entry point', () => {
  const f = fixture();
  expect(check(f.receipt, f.budget).status).toBe(0);
  f.samples[1].launchToFirstFrameMs++;
  writeFileSync(f.receipt, JSON.stringify({ schema: 1, runs: f.samples }));
  const launch = check(f.receipt, f.budget);
  expect(launch.status).toBe(1);
  expect(launch.stderr).toContain('run 2 launchToFirstFrameMs 201 exceeds 200');
  f.samples[1].launchToFirstFrameMs--;
  f.samples[2].idleRssMiB++;
  writeFileSync(f.receipt, JSON.stringify({ schema: 1, runs: f.samples }));
  const memory = check(f.receipt, f.budget);
  expect(memory.status).toBe(1);
  expect(memory.stderr).toContain('run 3 idleRssMiB 81 exceeds 80');
  console.info(launch.stderr.trim(), memory.stderr.trim());
});

// Probe the runner's process seams; the release smoke separately exercises actual GPUI/Vulkan.
function harness(mode: 'ready' | 'exit' = 'ready') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-next-harness-')));
  roots.push(root);
  const bin = join(root, 'bin');
  const output = join(root, 'artifacts');
  mkdirSync(bin);
  const script = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!${process.execPath}\n${body}\n`);
    chmodSync(path, 0o700);
    return path;
  };
  const running = join(root, 'running');
  const exposed = join(root, 'exposed');
  const stopped = join(root, 'stopped');
  const captureLog = join(root, 'capture.jsonl');
  script('import', `const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(captureLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
    const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png.writeUInt32BE(1280, 16); png.writeUInt32BE(1024, 20);
    fs.writeFileSync(process.argv.at(-1).slice(4), png);`);
  script('xrefresh', `require('node:fs').writeFileSync(${JSON.stringify(exposed)}, 'exposed');`);
  script('identify', `const fs = require('node:fs');
    if (fs.existsSync(${JSON.stringify(running)}) && !fs.existsSync(${JSON.stringify(exposed)})) process.exit(4);
    console.log(fs.existsSync(${JSON.stringify(running)}) ? 100 : 1);`);
  script('ps', 'console.log(65536);');
  const app = script('shell', `const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(running)}, 'background-window');
    const file = process.argv[process.argv.indexOf('--shell-state') + 1];
    fs.writeFileSync(file, JSON.stringify({ selected: 'fixture', workspaces: { fixture: { tabs: ['Session'] } } }));
    process.on('SIGTERM', () => { fs.unlinkSync(${JSON.stringify(running)}); fs.rmSync(${JSON.stringify(exposed)}, { force: true }); fs.writeFileSync(${JSON.stringify(stopped)}, 'reaped'); process.exit(0); });
    setInterval(() => {}, 1000);`);
  const host = script('host.cjs', mode === 'exit' ? 'process.exit(2);' : `const fs = require('node:fs');
    const text = JSON.stringify({ origin: 'http://127.0.0.1:12345' }) + '\\n' + JSON.stringify({ configDir: ${JSON.stringify(root)} }) + '\\n';
    process.stdout.write(text.slice(0, 17)); setTimeout(() => process.stdout.write(text.slice(17)), 20);
    process.on('SIGTERM', () => { fs.writeFileSync(process.env.O8_NEXT_REQUEST_LOG,
      JSON.stringify(['GET /api/mobile/orchestrator/threads', 'GET /api/mobile/history'])); process.exit(0); });
    setInterval(() => {}, 1000);`);
  const budget = join(root, 'budget.json');
  const run = () => spawnSync(process.execPath, [cli, '--host', host, '--binary', app,
    '--output', output, '--budget', budget, '--record'], { encoding: 'utf8', timeout: 25_000,
    env: { ...process.env, DISPLAY: ':fixture', PATH: `${bin}:${process.env.PATH}` } });
  return { root, output, budget, run, captureLog, stopped, running };
}

it('handles chunked/reordered host readiness, captures background windows and reaps every run', () => {
  const f = harness();
  const result = f.run();
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(f.stopped)).toBe(true);
  expect(existsSync(f.running)).toBe(false);
  expect(JSON.parse(readFileSync(f.budget, 'utf8')).baseline).toHaveLength(3);
  for (const args of readFileSync(f.captureLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))) {
    expect(args.slice(0, 2)).toEqual(['-window', 'root']);
  }
  expect(result.stdout).not.toContain(f.root);
}, 30_000);

it('fails promptly when the fixture host exits during readiness without launching a shell', () => {
  const f = harness('exit');
  const result = f.run();
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain('fixture host exited before measurement completed');
  expect(existsSync(f.running)).toBe(false);
  expect(existsSync(join(f.output, 'measurements.json'))).toBe(false);
});

it('fails closed on missing, nonfinite, zero or incomplete measurements and unrecorded budgets', () => {
  const f = fixture();
  for (const runs of [[], f.samples.slice(1), [{ idleRssMiB: 1 }],
    [null, ...f.samples.slice(1)], f.samples.map(() => ({ launchToFirstFrameMs: 0, idleRssMiB: 1 })),
    f.samples.map(() => ({ launchToFirstFrameMs: 1, idleRssMiB: null }))]) {
    writeFileSync(f.receipt, JSON.stringify({ schema: 1, runs }));
    expect(check(f.receipt, f.budget).status).toBe(1);
  }
  writeFileSync(f.receipt, JSON.stringify({ schema: 1, runs: f.samples }));
  writeFileSync(f.budget, JSON.stringify({ schema: 1, launchToFirstFrameMs: 200, idleRssMiB: 80 }));
  expect(check(f.receipt, f.budget).status).toBe(1);
});

it('reads receipts through canonical temporary paths and symlinks on both platforms', () => {
  const f = fixture();
  const alias = join(f.root, 'receipt-link.json');
  symlinkSync(f.receipt, alias);
  expect(check(alias, f.budget).status).toBe(0);
  expect(JSON.parse(readFileSync(f.receipt, 'utf8')).runs).toHaveLength(3);
});
