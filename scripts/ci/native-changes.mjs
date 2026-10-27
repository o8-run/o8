#!/usr/bin/env node
// Select native work inside each required Rust job so an empty diff still
// reports a successful check. Dispatch and unavailable history compile fully.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nativeTestInputs } from './native-test-inputs.mjs';

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Comparison history unavailable');
  return result.stdout;
}

function changedNativeInputs() {
  if (process.argv.includes('--worktree')) {
    const base = git(['merge-base', 'origin/main', 'HEAD']).trim();
    return isNative(git(['diff', '--name-only', '--no-renames', '-z', base, 'HEAD', '--'])
      + git(['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--'])
      + git(['ls-files', '--others', '--exclude-standard', '-z']));
  }
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventName === 'workflow_dispatch') return true;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  let base;
  let head;
  if (eventName === 'pull_request') {
    base = event.pull_request?.base?.sha;
    head = event.pull_request?.head?.sha;
  } else if (eventName === 'merge_group') {
    base = event.merge_group?.base_sha;
    head = event.merge_group?.head_sha;
  } else if (eventName === 'push') {
    base = event.before;
    head = event.after;
  }
  if (!base || !head || /^0+$/.test(base)) return true;
  if (eventName === 'pull_request') base = git(['merge-base', base, head]).trim();
  // No rename detection: both the old and new paths must be considered,
  // including deletions. NUL delimiters preserve whitespace in file names.
  return isNative(git(['diff', '--name-only', '--no-renames', '-z', base, head, '--']));
}

function isNative(changedPaths) {
  const paths = changedPaths.split('\0');
  if (process.argv.includes('--o8-next')) {
    const inputs = nativeTestInputs(fileURLToPath(new URL('../../', import.meta.url)));
    return paths.some(file =>
      inputs.has(file)
      || ['scripts/ci/native-test-inputs.mjs', 'scripts/ci/install-native-linux-deps.sh', 'tsconfig.json'].includes(file)
      || /^(\.cargo\/|rust-toolchain(?:\.toml)?$|Cargo\.(?:toml|lock)$)/.test(file)
      || /^(native\/o8-next|scripts\/next|crates\/o8d|\.github\/actions\/next-linux-setup)\//.test(file)
      || ['package.json', 'package-lock.json', '.github/workflows/ci.yml',
        '.github/workflows/next-linux.yml', 'scripts/ci/native-changes.mjs', 'scripts/ci/native-test-shard.mjs',
        'scripts/register-server-only-stub.mjs'].includes(file));
  }
  return paths.some((file) =>
    /\.rs$/.test(file)
    || /(^|\/)Cargo\.(toml|lock)$/.test(file)
    || /(^|\/)\.cargo\//.test(file)
    || /(^|\/)rust-toolchain(\.toml)?$/.test(file)
    || /(^|\/)(tauri\.[^/]*\.conf\.json5?|tauri\.conf\.json5?|Tauri\.toml)$/.test(file)
    || /^(src-tauri|crates|tauri-plugin-mcp|tests\/fixtures\/update-ping-native)\//.test(file)
    || ['.github/workflows/ci.yml', 'scripts/ci/native-changes.mjs', 'scripts/test-update-ping-native.mjs'].includes(file));
}

let changed = true;
try {
  changed = changedNativeInputs();
} catch {
  console.warn('[native-changes] Cannot establish the diff; running the full native gates.');
}
if (process.argv.includes('--worktree')) console.log(`changed=${changed}`);
else console.log(`[native-changes] ${changed ? 'Native inputs changed or full check requested.' : 'No native inputs changed; compile steps skipped.'}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
