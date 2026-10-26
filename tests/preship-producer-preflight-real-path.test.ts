import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const cleanupScript = path.resolve('scripts/preship-cleanup.mjs');
const preflightScript = path.resolve('scripts/ship-preflight.mjs');
const fixtures: Array<{ root: string; child: ChildProcess }> = [];

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
  nested = false, alias = false, danglingAlias = false, deletedName = false } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'o8-producer-preflight-')));
  const workspace = path.join(root, deletedName ? 'release (deleted)' : 'release');
  const producerDirectory = sameWorkspace ? path.join(workspace, nested ? 'nested' : '.')
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
  const command = 'next-server (fixture)';
  const calls = path.join(root, 'calls.jsonl');
  function executable(name: string, body: string) {
    writeFileSync(path.join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  }
  const record = `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ command: require('node:path').basename(process.argv[1]), args: process.argv.slice(2) }) + '\\n');`;
  executable('ps', `${record}\nconsole.log(process.argv.includes('-axo') ? ${JSON.stringify(`${child.pid} ${command}`)} : ${JSON.stringify(String(child.pid))});`);
  const reportedDirectory = alias ? path.join(root, 'release alias', danglingAlias ? '.' : 'nested') : producerDirectory;
  if (alias) symlinkSync(danglingAlias ? producerDirectory : workspace, path.join(root, 'release alias'), 'dir');
  executable('lsof', `${record}\nconsole.log(${JSON.stringify(`p${child.pid}\nfcwd${unknown ? '' : `\nn${reportedDirectory}`}`)});`);
  // Stop a successful producer check at the first source query. Every later
  // command is a refusing fixture: no build or release service can be reached.
  executable('git', `${record}\nconsole.error('fixture source query reached'); process.exit(73);`);
  for (const name of ['npm', 'cargo', 'rustc', 'gh', 'xcrun', 'codesign', 'security']) {
    executable(name, `${record}\nconsole.error('unexpected release command'); process.exit(99);`);
  }
  const preload = path.join(root, 'darwin.cjs');
  writeFileSync(preload, 'Object.defineProperty(process, "platform", { value: "darwin" });');
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
