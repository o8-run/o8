import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';

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
function harness(mode: 'ready' | 'exit' = 'ready', slowFullHistogram = false) {
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
  const sampleLog = join(root, 'sample.jsonl');
  script('import', `const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(captureLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
    const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png.writeUInt32BE(1280, 16); png.writeUInt32BE(1024, 20);
    fs.writeFileSync(process.argv.at(-1).slice(4), png);`);
  script('xrefresh', `require('node:fs').writeFileSync(${JSON.stringify(exposed)}, 'exposed');`);
  script('identify', `const fs = require('node:fs');
    if (${slowFullHistogram}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    if (fs.existsSync(${JSON.stringify(running)}) && !fs.existsSync(${JSON.stringify(exposed)})) process.exit(4);
    console.log(fs.existsSync(${JSON.stringify(running)}) ? 100 : 1);`);
  script('convert', `const fs = require('node:fs'); const args = process.argv.slice(2);
    if (JSON.stringify(args.slice(1)) !== JSON.stringify(['-sample', '25%', '-format', '%k', 'info:'])) process.exit(5);
    fs.appendFileSync(${JSON.stringify(sampleLog)}, JSON.stringify(args) + '\\n');
    if (fs.existsSync(${JSON.stringify(running)}) && !fs.existsSync(${JSON.stringify(exposed)})) process.exit(4);
    console.log(fs.existsSync(${JSON.stringify(running)}) ? 100 : 1);`);
  script('ps', 'console.log(65536);');
  const app = script('shell', `const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(running)}, 'background-window');
    const file = process.argv[process.argv.indexOf('--shell-state') + 1];
    fs.writeFileSync(file, JSON.stringify({ selected: 'fixture', workspaces: { fixture: { tabs: ['Session'] } } }));
    process.on('SIGTERM', () => { fs.unlinkSync(${JSON.stringify(running)}); fs.rmSync(${JSON.stringify(exposed)}, { force: true }); fs.writeFileSync(${JSON.stringify(stopped)}, 'reaped'); process.exit(0); });
    setInterval(() => {}, 1000);`);
  const host = script('host.cjs', mode === 'exit' ? `console.error('fixture-sensitive-child-output', ${JSON.stringify(root)}); process.exit(2);` : `const fs = require('node:fs');
    const text = JSON.stringify({ origin: 'http://127.0.0.1:12345' }) + '\\n' + JSON.stringify({ configDir: ${JSON.stringify(root)} }) + '\\n';
    process.stdout.write(text.slice(0, 17)); setTimeout(() => process.stdout.write(text.slice(17)), 20);
    process.on('SIGTERM', () => { fs.writeFileSync(process.env.O8_NEXT_REQUEST_LOG,
      JSON.stringify(['GET /api/mobile/orchestrator/threads', 'GET /api/mobile/history'])); process.exit(0); });
    setInterval(() => {}, 1000);`);
  const budget = join(root, 'budget.json');
  const run = (record = true) => spawnSync(process.execPath, [cli, '--host', host, '--binary', app,
    '--output', output, '--budget', budget, ...(record ? ['--record'] : [])], { encoding: 'utf8', timeout: record ? 25_000 : 50_000,
    env: { ...process.env, DISPLAY: ':fixture', PATH: `${bin}:${process.env.PATH}` } });
  return { root, output, budget, run, captureLog, sampleLog, stopped, running };
}

it('observes first frames within the unchanged budget without a slow full-image histogram', () => {
  const f = harness('ready', true);
  const committed = readFileSync('native/o8-next/linux-budgets.json', 'utf8');
  writeFileSync(f.budget, committed);
  const result = f.run(false);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('Three runs within launch and idle RSS budgets');
  expect(readFileSync(f.budget, 'utf8')).toBe(committed);
  expect(readFileSync(f.sampleLog, 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(3);
}, 60_000);

it('handles chunked/reordered host readiness, captures background windows and reaps every run', () => {
  const f = harness();
  mkdirSync(f.output);
  writeFileSync(join(f.output, 'failure.json'), '{"status":"failed","stage":"old-run"}');
  const result = f.run();
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(f.stopped)).toBe(true);
  expect(existsSync(f.running)).toBe(false);
  expect(existsSync(join(f.output, 'failure.json'))).toBe(false);
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
  const failure = readFileSync(join(f.output, 'failure.json'), 'utf8');
  expect(JSON.parse(failure)).toEqual({ schema: 1, status: 'failed', stage: 'fixture-host', run: 1,
    completedRuns: 0, reason: 'fixture host exited before measurement completed' });
  expect(failure + result.stderr).not.toContain(f.root);
  expect(failure + result.stderr).not.toContain('fixture-sensitive-child-output');
});

it.each(['compile', 'assertion'])('the actual CI native commands fail on a native test %s error', mode => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-next-native-gate-')));
  roots.push(root);
  const calls = join(root, 'calls.jsonl');
  const cargo = join(root, 'cargo');
  writeFileSync(cargo, `#!${process.execPath}\nconst args = process.argv.slice(2);
    require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
    if (args[0] === 'test' && args.includes('--no-run') === ${mode === 'compile'}) {
      console.error('fixture native test ${mode} failure'); process.exit(101);
    }\n`);
  chmodSync(cargo, 0o700);
  const workflow = parse(readFileSync(resolve('.github/workflows/next-linux.yml'), 'utf8'));
  const commands = workflow.jobs.shell.steps.flatMap((step: { run?: string }) =>
    step.run?.trim().startsWith('cargo ') ? [step.run] : []);
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', commands.join('\n')], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
  });
  expect(result.status, result.stderr).toBe(101);
  expect(result.stderr).toContain(`fixture native test ${mode} failure`);
  const invoked = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
  expect(invoked.some(args => args[0] === 'test' && args.includes('--no-run'))).toBe(true);
  if (mode === 'assertion') {
    const run = invoked.find(args => args[0] === 'test' && !args.includes('--no-run'))!;
    for (const suite of ['shell_cli', 'pane_grid_cli', 'terminal_cli', 'diff_cli']) expect(run).toContain(suite);
  }
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
