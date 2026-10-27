import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as processHelpers from '@/lib/providers/child-process';

import { captureExactDirectoryManifest, purgeExactDirectory, readCapturedPurgeCwdSnapshot } from './exact-directory-purge';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('exact directory purge', () => {
  function aliasedFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'o8-exact-purge-alias-'));
    roots.push(root);
    const source = path.join(root, 'source');
    const alias = path.join(root, 'alias');
    mkdirSync(path.join(source, 'parent', 'retired'), { recursive: true });
    symlinkSync(source, alias, 'dir');
    const candidate = path.join(alias, 'parent', 'retired');
    writeFileSync(path.join(candidate, 'owned.txt'), 'preserve owned bytes');
    return { root, source, alias, candidate };
  }

  it.skipIf(process.platform === 'win32')('attests a native purge through an unchanged ancestor alias', async () => {
    const { candidate, alias } = aliasedFixture();
    mkdirSync(path.join(candidate, 'z-nested/deep'), { recursive: true });
    writeFileSync(path.join(candidate, 'z-nested/deep/last.txt'), 'nested traversal returns to root for attestation');
    const stat = await lstat(candidate);
    let captured = false;
    await expect(purgeExactDirectory(candidate, { device: stat.dev, inode: stat.ino }, undefined,
      async (requested, witness) => {
        expect(requested).toBe(candidate);
        expect(realpathSync(candidate)).not.toBe(path.resolve(candidate));
        const snapshot = await readCapturedPurgeCwdSnapshot(witness, alias);
        expect(snapshot.status).toBe('ready');
        captured = true;
      })).resolves.toBeUndefined();
    expect(captured).toBe(true);
    expect(existsSync(candidate)).toBe(false);
  }, 30_000);

  it.skipIf(process.platform === 'win32')('refuses an alias retargeted before native capture', async () => {
    const { root, alias, candidate, source } = aliasedFixture();
    const other = path.join(root, 'other');
    mkdirSync(path.join(other, 'parent', 'retired'), { recursive: true });
    writeFileSync(path.join(other, 'parent', 'retired', 'owned.txt'), 'preserve replacement');
    const stat = await lstat(candidate);
    await expect(purgeExactDirectory(candidate, { device: stat.dev, inode: stat.ino }, async () => {
      unlinkSync(alias);
      symlinkSync(other, alias, 'dir');
    })).rejects.toThrow();
    expect(readFileSync(path.join(source, 'parent', 'retired', 'owned.txt'), 'utf8')).toBe('preserve owned bytes');
    expect(readFileSync(path.join(candidate, 'owned.txt'), 'utf8')).toBe('preserve replacement');
  });

  it.skipIf(process.platform === 'win32')('refuses an alias retargeted after capture without releasing either tree', async () => {
    const { root, alias, candidate, source } = aliasedFixture();
    const other = path.join(root, 'other');
    mkdirSync(path.join(other, 'parent', 'retired'), { recursive: true });
    writeFileSync(path.join(other, 'parent', 'retired', 'owned.txt'), 'preserve replacement');
    const stat = await lstat(candidate);
    await expect(purgeExactDirectory(candidate, { device: stat.dev, inode: stat.ino }, undefined, async () => {
      renameSync(alias, alias + '-prior');
      symlinkSync(other, alias, 'dir');
    })).rejects.toThrow();
    expect(readFileSync(path.join(source, 'parent', 'retired', 'owned.txt'), 'utf8')).toBe('preserve owned bytes');
    expect(readFileSync(path.join(candidate, 'owned.txt'), 'utf8')).toBe('preserve replacement');
  });

  it.skipIf(process.platform === 'win32')('refuses an alias replaced with the same target after capture', async () => {
    const { alias, candidate, source } = aliasedFixture();
    const stat = await lstat(candidate);
    await expect(purgeExactDirectory(candidate, { device: stat.dev, inode: stat.ino }, undefined, async () => {
      renameSync(alias, alias + '-prior');
      symlinkSync(source, alias, 'dir');
    })).rejects.toThrow();
    expect(readFileSync(path.join(candidate, 'owned.txt'), 'utf8')).toBe('preserve owned bytes');
  });

  it.skipIf(process.platform === 'win32')('refuses a captured directory replaced by a symlink', async () => {
    const { candidate } = aliasedFixture();
    const stat = await lstat(candidate);
    await expect(purgeExactDirectory(candidate, { device: stat.dev, inode: stat.ino }, undefined, async () => {
      renameSync(candidate, candidate + '-prior');
      symlinkSync(candidate + '-prior', candidate, 'dir');
    })).rejects.toThrow();
    expect(readFileSync(path.join(candidate + '-prior', 'owned.txt'), 'utf8')).toBe('preserve owned bytes');
  });

  it.skipIf(process.platform === 'win32')('refuses a replaced parent even when the candidate inode is retained', async () => {
    const { candidate } = aliasedFixture();
    const stat = await lstat(candidate);
    const parent = path.dirname(candidate);
    await expect(purgeExactDirectory(candidate, { device: stat.dev, inode: stat.ino }, undefined, async () => {
      renameSync(parent, parent + '-prior');
      mkdirSync(parent);
      renameSync(path.join(parent + '-prior', 'retired'), candidate);
    })).rejects.toThrow();
    expect(readFileSync(path.join(candidate, 'owned.txt'), 'utf8')).toBe('preserve owned bytes');
  });

  it.skipIf(process.platform === 'win32')('refuses every unsupported node before truncating an earlier file', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'o8-exact-purge-unknown-node-'));
    roots.push(root);
    const directoryPath = path.join(root, 'retired-workspace');
    mkdirSync(directoryPath);
    const sourcePath = path.join(directoryPath, 'a-first.txt');
    writeFileSync(sourcePath, 'unique bytes must survive');
    execFileSync('mkfifo', [path.join(directoryPath, 'z-unsupported-node')]);
    const stat = await lstat(directoryPath);
    await expect(purgeExactDirectory(directoryPath, { device: stat.dev, inode: stat.ino }))
      .rejects.toThrow('non-file workspace entries');
    expect(readFileSync(sourcePath, 'utf8')).toBe('unique bytes must survive');
    expect(existsSync(directoryPath)).toBe(true);
  });

  it('refuses a hard link created after tree capture without truncating either name', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'o8-exact-purge-hardlink-'));
    roots.push(root);
    const directoryPath = path.join(root, 'retired-workspace');
    const sourcePath = path.join(directoryPath, 'owned.txt');
    const externalPath = path.join(root, 'external-hardlink.txt');
    mkdirSync(directoryPath);
    writeFileSync(sourcePath, 'preserve these bytes');
    const stat = await lstat(directoryPath);

    await expect(purgeExactDirectory(
      directoryPath,
      { device: stat.dev, inode: stat.ino },
      undefined,
      async () => { linkSync(sourcePath, externalPath); },
    )).rejects.toThrow('identity changed after capture');
    expect(readFileSync(sourcePath, 'utf8')).toBe('preserve these bytes');
    expect(readFileSync(externalPath, 'utf8')).toBe('preserve these bytes');
  });

  it('releases both internal hardlink names without treating the first unlink as drift', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'o8-exact-purge-internal-hardlink-'));
    roots.push(root);
    const directoryPath = path.join(root, 'retired-workspace');
    const firstPath = path.join(directoryPath, 'first.txt');
    mkdirSync(directoryPath);
    writeFileSync(firstPath, 'owned shared bytes');
    linkSync(firstPath, path.join(directoryPath, 'second.txt'));
    const stat = await lstat(directoryPath);

    await expect(purgeExactDirectory(
      directoryPath,
      { device: stat.dev, inode: stat.ino },
    )).resolves.toBeUndefined();
    expect(() => readFileSync(firstPath, 'utf8')).toThrow();
  });

  it.skipIf(process.platform === 'win32').each(['progressing', 'stopped'] as const)(
    'bounds capture by completed entry progress and settles a %s helper', async mode => {
      const root = mkdtempSync(path.join(tmpdir(), 'o8-exact-purge-progress-'));
      roots.push(root);
      const candidate = path.join(root, 'output');
      mkdirSync(candidate);
      for (let index = 0; index < 768; index++) writeFileSync(path.join(candidate, index + '.js'), 'owned output');
      const stat = await lstat(candidate);
      const originalSpawn = processHelpers.spawn;
      let injected = false;
      let closed: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      vi.spyOn(processHelpers, 'spawn').mockImplementation(((...supplied: unknown[]) => {
        const command = supplied[0] as string;
        const args = Array.isArray(supplied[1]) ? supplied[1] as string[] : undefined;
        if (args?.[0] === '-e' && args[1].includes('O8_PURGE_CAPTURED')) {
          const script = mode === 'stopped'
            ? args[1].replace("  beginPhase('capture');", "  beginPhase('capture'); process.kill(process.pid, 'SIGSTOP');")
            : args[1].replace('function progress(entries, done = false) {', `function progress(entries, done = false) {
                if (phase === 'capture' && entries % 128 === 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);`);
          injected = script !== args[1];
          const child = Reflect.apply(originalSpawn, processHelpers,
            [command, ['-e', script, ...args.slice(2)], supplied[2]]) as ChildProcess;
          child.once('close', (code, signal) => { closed = { code, signal }; });
          return child;
        }
        return Reflect.apply(originalSpawn, processHelpers, supplied) as ChildProcess;
      }) as typeof processHelpers.spawn);
      // Exercise the production watchdog without taking a minute per fixture.
      const originalTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, delay, ...args) =>
        originalTimeout(handler, delay === 60_000 ? 1_000 : delay, ...args));
      const operation = purgeExactDirectory(candidate, { device: stat.dev, inode: stat.ino });
      if (mode === 'stopped') {
        await expect(operation).rejects.toThrow(/capture stalled after \d+ms \(0 entries; no progress for 60000ms\)/);
        expect(closed).toEqual({ code: null, signal: 'SIGKILL' });
        expect(readdirSync(candidate)).toHaveLength(768);
        expect(readFileSync(path.join(candidate, '0.js'), 'utf8')).toBe('owned output');
      } else {
        await expect(operation).resolves.toBeUndefined();
        expect(closed).toEqual({ code: 0, signal: null });
        expect(existsSync(candidate)).toBe(false);
      }
      expect(injected).toBe(true);
    }, 30_000,
  );

  it('resumes an exact monotonic manifest after process death during namespace release', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'o8-exact-purge-namespace-crash-'));
    roots.push(root);
    const directoryPath = path.join(root, 'retired-workspace');
    const nested = path.join(directoryPath, 'nested/deep');
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, 'first.txt'), 'first bytes');
    writeFileSync(path.join(nested, 'second.txt'), 'shared bytes');
    linkSync(path.join(nested, 'second.txt'), path.join(nested, 'third.txt'));
    const stat = await lstat(directoryPath);
    const identity = { device: stat.dev, inode: stat.ino };
    const manifest = await captureExactDirectoryManifest(directoryPath, identity);
    const markerPath = path.join(root, 'namespace-release.marker');
    const runnerPath = path.join(root, 'namespace-crash-runner.ts');
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), 'src/lib/workspace/exact-directory-purge.ts'),
    ).href;
    writeFileSync(runnerPath, `
      // The production environment allowlist deliberately omits test controls.
      // Inject this fixture's stop marker only at the native test spawn edge.
      const cp = require('node:child_process');
      const nativeSpawn = cp.spawn;
      cp.spawn = (command, args, options) => nativeSpawn(command, args, args?.[0] === '-e'
        && args[1].includes('O8_PURGE_CAPTURED') ? { ...options, env: { ...options.env,
          NODE_ENV: 'test', O8_TEST_PURGE_STOP_MARKER: process.env.O8_TEST_PURGE_STOP_MARKER } } : options);
      require('node:module').syncBuiltinESMExports();
      void import(${JSON.stringify(moduleUrl)}).then(namespace => {
        const { purgeExactDirectory } = namespace.default ?? namespace;
        const input = JSON.parse(process.env.O8_PURGE_TEST_INPUT);
        return purgeExactDirectory(
        input.directoryPath,
        input.identity,
        undefined,
        undefined,
        undefined,
        input.manifest.fingerprint,
        input.manifest.entries,
        );
      });
    `);
    const child = spawn(process.execPath, ['--import', 'tsx', runnerPath], {
      cwd: process.cwd(),
      detached: true,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        O8_TEST_PURGE_STOP_MARKER: markerPath,
        O8_PURGE_TEST_INPUT: JSON.stringify({ directoryPath, identity, manifest }),
        // The crash child is a bare node process, so it never sees Vitest's
        // 'server-only' alias. Load the purge module the way the packaged
        // server does, or its transitive 'server-only' poison pill throws
        // before any namespace entry is released.
        NODE_OPTIONS: [process.env.NODE_OPTIONS?.trim(), '--conditions=react-server']
          .filter(Boolean)
          .join(' '),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let childErrors = '';
    child.stderr?.on('data', chunk => { childErrors += chunk; });
    const deadline = Date.now() + 15_000;
    while (!existsSync(markerPath)) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('Exact purge crash child exited before namespace release: ' + childErrors);
      }
      if (Date.now() >= deadline) throw new Error('Exact purge crash child timed out.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    process.kill(-child.pid!, 'SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    expect(readdirSync(directoryPath).length).toBeGreaterThan(0);

    await expect(purgeExactDirectory(
      directoryPath,
      identity,
      undefined,
      undefined,
      undefined,
      manifest.fingerprint,
      manifest.entries,
    )).resolves.toBeUndefined();
    expect(existsSync(directoryPath)).toBe(false);
  }, 30_000);
});
