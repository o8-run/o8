#!/usr/bin/env node
'use strict';

/**
 * Stop hook, observe by default. O8_COMPLETION_GATE_MODE=block is owner opt-in.
 * Subset: npm run typecheck:fast checks TS only, without CI's route-shape tests.
 * Compare tracked changes to HEAD plus untracked files: Stop supplies no session
 * starting revision. Includes pre-existing dirt; committed session edits are not
 * visible. Count both sides of renames/deletions; never log paths or contents.
 * Deadline: 60s after a measured warm typecheck of 6.59s (first run 9.80s).
 * Outer hook timeout is 75s to leave room for Git and recording on a busy host.
 * Source: scripts/hooks/completion-gate.cjs; build/install copies to dist/hooks.
 */
const { execFileSync, spawn } = require('node:child_process');
const { appendFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const TIMEOUT_MS = 60_000;
const MODE = process.env.O8_COMPLETION_GATE_MODE === 'block' ? 'block' : 'observe';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

function typecheck(root) {
  return new Promise((resolve) => {
    // Separate process group lets the deadline kill npm AND its checker on POSIX.
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'typecheck:fast'], {
      cwd: root, detached: process.platform !== 'win32',
      shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    let diagnostic = false;
    let tail = '';
    const inspect = (chunk) => {
      tail = (tail + chunk.toString()).slice(-8192);
      diagnostic ||= /\berror TS\d+:/.test(tail);
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); } catch { child.kill('SIGKILL'); }
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }, TIMEOUT_MS);
    child.on('error', () => { clearTimeout(timer); resolve({ outcome: 'could not finish', reason: 'tool failure' }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) resolve({ outcome: 'could not finish', reason: 'timeout' });
      else if (code === 0) resolve({ outcome: 'passed' });
      else if (!signal && diagnostic) resolve({ outcome: 'type errors found' });
      else resolve({ outcome: 'could not finish', reason: 'tool failure' });
    });
  });
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  if (input.hook_event_name !== 'Stop' || input.stop_hook_active === true) return;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const paths = new Set([
    ...git(root, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--']).split('\0'),
    ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(name => /\.(ts|tsx)$/.test(name)));
  if (paths.size === 0) return;
  const started = Date.now();
  const result = await typecheck(root);
  const wouldBlock = result.outcome === 'type errors found';
  // Same ignored Git state directory as the time-ledger hook; no transcript,
  // diagnostic text, session identifiers, or file names enter the record.
  const state = path.join(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(), 'o8');
  mkdirSync(state, { recursive: true });
  appendFileSync(path.join(state, 'completion-gate.jsonl'), JSON.stringify({
    time: new Date().toISOString(), mode: MODE, ...result,
    durationMs: Date.now() - started, changedFiles: paths.size, wouldBlock,
  }) + '\n');
  if (MODE === 'block' && wouldBlock) {
    process.stderr.write('[completion-gate] Type errors found by npm run typecheck:fast. Fix them before stopping.\n');
    process.exitCode = 2;
  }
}

main().catch(() => { process.exitCode = 0; });
