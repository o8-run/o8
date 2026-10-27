import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const cleanupScript = path.resolve('scripts/preship-cleanup.mjs');
const preflightScript = path.resolve('scripts/ship-preflight.mjs');
const fixtures: Array<{ root: string; child: ChildProcess }> = [];
type IdentityAlias = 'none' | 'case' | 'symlink' | 'mount' | 'case-distinct';

afterEach(async () => {
  for (const { root, child } of fixtures.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

async function fixture({ removed = false, sameWorkspace = false, unknown = false,
  nested = false, alias = false, danglingAlias = false, deletedName = false,
  identityAlias = 'none' as IdentityAlias, descendantAlias = false } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'o8-producer-preflight-')));
  const workspace = path.join(root, deletedName ? 'release (deleted)' : 'release');
  const producerDirectory = identityAlias === 'case-distinct' ? path.join(root, 'RELEASE')
    : sameWorkspace ? path.join(workspace, descendantAlias ? 'linked-parent' : '.', nested ? 'nested' : '.')
      : path.join(root, 'review worktree');
  const bin = path.join(root, 'bin');
  for (const directory of [workspace, producerDirectory, bin]) mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ version: '0.0.0' }));
  const child = spawn(process.execPath, ['-e',
    'process.title = "next-server (fixture)"; process.send("ready"); setInterval(() => {}, 1000);'],
  { cwd: producerDirectory, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  fixtures.push({ root, child });
  await once(child, 'message');
  if (!child.pid) throw new Error('Fixture producer did not start');
  if (removed) rmSync(producerDirectory, { recursive: true });
  const command = identityAlias === 'none' ? 'next-server (fixture)' : 'next build';
  const calls = path.join(root, 'calls.jsonl');
  function executable(name: string, body: string) {
    writeFileSync(path.join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  }
  const record = `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ command: require('node:path').basename(process.argv[1]), args: process.argv.slice(2) }) + '\\n');`;
  executable('ps', `${record}\nconsole.log(process.argv.includes('-axo') ? ${JSON.stringify(`${child.pid} ${command}`)} : ${JSON.stringify(String(child.pid))});`);
  const aliasRoot = path.join(root, identityAlias === 'case' ? 'RELEASE' : 'mounted-release');
  const reportedDirectory = ['case', 'symlink', 'mount'].includes(identityAlias)
    ? path.join(aliasRoot, nested ? 'nested' : '.')
    : alias ? path.join(root, 'release alias', danglingAlias ? '.' : 'nested') : producerDirectory;
  if (alias) symlinkSync(danglingAlias ? producerDirectory : workspace, path.join(root, 'release alias'), 'dir');
  if (identityAlias === 'symlink') symlinkSync(descendantAlias ? path.join(workspace, 'linked-parent') : workspace, aliasRoot, 'dir');
  executable('lsof', `${record}\nconsole.log(${JSON.stringify(`p${child.pid}\nfcwd${unknown ? '' : `\nn${reportedDirectory}`}`)});`);
  // Stop a successful producer check at the first source query. Every later
  // command is a refusing fixture: no build or release service can be reached.
  executable('git', `${record}\nconsole.error('fixture source query reached'); process.exit(73);`);
  for (const name of ['npm', 'cargo', 'rustc', 'gh', 'xcrun', 'codesign', 'security']) {
    executable(name, `${record}\nconsole.error('unexpected release command'); process.exit(99);`);
  }
  const preload = path.join(root, 'darwin.cjs');
  // Model directory aliases using real directory Stats. realpath deliberately
  // preserves their spelling, as case-insensitive and mount aliases can do.
  // Production code has no fixture flags or alternate filesystem implementation.
  writeFileSync(preload, [
    'Object.defineProperty(process, "platform", { value: "darwin" });',
    ...(['case', 'mount'].includes(identityAlias) ? [
      "const fs = require('node:fs'); const path = require('node:path');",
      `const alias = ${JSON.stringify(aliasRoot)}; const target = ${JSON.stringify(workspace)};`,
      'const mapped = value => typeof value === "string" && (value === alias || value.startsWith(alias + path.sep)) ? path.join(target, path.relative(alias, value)) : value;',
      'for (const name of ["statSync", "lstatSync"]) { const original = fs[name]; fs[name] = (value, ...options) => original(mapped(value), ...options); }',
      'const original = fs.realpathSync; fs.realpathSync = (value, ...options) => { const target = mapped(value); const resolved = original(target, ...options); return target === value ? resolved : value; };',
      "require('node:module').syncBuiltinESMExports();",
    ] : []),
  ].join('\n'));
  function run(script: string, platform = 'darwin') {
    const result = spawnSync(process.execPath,
      [...(platform === 'darwin' ? ['--require', preload] : []), script], {
        cwd: workspace, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return result;
  }
  function commands(): string[] {
    return existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n')
      .map(line => (JSON.parse(line) as { command: string }).command) : [];
  }
  return { root, workspace, producerDirectory, reportedDirectory, child, command, run, commands };
}

describe.skipIf(!['linux', 'darwin'].includes(process.platform))('release producer collision check', () => {
  it.each(['native', 'darwin'])('warns with pid, command and removed working directory without blocking (%s)', async platform => {
    const files = await fixture({ removed: true });
    const result = files.run(cleanupScript, platform);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('warning');
    expect(result.stderr).toContain(String(files.child.pid));
    expect(result.stderr).toContain(files.command);
    expect(result.stderr).toContain(files.producerDirectory);
    expect(result.stderr).toContain('no longer exists');
    expect(files.child.exitCode).toBeNull();
    expect(files.child.signalCode).toBeNull();
  });

  it.each(['native', 'darwin'])('refuses a producer in the release workspace with its identity (%s)', async platform => {
    const files = await fixture({ sameWorkspace: true });
    const result = files.run(cleanupScript, platform);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refused');
    expect(result.stderr).toContain(String(files.child.pid));
    expect(result.stderr).toContain(files.command);
    expect(result.stderr).toContain(files.producerDirectory);
    expect(files.child.exitCode).toBeNull();
    expect(files.child.signalCode).toBeNull();
  });

  it('names a live producer even when the working directory probe is unavailable', async () => {
    const files = await fixture({ unknown: true });
    const result = files.run(cleanupScript);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown working directory');
    expect(result.stderr).toContain(String(files.child.pid));
    expect(result.stderr).toContain(files.command);
    expect(result.stderr).toContain('unavailable');
  });

  it.each(['native', 'darwin'])('refuses a producer in a release workspace subdirectory (%s)', async platform => {
    const files = await fixture({ sameWorkspace: true, nested: true });
    const result = files.run(cleanupScript, platform);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('live generated-output producer');
    expect(result.stderr).toContain(String(files.child.pid));
    expect(result.stderr).toContain(files.producerDirectory);
  });

  describe.each(['case', 'symlink', 'mount'] as const)('%s workspace identity alias', identityAlias => {
    it.each([false, true].flatMap(nested => [
      { entry: 'cleanup', script: cleanupScript, nested },
      { entry: 'preflight', script: preflightScript, nested },
    ]))('refuses $entry at the same directory identity (nested: $nested)', async ({ script, nested }) => {
      const files = await fixture({ sameWorkspace: true, nested, identityAlias });

      const result = files.run(script);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('live generated-output producer');
      expect(result.stderr).toContain(String(files.child.pid));
      expect(result.stderr).toContain(files.command);
      expect(result.stderr).toContain(files.reportedDirectory);
      expect(files.commands()).not.toContain('git');
      expect(files.child.exitCode).toBeNull();
      expect(files.child.signalCode).toBeNull();
    });
  });

  it.each(['case', 'mount'] as const)('refuses a missing subdirectory under a %s workspace identity alias', async identityAlias => {
    const files = await fixture({ sameWorkspace: true, nested: true, removed: true, identityAlias });
    const result = files.run(cleanupScript);

    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).not.toContain('warning');
    expect(result.stderr).toContain(String(files.child.pid));
    expect(result.stderr).toContain(files.reportedDirectory);
  });

  it('refuses a missing child through a symlink to a release subdirectory', async () => {
    const files = await fixture({ sameWorkspace: true, nested: true, removed: true,
      identityAlias: 'symlink', descendantAlias: true });
    const result = files.run(cleanupScript);

    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).not.toContain('warning');
    expect(result.stderr).toContain(String(files.child.pid));
    expect(result.stderr).toContain(files.reportedDirectory);
  });

  it('allows a distinct case-only directory on a case-sensitive volume', async context => {
    const files = await fixture({ identityAlias: 'case-distinct' });
    const release = statSync(files.workspace);
    const other = statSync(files.producerDirectory);
    if (release.dev === other.dev && release.ino === other.ino) context.skip();

    const result = files.run(cleanupScript);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('warning');
    expect(files.child.exitCode).toBeNull();
    expect(files.child.signalCode).toBeNull();
  });

  it.each([false, true])('refuses a missing directory reached through an alias into the release workspace (dangling: %s)', async danglingAlias => {
    const files = await fixture({ sameWorkspace: true, nested: true, removed: true, alias: true, danglingAlias });
    const result = files.run(cleanupScript);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).not.toContain('warning');
    expect(result.stderr).toContain(String(files.child.pid));
    expect(result.stderr).toContain(files.reportedDirectory);
  });

  it('does not strip a literal deleted suffix from a live workspace directory', async () => {
    const files = await fixture({ sameWorkspace: true, deletedName: true });
    const result = files.run(cleanupScript, 'native');

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('live generated-output producer');
    expect(result.stderr).toContain(files.producerDirectory);
  });

  it('runs the same producer check in preflight before source, network, credentials or benchmark work', async () => {
    const files = await fixture({ sameWorkspace: true });
    const result = files.run(preflightScript);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('live generated-output producer');
    expect(result.stderr).toContain(String(files.child.pid));
    expect(result.stderr).toContain(files.command);
    expect(result.stderr).toContain(files.producerDirectory);
    expect(files.commands()).toEqual(['ps', 'lsof']);
    expect(existsSync(path.join(files.workspace, '.next'))).toBe(false);
  });

  it('warns about a removed worktree in preflight and continues to the source check', async () => {
    const files = await fixture({ removed: true });
    const result = files.run(preflightScript);

    expect(result.status).toBe(1); // The source-query fixture deliberately refuses.
    expect(result.stderr).toContain('warning');
    expect(result.stderr).toContain(String(files.child.pid));
    expect(result.stderr).toContain(files.producerDirectory);
    expect(result.stderr).toContain('fixture source query reached');
    expect(files.commands()).toEqual(['ps', 'lsof', 'ps', 'git']);
  });
});
