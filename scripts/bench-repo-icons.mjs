#!/usr/bin/env node
// Compare production GET handlers over isolated HTTP fixtures, one request at a time.
// Usage: node scripts/bench-repo-icons.mjs <main-checkout> <branch-checkout> <output.json>
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const [mainRoot, branchRoot, output] = process.argv.slice(2).map(value => resolve(value));
if (!mainRoot || !branchRoot || !output) throw new Error('Expected main checkout, branch checkout and output path.');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-icon-benchmark-')));
const children = [];
const copiedFixtures = [];
const token = 'isolated-icon-benchmark-token';
const warmup = 20;
const samples = 200;
const repos = Array.from({ length: 20 }, (_, index) => {
  const localPath = join(root, `repo-${index}`);
  mkdirSync(localPath);
  execFileSync('git', ['init', '-q', '-b', 'main', localPath]);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>';
  const kind = ['favicon', 'html', 'config', 'none'][index % 4];
  if (kind === 'favicon') writeFileSync(join(localPath, 'favicon.svg'), svg);
  if (kind === 'html') {
    mkdirSync(join(localPath, 'public'));
    writeFileSync(join(localPath, 'public/index.html'), '<link rel="icon" href="/brand.svg">');
    writeFileSync(join(localPath, 'public/brand.svg'), svg);
  }
  if (kind === 'config') {
    writeFileSync(join(localPath, 't3.json'), '{"iconPath":"brand.svg"}');
    writeFileSync(join(localPath, 'brand.svg'), svg);
  }
  return {
    id: `benchmark-${index}`, name: `Benchmark ${index}`, localPath, remoteUrl: null,
    defaultBranch: 'main', isGitRepo: true, addedAt: new Date(0).toISOString(), lastOpenedAt: null,
    storagePressureParkingDisabled: false,
    setup: { envMode: 'skip', envFiles: [], installCommand: null, installOnCreateWorkspace: false,
      buildCommand: null, runBuildOnCreateWorkspace: false, devCommand: null, defaultPort: null, workspaceIsolationPreference: 'auto' },
  };
});

async function start(label, cwd) {
  const home = join(root, label);
  const data = join(home, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'repos.json'), JSON.stringify({ version: 1, repos }));
  const fixture = 'tests/fixtures/project-icon-server.ts';
  if (cwd !== branchRoot) {
    const target = join(cwd, fixture);
    mkdirSync(join(cwd, dirname(fixture)), { recursive: true });
    if (existsSync(target)) {
      if (readFileSync(target, 'utf8') !== readFileSync(join(branchRoot, fixture), 'utf8')) throw new Error('Refusing to overwrite a different main fixture.');
    } else {
      copyFileSync(join(branchRoot, fixture), target);
      copiedFixtures.push(target);
    }
  }
  const child = spawn(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', fixture], {
    cwd, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, HOME: home, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data, WS_TOKEN: token },
  });
  children.push(child);
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4000); });
  const [{ port }] = await Promise.race([
    once(child, 'message'), once(child, 'exit').then(() => { throw new Error(`${label} exited: ${diagnostics}`); }),
  ]);
  return { label, origin: `http://127.0.0.1:${port}` };
}

async function request(server) {
  const started = performance.now();
  const response = await fetch(`${server.origin}/api/panel/repos`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  const elapsedMs = performance.now() - started;
  const parsed = JSON.parse(body);
  if (response.status !== 200 || parsed.repos?.length !== 20) throw new Error(`${server.label}: invalid benchmark response`);
  if (server.label === 'main' && parsed.repos.some(repo => repo.icon !== undefined)) throw new Error('Main unexpectedly projects icons.');
  if (server.label === 'branch' && parsed.repos.filter(repo => repo.icon?.kind === 'image').length !== 15) {
    throw new Error('Branch must resolve all 15 fixture images.');
  }
  const routeMs = Number(response.headers.get('Server-Timing')?.match(/total;dur=([0-9.]+)/)?.[1]);
  return { elapsedMs, routeMs };
}

const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
function summarize(values) {
  return { p50Ms: percentile(values.map(value => value.elapsedMs), 0.5), p95Ms: percentile(values.map(value => value.elapsedMs), 0.95),
    routeP50Ms: percentile(values.map(value => value.routeMs), 0.5), routeP95Ms: percentile(values.map(value => value.routeMs), 0.95) };
}
async function main() {
  const loadBefore = loadavg();
  const mainServer = await start('main', mainRoot);
  const branchServer = await start('branch', branchRoot);
  const cold = { main: await request(mainServer), branch: await request(branchServer) };
  const measured = { main: [], branch: [] };
  for (let index = 0; index < warmup + samples; index++) {
    const order = index % 2 ? [branchServer, mainServer] : [mainServer, branchServer];
    for (const server of order) {
      const result = await request(server);
      if (index >= warmup) measured[server.label].push(result);
    }
  }
  const summary = { main: summarize(measured.main), branch: summarize(measured.branch) };
  const limits = { p50Ms: summary.main.p50Ms + Math.max(5, summary.main.p50Ms * 0.1),
    p95Ms: summary.main.p95Ms + Math.max(5, summary.main.p95Ms * 0.1) };
  const result = {
    timestamp: new Date().toISOString(), node: process.version, platform: process.platform, cpuCount: cpus().length,
    loadBefore, loadAfter: loadavg(), repositories: 20, mix: { favicon: 5, html: 5, config: 5, none: 5 },
    warmupPerRevision: warmup, samplesPerRevision: samples, order: 'AB/BA alternating per pair; sequential requests',
    coldMeaning: 'First GET after route import; process caches cold, OS caches not flushed; startup import excluded.',
    mainRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: mainRoot, encoding: 'utf8' }).trim(),
    branchRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: branchRoot, encoding: 'utf8' }).trim(),
    branchDirty: execFileSync('git', ['status', '--porcelain'], { cwd: branchRoot, encoding: 'utf8' }).trim(),
    cold, summary, limits, withinBudget: summary.branch.p50Ms <= limits.p50Ms && summary.branch.p95Ms <= limits.p95Ms,
    measured,
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ cold, summary, limits, withinBudget: result.withinBudget, loadBefore, loadAfter: result.loadAfter }, null, 2));
}

try { await main(); }
finally {
  await Promise.all(children.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
  }));
  for (const fixture of copiedFixtures) rmSync(fixture);
  rmSync(root, { recursive: true, force: true });
}
