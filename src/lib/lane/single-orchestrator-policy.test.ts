import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { SANDBOX_EXEC_PATH } from '@/lib/runtimes/shared/owned-session/sandbox';
import { codexComposerImagePaths, persistComposerImages } from '@/lib/mobile/orchestrator-image-media';
import { prepareSingleOrchestratorLaunch, singleOrchestratorEnvironment } from './single-orchestrator-policy';

const tempRoots: string[] = [];
const originalDataDir = process.env.CORTEX_IDE_DATA_DIR;
const originalMediaRoot = process.env.CORTEX_IDE_MEDIA_ROOT;
const bundledCodex = [
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  '/Applications/ChatGPT.app/Contents/Resources/codex',
].find(existsSync) ?? '/Applications/ChatGPT.app/Contents/Resources/codex';
const bundledCodeModeHost = [
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex-code-mode-host',
  '/Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host',
].find(existsSync) ?? '/Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host';
const installedCodex = (process.env.PATH ?? '')
  .split(delimiter)
  .map((entry) => join(entry, 'codex'))
  .find(existsSync);
const installedChatGptCodex = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function runPrepared(
  prepared: Awaited<ReturnType<typeof prepareSingleOrchestratorLaunch>>,
  cwd = process.cwd(),
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(prepared.binary, prepared.args, {
      cwd, env: prepared.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `sandboxed launch exited ${code}`));
    });
  });
}

/** The ChatGPT app's Codex layout: a bin/ wrapper, the host, and the executable inside CodexCLI.app. */
function chatGptCodexFixture(root: string): { wrapper: string; bundled: string } {
  const cli = join(root, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli');
  const macos = join(cli, 'CodexCLI.app', 'Contents', 'MacOS');
  mkdirSync(join(cli, 'bin'), { recursive: true });
  mkdirSync(macos, { recursive: true });
  const bundled = join(macos, 'codex');
  const wrapper = join(cli, 'bin', 'codex');
  writeFileSync(bundled, '#!/bin/sh\nprintf bundled\n', { mode: 0o700 });
  writeFileSync(wrapper, '#!/bin/sh\nexec "$(dirname "$0")/../CodexCLI.app/Contents/MacOS/codex" "$@"\n', { mode: 0o700 });
  writeFileSync(join(cli, 'bin', 'codex-code-mode-host'), '#!/bin/sh\nprintf host\n', { mode: 0o700 });
  return { wrapper, bundled };
}

function codexWithNonExecutableNativeFixture(root: string): string {
  const packageRoot = join(root, 'package');
  const pathDir = join(root, 'bin');
  const wrapper = join(packageRoot, 'bin', 'codex.js');
  const packageArch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const target = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  const native = join(packageRoot, 'node_modules', '@openai', `codex-darwin-${packageArch}`, 'vendor', target, 'bin', 'codex');
  mkdirSync(dirname(wrapper), { recursive: true });
  mkdirSync(dirname(native), { recursive: true });
  mkdirSync(pathDir, { recursive: true });
  writeFileSync(wrapper, '#!/bin/sh\nprintf wrapper\n', { mode: 0o700 });
  writeFileSync(native, '#!/bin/sh\nprintf invalid-native\n', { mode: 0o600 });
  symlinkSync(wrapper, join(pathDir, 'codex'));
  return pathDir;
}

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = originalDataDir;
  if (originalMediaRoot === undefined) delete process.env.CORTEX_IDE_MEDIA_ROOT;
  else process.env.CORTEX_IDE_MEDIA_ROOT = originalMediaRoot;
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe('Single orchestrator process boundary', () => {
  it('removes inherited control-plane credentials and pins an invalid bearer', () => {
    const env = singleOrchestratorEnvironment({
      ...process.env,
      PATH: '/bin',
      O8_API_TOKEN: 'operator',
      O8_WORKER_TOKEN: 'worker',
      O8_TAURI_MCP_SOCKET: '/tmp/socket',
      WS_TOKEN: 'ws',
      TMUX: '/tmp/tmux/default,1,0',
    }, '/tmp/codex-home');

    expect(env.PATH).toBe('/bin');
    expect(env.CODEX_HOME).toBe('/tmp/codex-home');
    expect(env.O8_API_TOKEN).toBe('single-mode-no-operator-authority');
    expect(env.O8_WORKER_TOKEN).toBeUndefined();
    expect(env.O8_TAURI_MCP_SOCKET).toBeUndefined();
    expect(env.WS_TOKEN).toBeUndefined();
    expect(env.TMUX).toBeUndefined();
  });

  it.skipIf(process.platform !== 'darwin')('keeps repo work available while token and config reads stay denied', async () => {
    const repo = tempRoot('o8-single-repo-');
    const dataDir = tempRoot('o8-single-data-');
    const codexHome = join(dataDir, 'codex-runtime');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(dataDir, 'ws-token'), 'operator-secret');
    writeFileSync(join(codexHome, 'config.toml'), 'embedded-secret');
    writeFileSync(join(codexHome, 'state.txt'), 'resume-state');
    const sourceLauncher = join(dataDir, 'codex-test-launcher');
    writeFileSync(sourceLauncher, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o700 });
    process.env.CORTEX_IDE_DATA_DIR = dataDir;

    const script = [
      'test "$(cat "$CODEX_SQLITE_HOME/state.txt")" = resume-state',
      'test ! -r "$CODEX_HOME/config.toml"',
      'test ! -r "$CORTEX_IDE_DATA_DIR/ws-token"',
      'env -u O8_API_TOKEN -u O8_WORKER_TOKEN sh -c \'test ! -r "$CORTEX_IDE_DATA_DIR/ws-token"\'',
      'if codex --version; then exit 91; fi',
      'printf ready',
      'sleep 0.2',
      'test ! -x "$O8_TEST_LAUNCH_BINARY"',
      'if chmod 700 "$O8_TEST_LAUNCH_BINARY"; then exit 92; fi',
      'if "$O8_TEST_LAUNCH_BINARY" -c true; then exit 93; fi',
      'printf ok > repo-marker.txt',
    ].join(' && ');
    const prepared = await prepareSingleOrchestratorLaunch({
      repoPath: repo,
      codexHome,
      binary: sourceLauncher,
      args: ['-c', script],
      env: process.env,
    });

    const sibling = await prepareSingleOrchestratorLaunch({
      repoPath: repo, codexHome, binary: sourceLauncher, args: ['-c', 'true'], env: process.env,
    });
    try {
      expect(() => execFileSync(SANDBOX_EXEC_PATH, [
        '-f', prepared.profilePath, '/bin/cat', sibling.launchBinaryPath,
      ], { env: prepared.env })).toThrow();
      expect(() => execFileSync(SANDBOX_EXEC_PATH, [
        '-f', prepared.profilePath, sibling.launchBinaryPath, '-c', 'true',
      ], { env: prepared.env })).toThrow();
      expect(() => execFileSync(SANDBOX_EXEC_PATH, [
        '-f', prepared.profilePath, '/bin/ln', sibling.launchBinaryPath, join(repo, 'sibling-copy'),
      ], { env: prepared.env })).toThrow();
      chmodSync(sibling.launchBinaryPath, 0o000);
      expect(() => execFileSync(SANDBOX_EXEC_PATH, [
        '-f', prepared.profilePath, '/bin/chmod', '700', sibling.launchBinaryPath,
      ], { env: prepared.env })).toThrow();
    } finally {
      sibling.cleanup();
    }
    expect(prepared.profileText).toContain('remote unix-socket');
    expect(prepared.env.CODEX_HOME).toBe(prepared.overlayPath);
    expect(prepared.env.CODEX_SQLITE_HOME).toBe(codexHome);
    expect(readFileSync(prepared.rulesPath, 'utf8')).toContain('decision="forbidden"');
    expect(() => execFileSync(SANDBOX_EXEC_PATH, [
      '-f', prepared.profilePath, '/usr/bin/env', sourceLauncher, '-c', 'true',
    ], { env: prepared.env })).toThrow();
    expect(() => execFileSync(SANDBOX_EXEC_PATH, [
      '-f', prepared.profilePath, '/bin/sh', '-c', `${sourceLauncher} -c true`,
    ], { env: prepared.env })).toThrow();
    expect(() => execFileSync(SANDBOX_EXEC_PATH, [
      '-f', prepared.profilePath, '/usr/bin/xargs', sourceLauncher, '-c', 'true',
    ], { env: prepared.env, input: 'probe\n' })).toThrow();
    expect(() => execFileSync(SANDBOX_EXEC_PATH, [
      '-f', prepared.profilePath, '/bin/sh', '-c', `echo replaced > ${prepared.guardPath}`,
    ], { env: prepared.env })).toThrow();
    const launchRoot = join(prepared.overlayPath, '..');
    prepared.env.O8_TEST_LAUNCH_BINARY = prepared.launchBinaryPath;
    await runPrepared(prepared, repo);
    expect(readFileSync(join(repo, 'repo-marker.txt'), 'utf8')).toBe('ok');
    expect(existsSync(launchRoot)).toBe(false);
    prepared.cleanup();
  });

  it.skipIf(process.platform !== 'darwin')('reads a persisted composer image from the actual Solo sandbox', async () => {
    const repo = tempRoot('o8-single-image-repo-');
    const dataDir = tempRoot('o8-single-image-data-');
    const codexHome = join(dataDir, 'codex-runtime');
    mkdirSync(codexHome, { recursive: true });
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    process.env.CORTEX_IDE_MEDIA_ROOT = join(dataDir, 'media');
    const attachment = { dataUri: `data:image/png;base64,${Buffer.from('photo bytes').toString('base64')}`, name: 'photo.png' };
    const [saved] = persistComposerImages([attachment]);
    const [imagePath] = codexComposerImagePaths([attachment], codexHome);
    expect(readFileSync(saved.path, 'utf8')).toBe('photo bytes');
    const sourceLauncher = join(dataDir, 'codex-test-launcher');
    writeFileSync(sourceLauncher, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o700 });
    const prepared = await prepareSingleOrchestratorLaunch({
      repoPath: repo,
      codexHome,
      binary: sourceLauncher,
      args: ['-c', 'cat "$1"', '--', imagePath],
      env: process.env,
    });
    try {
      expect(await runPrepared(prepared, repo)).toBe('photo bytes');
    } finally {
      prepared.cleanup();
    }
  });

  it.skipIf(process.platform !== 'darwin' || !installedCodex)('one-shot launches the real Codex binary while wrapper relaunches are OS-denied', async () => {
    const codexHome = tempRoot('o8-single-real-codex-');
    const prepared = await prepareSingleOrchestratorLaunch({
      repoPath: process.cwd(),
      codexHome,
      binary: installedCodex!,
      args: ['--version'],
      env: process.env,
    });
    try {
      const realLauncher = realpathSync(installedCodex!);
      const policy = JSON.parse(execFileSync(installedCodex!, [
        'execpolicy', 'check', '--rules', prepared.rulesPath, 'codex', 'exec',
      ], { env: prepared.env, encoding: 'utf8' })) as { decision?: string };
      expect(policy.decision).toBe('forbidden');
      expect(() => execFileSync(SANDBOX_EXEC_PATH, [
        '-f', prepared.profilePath, '/usr/bin/env', installedCodex!, '--version',
      ], { env: prepared.env })).toThrow();
      expect(() => execFileSync(SANDBOX_EXEC_PATH, [
        '-f', prepared.profilePath, '/bin/sh', '-c', `${realLauncher} --version`,
      ], { env: prepared.env })).toThrow();
      expect(() => execFileSync(SANDBOX_EXEC_PATH, [
        '-f', prepared.profilePath, '/usr/bin/xargs', realLauncher, '--version',
      ], { env: prepared.env, input: 'probe\n' })).toThrow();
      if (existsSync(bundledCodex)) {
        expect(() => execFileSync(SANDBOX_EXEC_PATH, [
          '-f', prepared.profilePath, bundledCodex, '--version',
        ], { env: prepared.env })).toThrow();
        expect(() => execFileSync(SANDBOX_EXEC_PATH, [
          '-f', prepared.profilePath, '/bin/cp', bundledCodex, join(codexHome, 'alternate-worker'),
        ], { env: prepared.env })).toThrow();
      }
      expect(await runPrepared(prepared)).toContain('codex-cli');
      expect(existsSync(join(prepared.overlayPath, '..'))).toBe(false);
    } finally {
      prepared.cleanup();
    }
  }, 30_000);

  it.skipIf(process.platform !== 'darwin' || !installedCodex || !existsSync(join(dirname(realpathSync(installedCodex ?? '/dev/null')), 'codex-code-mode-host')))(
    'executes the selected native CLI tool host beside its relocated image', async () => {
      const codexHome = tempRoot('o8-single-relocated-host-');
      const prepared = await prepareSingleOrchestratorLaunch({
        repoPath: process.cwd(),
        codexHome,
        binary: installedCodex!,
        args: ['--version'],
        env: process.env,
      });
      const relocatedHost = join(dirname(prepared.launchBinaryPath), 'codex-code-mode-host');
      try {
        const output = execFileSync(SANDBOX_EXEC_PATH, [
          '-f', prepared.profilePath, relocatedHost, '--help',
        ], { env: prepared.env, encoding: 'utf8' });
        expect(output).toContain('codex-code-mode-host');
        expect(() => execFileSync(SANDBOX_EXEC_PATH, [
          '-f', prepared.profilePath, '/bin/chmod', '700', relocatedHost,
        ], { env: prepared.env })).toThrow();
        expect(() => execFileSync(SANDBOX_EXEC_PATH, [
          '-f', prepared.profilePath, installedCodex!, '--version',
        ], { env: prepared.env })).toThrow();
      } finally {
        prepared.cleanup();
      }
    },
  );

  it.skipIf(process.platform !== 'darwin')('rejects a selected tool host aliased to the protected CLI', async () => {
    const repo = tempRoot('o8-single-host-alias-');
    const binary = join(repo, 'codex-test-launcher');
    const host = join(repo, 'codex-code-mode-host');
    const codexHome = tempRoot('o8-single-host-alias-home-');
    writeFileSync(binary, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o700 });
    symlinkSync(binary, host);
    const prepare = () => prepareSingleOrchestratorLaunch({
      repoPath: repo,
      codexHome,
      binary,
      args: ['-c', 'true'],
      env: process.env,
    });
    await expect(prepare()).rejects.toThrow('Invalid code-mode host');
    rmSync(host);
    linkSync(binary, host);
    await expect(prepare()).rejects.toThrow('Invalid code-mode host');
    rmSync(host);
    copyFileSync(binary, host);
    await expect(prepare()).rejects.toThrow('Invalid code-mode host');
  });

  it.skipIf(process.platform !== 'darwin')('rejects a host copied from another protected CLI', async () => {
    const repo = tempRoot('o8-single-other-cli-copy-');
    const binary = join(repo, 'selected-launcher');
    const host = join(repo, 'codex-code-mode-host');
    const otherBinDir = tempRoot('o8-single-other-cli-bin-');
    const otherCli = join(otherBinDir, 'codex');
    writeFileSync(binary, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o700 });
    writeFileSync(otherCli, '#!/bin/sh\nprintf alternate\n', { mode: 0o700 });
    copyFileSync(otherCli, host);
    await expect(prepareSingleOrchestratorLaunch({
      repoPath: repo,
      codexHome: tempRoot('o8-single-other-cli-home-'),
      binary,
      args: ['-c', 'true'],
      env: { ...process.env, PATH: `${otherBinDir}${delimiter}${process.env.PATH ?? ''}` },
    })).rejects.toThrow('Invalid code-mode host');
  });

  it.skipIf(process.platform !== 'darwin')('keeps the selected host source immutable across Solo turns', async () => {
    const repo = tempRoot('o8-single-host-source-repo-');
    const installation = tempRoot('o8-single-host-source-install-');
    const binary = join(installation, 'codex');
    const host = join(installation, 'codex-code-mode-host');
    const original = '#!/bin/sh\nprintf helper\n';
    writeFileSync(binary, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o700 });
    writeFileSync(host, original, { mode: 0o700 });
    const prepared = await prepareSingleOrchestratorLaunch({
      repoPath: repo,
      codexHome: tempRoot('o8-single-host-source-home-'),
      binary,
      args: ['-c', 'true'],
      env: process.env,
    });
    try {
      expect(() => execFileSync(SANDBOX_EXEC_PATH, [
        '-f', prepared.profilePath, '/bin/sh', '-c', 'printf replaced > "$1"', '--', host,
      ], { env: prepared.env })).toThrow();
      expect(() => execFileSync(SANDBOX_EXEC_PATH, [
        '-f', prepared.profilePath, '/bin/mv', host, join(installation, 'replaced-host'),
      ], { env: prepared.env })).toThrow();
      expect(() => execFileSync(SANDBOX_EXEC_PATH, [
        '-f', prepared.profilePath, '/bin/mv', installation, `${installation}-replaced`,
      ], { env: prepared.env })).toThrow();
      expect(readFileSync(host, 'utf8')).toBe(original);
    } finally {
      prepared.cleanup();
    }
  });

  it.skipIf(process.platform !== 'darwin')('runs the selected CLI through its relocated host to read the workspace', async () => {
    const repo = tempRoot('o8-single-host-workspace-');
    const installation = tempRoot('o8-single-host-workspace-install-');
    const binary = join(installation, 'codex');
    const host = join(installation, 'codex-code-mode-host');
    writeFileSync(join(repo, 'README.md'), 'workspace proof\nsecond line\n');
    writeFileSync(binary, '#!/bin/sh\n"$(dirname "$0")/codex-code-mode-host" "$1"\n', { mode: 0o700 });
    writeFileSync(host, '#!/bin/sh\nhead -n 1 "$1"\n', { mode: 0o700 });
    const prepared = await prepareSingleOrchestratorLaunch({
      repoPath: repo,
      codexHome: tempRoot('o8-single-host-workspace-home-'),
      binary,
      args: [join(repo, 'README.md')],
      env: process.env,
    });
    try {
      expect(await runPrepared(prepared, repo)).toBe('workspace proof\n');
    } finally {
      prepared.cleanup();
    }
  });

  it.skipIf(process.platform !== 'darwin').each(['legacy', 'current'])(
    'allows a distinct workspace tool host from the %s layout while denying the CLI', async (layout) => {
      const fakeHome = realpathSync(tempRoot('o8-single-layout-home-'));
      const resources = join(fakeHome, 'Applications', 'ChatGPT.app', 'Contents', 'Resources',
        ...(layout === 'current' ? ['codex-cli', 'bin'] : []));
      mkdirSync(resources, { recursive: true });
      const host = join(resources, 'codex-code-mode-host');
      writeFileSync(host, '#!/bin/sh\nprintf tool-host\n', { mode: 0o700 });
      const installation = tempRoot('o8-single-layout-cli-');
      const binary = join(installation, 'codex');
      writeFileSync(binary, '#!/bin/sh\nprintf protected-cli\n', { mode: 0o700 });
      const prepared = await prepareSingleOrchestratorLaunch({
        repoPath: process.cwd(), codexHome: tempRoot('o8-single-layout-state-'),
        binary, args: ['--version'], env: { ...process.env, HOME: fakeHome },
      });
      try {
        expect(execFileSync(SANDBOX_EXEC_PATH, ['-f', prepared.profilePath, host],
          { env: prepared.env, encoding: 'utf8' })).toBe('tool-host');
        expect(() => execFileSync(SANDBOX_EXEC_PATH,
          ['-f', prepared.profilePath, binary], { env: prepared.env })).toThrow();
      } finally { prepared.cleanup(); }
    },
  );

  it.skipIf(process.platform !== 'darwin').each([
    ['legacy', 'symlink'], ['legacy', 'hardlink'], ['legacy', 'copy'],
    ['current', 'symlink'], ['current', 'hardlink'], ['current', 'copy'],
  ] as const)('denies a %s tool host that is a %s of the protected CLI', async (layout, alias) => {
    const fakeHome = realpathSync(tempRoot('o8-single-host-alias-home-'));
    const resources = join(fakeHome, 'Applications', 'ChatGPT.app', 'Contents', 'Resources',
      ...(layout === 'current' ? ['codex-cli', 'bin'] : []));
    mkdirSync(resources, { recursive: true });
    const binary = join(tempRoot('o8-single-host-alias-cli-'), 'codex');
    writeFileSync(binary, '#!/bin/sh\nprintf forbidden-cli\n', { mode: 0o700 });
    const host = join(resources, 'codex-code-mode-host');
    if (alias === 'symlink') symlinkSync(binary, host);
    else if (alias === 'hardlink') linkSync(binary, host);
    else copyFileSync(binary, host);
    const prepared = await prepareSingleOrchestratorLaunch({
      repoPath: process.cwd(), codexHome: tempRoot('o8-single-host-alias-state-'),
      binary, args: ['--version'], env: { ...process.env, HOME: fakeHome },
    });
    try {
      expect(() => execFileSync(SANDBOX_EXEC_PATH,
        ['-f', prepared.profilePath, host], { env: prepared.env })).toThrow();
      expect(() => execFileSync(SANDBOX_EXEC_PATH,
        ['-f', prepared.profilePath, binary], { env: prepared.env })).toThrow();
    } finally { prepared.cleanup(); }
  });

  it.skipIf(process.platform !== 'darwin' || !installedCodex || !existsSync(bundledCodeModeHost))(
    'allows the installed tool host while Codex CLI relaunch remains denied', async () => {
      const codexHome = tempRoot('o8-single-tool-host-');
      const prepared = await prepareSingleOrchestratorLaunch({
        repoPath: process.cwd(),
        codexHome,
        binary: installedCodex!,
        args: ['--version'],
        env: process.env,
      });
      try {
        const output = execFileSync(SANDBOX_EXEC_PATH, [
          '-f', prepared.profilePath, bundledCodeModeHost, '--help',
        ], { env: prepared.env, encoding: 'utf8' });
        expect(output).toContain('codex-code-mode-host');
        expect(() => execFileSync(SANDBOX_EXEC_PATH, [
          '-f', prepared.profilePath, bundledCodex, '--version',
        ], { env: prepared.env })).toThrow();
      } finally {
        prepared.cleanup();
      }
    },
  );

  it.skipIf(process.platform !== 'darwin' || !installedCodex || !existsSync(bundledCodex)).each(['legacy', 'current'])(
    'does not allow a forged tool-host symlink in the %s layout to relaunch the protected CLI', async (layout) => {
      const fakeHome = realpathSync(tempRoot('o8-single-forged-home-'));
      const resources = join(fakeHome, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', ...(layout === 'current' ? ['codex-cli', 'bin'] : []));
      mkdirSync(resources, { recursive: true });
      const forgedHost = join(resources, 'codex-code-mode-host');
      symlinkSync(bundledCodex, forgedHost);
      const prepared = await prepareSingleOrchestratorLaunch({
        repoPath: process.cwd(),
        codexHome: tempRoot('o8-single-forged-codex-'),
        binary: installedCodex!,
        args: ['--version'],
        env: { ...process.env, HOME: fakeHome },
      });
      try {
        expect(() => execFileSync(SANDBOX_EXEC_PATH, [
          '-f', prepared.profilePath, forgedHost, '--version',
        ], { env: prepared.env })).toThrow();
      } finally {
        prepared.cleanup();
      }
    },
  );

  it.skipIf(process.platform !== 'darwin')('refuses to relocate ChatGPT-bundled Codex and names the standalone CLI (#2911)', async () => {
    const { wrapper, bundled } = chatGptCodexFixture(tempRoot('o8-single-chatgpt-only-'));
    const env = {
      ...process.env,
      HOME: tempRoot('o8-single-chatgpt-only-home-'),
      PATH: [dirname(wrapper), '/usr/bin', '/bin'].join(delimiter),
    };
    for (const binary of [wrapper, bundled]) {
      await expect(prepareSingleOrchestratorLaunch({
        repoPath: tempRoot('o8-single-chatgpt-only-repo-'),
        codexHome: tempRoot('o8-single-chatgpt-only-codex-'),
        binary,
        args: [],
        env,
      })).rejects.toThrow('npm i -g @openai/codex');
    }
  });

  it.skipIf(process.platform !== 'darwin')('runs a relocatable Codex on PATH when the selected one is ChatGPT-bundled (#2911)', async () => {
    const { wrapper } = chatGptCodexFixture(tempRoot('o8-single-chatgpt-fallback-'));
    const standalone = tempRoot('o8-single-standalone-');
    writeFileSync(join(standalone, 'codex'), '#!/bin/sh\nprintf standalone\n', { mode: 0o700 });
    const repo = tempRoot('o8-single-chatgpt-fallback-repo-');
    const prepared = await prepareSingleOrchestratorLaunch({
      repoPath: repo,
      codexHome: tempRoot('o8-single-chatgpt-fallback-codex-'),
      binary: wrapper,
      args: [],
      env: {
        ...process.env,
        HOME: tempRoot('o8-single-chatgpt-fallback-home-'),
        PATH: [dirname(wrapper), standalone, '/usr/bin', '/bin'].join(delimiter),
      },
    });
    try {
      expect(await runPrepared(prepared, repo)).toBe('standalone');
    } finally {
      prepared.cleanup();
    }
  });

  it.skipIf(process.platform !== 'darwin')('skips a non-executable Codex on PATH for a later relocatable install (#2911)', async () => {
    const { wrapper } = chatGptCodexFixture(tempRoot('o8-single-chatgpt-invalid-fallback-'));
    const invalid = tempRoot('o8-single-invalid-codex-');
    writeFileSync(join(invalid, 'codex'), '#!/bin/sh\nprintf invalid\n', { mode: 0o600 });
    const standalone = tempRoot('o8-single-valid-codex-');
    writeFileSync(join(standalone, 'codex'), '#!/bin/sh\nprintf standalone\n', { mode: 0o700 });
    const repo = tempRoot('o8-single-chatgpt-valid-fallback-repo-');
    const prepared = await prepareSingleOrchestratorLaunch({
      repoPath: repo,
      codexHome: tempRoot('o8-single-chatgpt-valid-fallback-codex-'),
      binary: wrapper,
      args: [],
      env: {
        ...process.env,
        HOME: tempRoot('o8-single-chatgpt-valid-fallback-home-'),
        PATH: [dirname(wrapper), invalid, standalone, '/usr/bin', '/bin'].join(delimiter),
      },
    });
    try {
      expect(await runPrepared(prepared, repo)).toBe('standalone');
    } finally {
      prepared.cleanup();
    }
  });

  it.skipIf(process.platform !== 'darwin')('skips directory and unusable native Codex candidates on PATH (#2911)', async () => {
    const { wrapper } = chatGptCodexFixture(tempRoot('o8-single-chatgpt-unusable-fallback-'));
    const directoryCandidate = tempRoot('o8-single-directory-codex-');
    mkdirSync(join(directoryCandidate, 'codex'));
    const invalidNative = codexWithNonExecutableNativeFixture(tempRoot('o8-single-invalid-native-'));
    const standalone = tempRoot('o8-single-usable-codex-');
    writeFileSync(join(standalone, 'codex'), '#!/bin/sh\nprintf standalone\n', { mode: 0o700 });
    const repo = tempRoot('o8-single-chatgpt-usable-fallback-repo-');
    const prepared = await prepareSingleOrchestratorLaunch({
      repoPath: repo,
      codexHome: tempRoot('o8-single-chatgpt-usable-fallback-codex-'),
      binary: wrapper,
      args: [],
      env: {
        ...process.env,
        HOME: tempRoot('o8-single-chatgpt-usable-fallback-home-'),
        PATH: [dirname(wrapper), directoryCandidate, invalidNative, standalone, '/usr/bin', '/bin'].join(delimiter),
      },
    });
    try {
      expect(await runPrepared(prepared, repo)).toBe('standalone');
    } finally {
      prepared.cleanup();
    }
  });

  it.skipIf(process.platform !== 'darwin' || !existsSync(installedChatGptCodex))(
    'does not relocate the installed ChatGPT-bundled Codex (#2911)', async () => {
      await expect(prepareSingleOrchestratorLaunch({
        repoPath: tempRoot('o8-single-installed-chatgpt-repo-'),
        codexHome: tempRoot('o8-single-installed-chatgpt-codex-'),
        binary: installedChatGptCodex,
        args: ['--version'],
        env: { ...process.env, HOME: tempRoot('o8-single-installed-chatgpt-home-'), PATH: ['/usr/bin', '/bin'].join(delimiter) },
      })).rejects.toThrow('npm i -g @openai/codex');
    },
  );

  it.skipIf(process.platform !== 'darwin')('kills an ignore-TERM grandchild after the supervisor exits', async () => {
    const repo = tempRoot('o8-single-group-repo-');
    const codexHome = tempRoot('o8-single-group-home-');
    const sourceLauncher = join(codexHome, 'codex-test-launcher');
    const pidFile = join(repo, 'grandchild.pid');
    writeFileSync(sourceLauncher, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o700 });
    const prepared = await prepareSingleOrchestratorLaunch({
      repoPath: repo,
      codexHome,
      binary: sourceLauncher,
      args: ['-c', [
        `/bin/sh -c 'trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 1; done' </dev/null >/dev/null 2>&1 &`,
        "trap 'exit 0' TERM",
        `while [ ! -s ${pidFile} ]; do sleep 0.01; done`,
        'printf ready',
        'while :; do sleep 1; done',
      ].join('\n')],
      env: process.env,
    });
    const supervisor = spawn(prepared.binary, prepared.args, {
      cwd: repo, env: prepared.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        supervisor.stdout.once('data', () => resolve());
        supervisor.once('error', reject);
      });
      const grandchildPid = Number(readFileSync(pidFile, 'utf8').trim());
      const supervisorClosed = new Promise<void>((resolve) => supervisor.once('close', () => resolve()));
      process.kill(-supervisor.pid!, 'SIGTERM');
      await supervisorClosed;
      expect(() => process.kill(grandchildPid, 0)).not.toThrow();
      process.kill(-supervisor.pid!, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(() => process.kill(grandchildPid, 0)).toThrow();
    } finally {
      try { process.kill(-supervisor.pid!, 'SIGKILL'); } catch {}
      prepared.cleanup();
    }
  }, 10_000);
});
