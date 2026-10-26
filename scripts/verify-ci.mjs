#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVerificationPlan } from './lib/verify-ci.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let interrupted = false;

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
  return new Promise(resolve => {
    const child = spawn('bash', ['--noprofile', '--norc', '-e', '-c', step.command], {
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

try {
  const plan = readVerificationPlan(root);
  if (process.versions.node.split('.')[0] !== plan.nodeMajor) throw new Error(`Use Node ${plan.nodeMajor} to match CI.`);
  const expectedNpm = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).packageManager.split('@')[1];
  const npm = spawnSync('npm --version', { shell: true, encoding: 'utf8', env: environment() });
  if (npm.status !== 0 || npm.stdout.trim() !== expectedNpm) throw new Error(`Use npm ${expectedNpm} from packageManager to match CI.`);
  let failed = false;
  for (const check of plan.checks) {
    console.log(`[verify:ci] RUN ${check.name}`);
    let passed = true;
    for (const step of check.steps) {
      console.log(`[verify:ci] ${step.command}`);
      if (!await run(step)) passed = false;
      if (interrupted) break;
    }
    console.log(`[verify:ci] ${passed ? 'PASS' : 'FAIL'} ${check.name}`);
    if (!passed) failed = true;
    if (interrupted) break;
  }
  for (const note of plan.notes) console.log(`[verify:ci] ${note}`);
  console.log(`[verify:ci] Hosted lanes: ${Object.keys(plan.hostedJobs).join(', ')}`);
  process.exitCode = interrupted ? 130 : failed ? 1 : 0;
} catch (error) {
  console.error(`[verify:ci] ${error.message}`);
  process.exitCode = 1;
}
