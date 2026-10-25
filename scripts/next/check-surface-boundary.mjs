#!/usr/bin/env node
// Check a PR's delta from its merge base, then build only its surface patch on current main.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const shell = 'native/o8-next/src/shell.rs';
// Shell additions with these prefixes are shared too (including new shell tests/helpers).
const sharedPrefixes = ['native/o8-next/src/shell', 'native/o8-next/src/render', 'native/o8-next/src/composer'];
const sharedFiles = new Set([
  shell, 'native/o8-next/src/shell_state.rs', 'native/o8-next/src/shell_view.rs',
  'native/o8-next/src/surface_registry.rs', 'native/o8-next/src/client.rs',
  'native/o8-next/src/main.rs', 'native/o8-next/src/ui.rs',
  'native/o8-next/src/model.rs', 'native/o8-next/src/retained.rs',
  'native/o8-next/src/rich.rs', 'native/o8-next/src/text.rs', 'native/o8-next/src/theme.rs',
  'scripts/next/dev-server.ts', 'scripts/next/surface-routes.ts',
]);
const isShared = path => sharedFiles.has(path) || sharedPrefixes.some(prefix => path.startsWith(prefix));
const isSurface = path => !isShared(path) && (
  /^native\/o8-next\/src\/.*\.rs$/.test(path) || path.startsWith('scripts/next/surfaces/')
);

function command(executable, args, cwd, input) {
  const result = spawnSync(executable, args, {
    cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${executable} ${args[0]} failed\n${result.stderr || result.error?.message || result.stdout}`);
  }
  return result.stdout;
}
const git = (args, cwd = process.cwd(), input) => command('git', [
  '--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
  ...args,
], cwd, input);
const diff = (base, head, args) => {
  const separator = args.indexOf('--');
  const options = separator < 0 ? args : args.slice(0, separator);
  const paths = separator < 0 ? [] : args.slice(separator);
  return git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', ...options, base, head, ...paths]);
};

// Identify actual inventory lines, not a matching string elsewhere in shell.rs.
function inventory(content) {
  const lines = content.split('\n');
  const entries = [];
  let inside = false;
  let group;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === 'register_surfaces! {') { inside = true; continue; }
    if (!inside) continue;
    if (line === '}') break;
    const opening = /^    (tabs|commands) \{$/.exec(line);
    if (opening) { group = opening[1]; continue; }
    if (line === '    }') { group = undefined; continue; }
    if (group) entries.push({ line, index, group });
  }
  return entries;
}

function registration(base, head) {
  const patch = diff(base, head, ['--unified=0', '--', shell]);
  const added = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1));
  if (added.length !== 1) return;
  const line = added[0];
  // One complete module entry, with no trailing statements, comments or path traversal.
  if (!/^ {8}([a-z][a-z0-9_]*): [A-Z][A-Za-z0-9_]*(?:\([A-Za-z0-9_:<> ,&']+\))? = "surfaces\/\1\.rs";$/.test(line)) return;
  const before = git(['show', `${base}:${shell}`]);
  const after = git(['show', `${head}:${shell}`]);
  const candidates = inventory(after).filter(entry => entry.line === line);
  if (candidates.length !== 1 || after.split('\n').filter(value => value === line).length !== 1) return;
  const entry = candidates[0];
  const lines = after.split('\n');
  lines.splice(entry.index, 1);
  if (lines.join('\n') !== before) return;
  return entry;
}

function main() {
  const args = process.argv.slice(2);
  const value = name => args[args.indexOf(name) + 1];
  if (!args.includes('--base') || !args.includes('--head')) {
    throw new Error('usage: node scripts/next/check-surface-boundary.mjs --base main --head PR_SHA [--event FILE] [--select-only]');
  }
  const base = git(['rev-parse', '--verify', '--end-of-options', `${value('--base')}^{commit}`]).trim();
  const head = git(['rev-parse', '--verify', '--end-of-options', `${value('--head')}^{commit}`]).trim();
  const ancestor = git(['merge-base', base, head]).trim();
  const stats = diff(ancestor, head, ['--numstat', '-z']).split('\0').filter(Boolean).map(record => {
    const [added, deleted, ...path] = record.split('\t');
    return { path: path.join('\t'), added: Number(added), deleted: Number(deleted) };
  });
  const relevant = stats.some(({ path }) => path.startsWith('native/o8-next/') || path.startsWith('scripts/next/'));
  const eventPath = args.includes('--event') ? value('--event') : process.env.GITHUB_EVENT_PATH;
  const event = eventPath ? JSON.parse(readFileSync(eventPath, 'utf8')) : {};
  const exempt = event.pull_request?.labels?.some(label => label.name === 'shell-work') === true;
  const selected = relevant && !exempt;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${selected}\n`);
  if (!selected) {
    console.log(exempt ? 'o8 next surface boundary: exempt (label shell-work)' : 'o8 next surface boundary: no scoped changes');
    return;
  }

  let entry;
  const violations = [];
  for (const stat of stats.filter(({ path }) => isShared(path))) {
    const count = stat.added + stat.deleted;
    if (stat.path === shell && stat.added === 1 && stat.deleted === 0) {
      entry = registration(ancestor, head);
      if (entry) continue;
    }
    const path = stat.path.replace(/[\r\n]/g, char => JSON.stringify(char).slice(1, -1));
    violations.push(`${path}: ${Number.isFinite(count) ? count : 'binary'} changed lines (+${stat.added}/-${stat.deleted}); only one added registration line is allowed; use label shell-work for shared work`);
  }
  if (violations.length) throw new Error(violations.join('\n'));
  if (args.includes('--select-only')) return;

  const temporary = mkdtempSync(join(tmpdir(), 'o8-surface-boundary-'));
  const worktree = join(temporary, 'main');
  let attached = false;
  try {
    git(['worktree', 'add', '--quiet', '--detach', worktree, base]);
    attached = true;
    const paths = stats.map(stat => stat.path).filter(isSurface);
    if (paths.length) {
      const patch = diff(ancestor, head, ['--binary', '--', ...paths.map(path => `:(literal)${path}`)]);
      git(['apply', '--3way', '--index', '-'], worktree, patch);
    }
    if (entry) {
      const file = join(worktree, shell);
      const content = readFileSync(file, 'utf8');
      const anchor = `    ${entry.group} {\n`;
      // Insert into main's inventory, preserving registrations landed since the PR forked.
      const opening = content.indexOf('register_surfaces! {\n');
      const insertion = content.indexOf(anchor, opening);
      if (opening < 0 || insertion < 0 || content.includes(entry.line)) throw new Error(`${shell}: cannot apply registration to current main; rebase the surface`);
      const offset = insertion + anchor.length;
      writeFileSync(file, content.slice(0, offset) + entry.line + '\n' + content.slice(offset));
    }
    console.log(`o8 next surface boundary: ${paths.length} surface files on main; cargo check --all-targets --locked`);
    // No PR manifests, build scripts, vendor changes or other shared edits enter this worktree.
    command('cargo', ['check', '--all-targets', '--locked', '--manifest-path', 'native/o8-next/Cargo.toml'], worktree);
    console.log('o8 next surface boundary: isolated cargo check passed');
  } finally {
    if (attached) git(['worktree', 'remove', '--force', worktree]);
    rmSync(temporary, { recursive: true, force: true });
  }
}

const started = performance.now();
try { main(); } catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  const timing = `o8 next surface boundary wall=${((performance.now() - started) / 1000).toFixed(3)} s`;
  console.log(timing);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${timing}\n`);
}
