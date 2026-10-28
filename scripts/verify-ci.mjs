#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVerificationPlan } from './lib/verify-ci.mjs';
import { selectedTestsRequireBrowser } from './lib/test-classification.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let interrupted = false;
let testQueue = Promise.resolve();

function environment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:O8_|CORTEX_)/.test(key) || ['NODE_ENV', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'GH_TOKEN', 'GITHUB_TOKEN'].includes(key)) delete env[key];
  }
  return { ...env, CI: 'true' };
}

function run(step) {
  const dataDir = step.temporaryData ? mkdtempSync(path.join(tmpdir(), 'o8-verify-ci-smoke-')) : null;
  const env = { ...environment(), ...step.env, ...(dataDir ? { CORTEX_IDE_DATA_DIR: dataDir } : {}) };
  let command = step.command;
  if (step.selectedFiles || step.requiresBrowser) {
    const selected = spawnSync(process.execPath, ['scripts/ci/resource-owning-changed.mjs', 'origin/main', '--worktree'], {
      cwd: root, env, encoding: 'utf8', timeout: step.timeoutMs, maxBuffer: 4 * 1024 * 1024,
    });
    if (selected.stderr) process.stderr.write(selected.stderr);
    if (selected.status !== 0) return Promise.resolve(false);
    const files = selected.stdout.trim().split('\n').filter(Boolean);
    if (!files.length) return Promise.resolve(true);
    if (step.requiresBrowser && !selectedTestsRequireBrowser(files,
      JSON.parse(readFileSync(path.join(root, 'tests/test-classification.json'), 'utf8')))) return Promise.resolve(true);
    if (step.selectedFiles) command += files.map(file => ` '${file.replaceAll("'", "'\"'\"'")}'`).join('');
    console.log(`[verify:ci] selected ${files.length} changed integration files against origin/main`);
  }
  return new Promise(resolve => {
    const child = spawn('bash', ['--noprofile', '--norc', '-e', '-c', command], {
      cwd: root, env, stdio: 'inherit', detached: process.platform !== 'win32',
    });
    let timedOut = false;
    const kill = () => {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch { /* The command may have settled before its timeout. */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      console.error('[verify:ci] check command exceeded its CI timeout');
      kill();
    }, step.timeoutMs);
    const stop = () => { interrupted = true; kill(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    child.on('error', error => console.error(`[verify:ci] could not start command: ${error.code ?? 'unknown'}`));
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      if (dataDir) rmSync(dataDir, { recursive: true, force: true });
      resolve(code === 0 && !signal && !timedOut);
    });
  });
}

async function runStep(step, onQueueWait = () => {}) {
  if (!step.testProcess) return interrupted ? false : run(step);
  const previous = testQueue;
  let release;
  testQueue = new Promise(resolve => { release = resolve; });
  const queuedAt = Date.now();
  await previous;
  onQueueWait(Date.now() - queuedAt);
  try { return interrupted ? false : await run(step); }
  finally { release(); }
}

try {
  const branch = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: root, encoding: 'utf8', env: environment(),
  }).stdout?.trim();
  const fullIntegration = branch ? branch === 'main'
    : process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF === 'refs/heads/main';
  const plan = readVerificationPlan(root, undefined, { fullIntegration });
  if (fullIntegration) console.log('[verify:ci] main branch: full integration coverage');
  if (process.versions.node.split('.')[0] !== plan.nodeMajor) throw new Error(`Use Node ${plan.nodeMajor} to match CI.`);
  const expectedNpm = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).packageManager.split('@')[1];
  const npm = spawnSync('npm --version', { shell: true, encoding: 'utf8', env: environment() });
  if (npm.status !== 0 || npm.stdout.trim() !== expectedNpm) throw new Error(`Use npm ${expectedNpm} from packageManager to match CI.`);
  const tasks = new Map();
  for (const check of plan.checks) {
    tasks.set(check.id, (async () => {
      const dependencies = await Promise.all(check.after.map(id => tasks.get(id)));
      if (check.nativeInputs) {
        const selection = spawnSync(process.execPath, ['scripts/ci/native-changes.mjs', '--o8-next', '--worktree'], {
          cwd: root, env: environment(), encoding: 'utf8', timeout: 30_000,
        });
        if (selection.error || selection.status !== 0 || !/^changed=(true|false)\s*$/.test(selection.stdout)) {
          console.error(selection.stderr);
          console.log(`[verify:ci] FAIL ${check.name}: cannot select native inputs`);
          return false;
        }
        if (selection.stdout.trim() === 'changed=false') {
          console.log(`[verify:ci] SKIP ${check.name}: no native inputs changed`);
          return true;
        }
      }
      if (interrupted) return false;
      console.log(`[verify:ci] RUN ${check.name}`);
      let passed = check.id !== 'test' || dependencies.every(Boolean);
      let deadline = check.timeoutMs ? Date.now() + check.timeoutMs : Infinity;
      let budgetGroup;
      for (const step of check.steps) {
        if (step.budgetGroup !== undefined && step.budgetGroup !== budgetGroup) {
          budgetGroup = step.budgetGroup;
          deadline = Date.now() + check.timeoutMs;
        }
        console.log(`[verify:ci] ${step.command}`);
        const remaining = deadline - Date.now();
        if (remaining <= 0 || !await runStep({ ...step, timeoutMs: Math.min(step.timeoutMs, remaining) }, waitMs => {
          // CI has independent runners. Local resource scheduling is not
          // execution time, so pause this job's clock while it awaits admission.
          if (check.timeoutMs) {
            deadline += waitMs;
            if (waitMs > 0) console.log(`[verify:ci] excludes local queue wait from ${check.name}: ${waitMs}ms`);
          }
        })) passed = false;
        if (interrupted) break;
      }
      const required = await Promise.all((check.requiredResults ?? []).map(id => tasks.get(id)));
      if (!required.every(Boolean)) passed = false;
      console.log(`[verify:ci] ${passed ? 'PASS' : 'FAIL'} ${check.name}`);
      return passed;
    })());
  }
  const results = await Promise.all(tasks.values());
  for (const note of plan.notes) console.log(`[verify:ci] ${note}`);
  for (const [id, reason] of Object.entries(plan.hostedJobs)) console.log(`[verify:ci] HOSTED ${id}: ${reason}`);
  process.exitCode = interrupted ? 130 : results.every(Boolean) ? 0 : 1;
} catch (error) {
  console.error(`[verify:ci] ${error.message}`);
  process.exitCode = 1;
}
