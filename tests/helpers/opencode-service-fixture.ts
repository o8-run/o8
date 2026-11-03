import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface FixtureOptions {
  stickyLocation?: boolean;
  holderPid?: number;
  activeSessionId?: string;
}

export interface OpenCodeServiceFixture {
  binDir: string;
  opencodeBin: string;
  logPath: string;
  readLog(): string[];
}

export function createOpenCodeServiceFixture(
  root: string,
  worktreePath: string,
  options: FixtureOptions = {},
): OpenCodeServiceFixture {
  const binDir = join(root, 'bin');
  const statePath = join(root, 'state.json');
  const logPath = join(root, 'calls.log');
  const opencodeBin = join(binDir, 'opencode2');
  const lsofBin = join(binDir, 'lsof');
  const gitBin = join(binDir, 'git');
  const holderPid = options.holderPid ?? 43210;
  const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();

  mkdirSync(binDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify({ cached: true }), 'utf8');
  writeFileSync(logPath, '', 'utf8');

  writeFileSync(opencodeBin, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
const logPath = ${JSON.stringify(logPath)};
const worktreePath = ${JSON.stringify(worktreePath)};
const stickyLocation = ${JSON.stringify(options.stickyLocation === true)};
const activeSessionId = ${JSON.stringify(options.activeSessionId ?? null)};
const state = JSON.parse(readFileSync(statePath, 'utf8'));
appendFileSync(logPath, \`opencode \${args.join(' ')}\\n\`);
if (args[0] === 'service' && args[1] === 'status') {
  process.stdout.write('running\\n');
  process.exit(0);
}
const requestPath = args[2] ?? '';
if (args[0] === 'api' && args[1] === 'get' && requestPath === '/api/debug/location') {
  process.stdout.write(JSON.stringify(state.cached ? [{ directory: worktreePath }] : []));
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'get' && requestPath === '/api/session/active') {
  process.stdout.write(JSON.stringify({ data: activeSessionId ? { [activeSessionId]: {} } : {} }));
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'get' && requestPath.startsWith('/api/session?')) {
  process.stdout.write(JSON.stringify({ data: activeSessionId ? [{ id: activeSessionId }] : [] }));
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'delete' && decodeURIComponent(requestPath).startsWith('/api/debug/location?location[directory]=')) {
  if (!stickyLocation) {
    state.cached = false;
    writeFileSync(statePath, JSON.stringify(state), 'utf8');
  }
  process.stdout.write('{}');
  process.exit(0);
}
process.stderr.write(\`unexpected opencode fixture call: \${args.join(' ')}\\n\`);
process.exit(2);
`, 'utf8');

  writeFileSync(lsofBin, `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8'));
appendFileSync(${JSON.stringify(logPath)}, \`lsof \${args.join(' ')}\\n\`);
// Close projects cwd and descriptor checks from the same complete native
// snapshot. Even after release, retain an unrelated process row: an empty or
// truncated listing is uncertainty, not evidence that the workspace is idle.
if (args.includes('-FpcLftn') || args.includes('-Fpcftn')) {
  process.stdout.write('p' + process.pid + ${JSON.stringify(`\nclsof-fixture\nfcwd\ntDIR\nn${root}\n`)});
  if (state.cached) process.stdout.write(${JSON.stringify(`p${holderPid}\ncopencode\nfcwd\ntDIR\nn${worktreePath}\nf3\ntREG\nn${worktreePath}/held\n`)});
  process.exit(0);
}
// #1853 replaced the per-directory probes with one machine-wide snapshot:
// \`lsof -nP -d cwd -F pcn\`. Real lsof exits 0 and emits p/c/n records; a tree
// with nothing open is a SUCCESSFUL probe that matches no rows. Exiting
// non-zero instead reads as "probe failed", and the guard fails closed on that.
if (args.includes('pcLftn') || args.includes('pcn') || args.includes('-Fpcn')) {
  if (state.cached) process.stdout.write(${JSON.stringify(`p${holderPid}
copencode
n${worktreePath}
`)});
  process.exit(0);
}
if (args.includes('-Fn')) {
  if (state.cached) process.stdout.write(${JSON.stringify(`p${holderPid}\nn${worktreePath}/held\n`)});
  process.exit(state.cached ? 0 : 1);
}
if (state.cached) {
  process.stdout.write(${JSON.stringify(`${holderPid}\n`)});
  process.exit(0);
}
process.exit(1);
`, 'utf8');

  writeFileSync(gitBin, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, \`git \${args.join(' ')}\\n\`);
if (args[0] === 'fetch' && args[1] === ${JSON.stringify(worktreePath)}) process.exit(0);
// Raw bytes: git writes binary pack data on stdout, which a text decode corrupts.
const result = spawnSync(${JSON.stringify(realGit)}, args, {
  cwd: process.cwd(),
  stdio: ['inherit', 'pipe', 'pipe'],
  maxBuffer: 1024 * 1024 * 1024,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`, 'utf8');

  chmodSync(opencodeBin, 0o755);
  chmodSync(lsofBin, 0o755);
  chmodSync(gitBin, 0o755);

  return {
    binDir,
    opencodeBin,
    logPath,
    readLog: () => readFileSync(logPath, 'utf8').split('\n').filter(Boolean),
  };
}
