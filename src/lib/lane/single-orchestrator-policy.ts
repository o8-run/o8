import { randomUUID } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { prepareWorkerSandbox } from '@/lib/runtimes/shared/owned-session/sandbox';
import { mintBrainReadWorkerToken } from '@/lib/auth/brain-read-worker-token';
import { getActiveProjectScopeForRepoSync } from '@/lib/repos/projects';

const CONTROL_ENV_KEYS = [
  'O8_API_TOKEN',
  'O8_WORKER_TOKEN',
  'O8_WORKER_PACKET_ID',
  'O8_TAURI_MCP_SOCKET',
  'TAURI_MCP_AUTH_TOKEN',
  'WS_TOKEN',
  'TMUX',
  'TMUX_PANE',
] as const;

export function singleOrchestratorEnvironment(
  base: NodeJS.ProcessEnv,
  codexHome: string,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of CONTROL_ENV_KEYS) delete env[key];
  return {
    ...env,
    CODEX_HOME: codexHome,
    // Keep the CLI from falling through to an operator credential when this
    // value is present. If a shell unsets it, Seatbelt still denies token files.
    O8_API_TOKEN: 'single-mode-no-operator-authority',
  };
}

/**
 * macOS stops a copy of an app-bundle executable: the ChatGPT app's bundled
 * Codex exits 137 when copied out of CodexCLI.app (#2911). Solo runs a private
 * copy, so it cannot use one.
 */
function isAppBundleExecutable(path: string): boolean {
  return /\.app\/Contents\/MacOS\/[^/]+$/.test(path);
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const SOLO_BUNDLED_CODEX_MESSAGE = 'Solo mode cannot use the Codex CLI bundled in the ChatGPT app: '
  + 'Solo runs a private copy of Codex, and macOS stops a copy of that one. '
  + 'Install the standalone Codex CLI with `npm i -g @openai/codex`, then send the message again.';

function resolvePrivateCodexSource(binary: string): {
  nativeBinary: string;
  denyReadPaths: string[];
  denyExecPaths: string[];
} {
  const resolvedBinary = realpathSync(binary);
  // The ChatGPT app's codex-cli/bin/codex is a shell script that runs
  // ../CodexCLI.app/Contents/MacOS/codex; that executable is the real CLI.
  const bundledBehindWrapper = join(dirname(dirname(resolvedBinary)), 'CodexCLI.app', 'Contents', 'MacOS', 'codex');
  if (!resolvedBinary.endsWith('.js') && existsSync(bundledBehindWrapper)) {
    const nativeBinary = realpathSync(bundledBehindWrapper);
    return {
      nativeBinary,
      denyReadPaths: [binary, resolvedBinary, nativeBinary],
      denyExecPaths: [binary, resolvedBinary, nativeBinary],
    };
  }
  if (!resolvedBinary.endsWith('.js')) {
    return {
      nativeBinary: resolvedBinary,
      denyReadPaths: [binary, resolvedBinary],
      denyExecPaths: [binary, resolvedBinary],
    };
  }

  const packageRoot = dirname(dirname(resolvedBinary));
  const target = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  const packageArch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const candidates = [
    join(packageRoot, 'node_modules', '@openai', `codex-darwin-${packageArch}`, 'vendor', target, 'bin', 'codex'),
    join(packageRoot, 'vendor', target, 'bin', 'codex'),
  ];
  const nativeBinary = candidates.find(existsSync);
  if (!nativeBinary) {
    throw new Error(`Unable to locate Codex native executable behind ${binary}`);
  }
  return {
    nativeBinary: realpathSync(nativeBinary),
    denyReadPaths: [binary, resolvedBinary, packageRoot],
    denyExecPaths: [binary, resolvedBinary, packageRoot],
  };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * The Codex CLI a Solo turn runs. The selected binary is kept unless it is
 * app-bundled; then the next relocatable install on PATH or the standalone
 * install location is used, and with none the turn fails before launch.
 */
function selectSoloCodexBinary(binary: string, env: NodeJS.ProcessEnv): string {
  if (!isAppBundleExecutable(resolvePrivateCodexSource(binary).nativeBinary)) return binary;
  const alternates = uniqueStrings([
    ...(env.PATH ?? '').split(delimiter).filter(Boolean).map((entry) => join(entry, 'codex')),
    ...(env.HOME ? [join(env.HOME, '.codex', 'packages', 'standalone', 'current', 'bin', 'codex')] : []),
  ].filter(existsSync));
  const alternate = alternates.find((candidate) => {
    try {
      if (!isExecutableFile(candidate)) return false;
      const source = resolvePrivateCodexSource(candidate);
      return isExecutableFile(source.nativeBinary) && !isAppBundleExecutable(source.nativeBinary);
    } catch {
      return false;
    }
  });
  if (!alternate) throw new Error(SOLO_BUNDLED_CODEX_MESSAGE);
  console.log(`[single-orchestrator] ${binary} is app-bundled; Solo runs ${alternate}`);
  return alternate;
}

function discoverCodexInstallations(binaries: string[], env: NodeJS.ProcessEnv): {
  cliPaths: string[];
  nativeBinaries: string[];
  denyReadPaths: string[];
  denyExecPaths: string[];
} {
  const userApplications = env.HOME ? join(env.HOME, 'Applications') : null;
  const candidates = uniqueStrings([
    ...binaries,
    ...(env.PATH ?? '').split(delimiter).filter(Boolean).map((entry) => join(entry, 'codex')),
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    ...(userApplications ? [
      join(userApplications, 'ChatGPT.app', 'Contents', 'Resources', 'codex'),
      join(userApplications, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'),
      join(userApplications, 'Codex.app', 'Contents', 'Resources', 'codex'),
    ] : []),
  ].filter(existsSync));
  const resolved = candidates.map((candidate) => {
    try {
      return resolvePrivateCodexSource(candidate);
    } catch {
      const exact = realpathSync(candidate);
      return { nativeBinary: exact, denyReadPaths: [candidate, exact], denyExecPaths: [candidate, exact] };
    }
  });
  return {
    cliPaths: uniqueStrings(candidates.flatMap((candidate, index) => [
      candidate, realpathSync(candidate), resolved[index].nativeBinary,
    ])),
    nativeBinaries: uniqueStrings(resolved.map((item) => item.nativeBinary)),
    denyReadPaths: uniqueStrings(resolved.flatMap((item) => item.denyReadPaths)),
    denyExecPaths: uniqueStrings(resolved.flatMap((item) => item.denyExecPaths)),
  };
}

function discoverCodexToolHosts(env: NodeJS.ProcessEnv): string[] {
  const userApplications = env.HOME ? join(env.HOME, 'Applications') : null;
  const candidates = [
    '/Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host',
    '/Applications/Codex.app/Contents/Resources/codex-code-mode-host',
    ...(userApplications ? [
      join(userApplications, 'ChatGPT.app', 'Contents', 'Resources', 'codex-code-mode-host'),
      join(userApplications, 'Codex.app', 'Contents', 'Resources', 'codex-code-mode-host'),
    ] : []),
  ];
  return candidates.filter((candidate) => {
    try {
      // Re-opening a symlink target after the CLI denials would let a forged
      // helper alias restore execution of the protected Codex binary.
      return lstatSync(candidate).isFile() && realpathSync(candidate) === candidate;
    } catch {
      return false;
    }
  });
}

function hasSameExecutableBytes(host: string, protectedBinary: string): boolean {
  const hostStat = statSync(host);
  const binaryStat = statSync(protectedBinary);
  if (hostStat.dev === binaryStat.dev && hostStat.ino === binaryStat.ino) return true;
  if (hostStat.size !== binaryStat.size) return false;

  const hostFd = openSync(host, 'r');
  try {
    const binaryFd = openSync(protectedBinary, 'r');
    try {
      const hostChunk = Buffer.allocUnsafe(64 * 1024);
      const binaryChunk = Buffer.allocUnsafe(hostChunk.length);
      for (let offset = 0; offset < hostStat.size; offset += hostChunk.length) {
        const length = Math.min(hostChunk.length, hostStat.size - offset);
        if (readSync(hostFd, hostChunk, 0, length, offset) !== length ||
            readSync(binaryFd, binaryChunk, 0, length, offset) !== length) {
          throw new Error('Codex executable changed during helper validation');
        }
        if (!hostChunk.subarray(0, length).equals(binaryChunk.subarray(0, length))) return false;
      }
      return true;
    } finally {
      closeSync(binaryFd);
    }
  } finally {
    closeSync(hostFd);
  }
}

function selectedCodexToolHost(nativeBinary: string, protectedBinaries: string[]): string | null {
  const host = join(dirname(nativeBinary), 'codex-code-mode-host');
  if (!existsSync(host)) return null;
  const hostStat = lstatSync(host);
  // The selected CLI may be reached through a wrapper, but its adjacent host
  // must be a distinct regular executable, never an alias or copy of a CLI.
  if (!hostStat.isFile() || realpathSync(host) !== host || !(hostStat.mode & 0o111) ||
      protectedBinaries.some((binary) => hasSameExecutableBytes(host, binary))) {
    throw new Error('Invalid code-mode host beside selected Codex executable');
  }
  return host;
}

export async function prepareSingleOrchestratorLaunch(input: {
  repoPath: string;
  codexHome: string;
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}): Promise<{
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  profileText: string;
  profilePath: string;
  overlayPath: string;
  rulesPath: string;
  guardPath: string;
  launchBinaryPath: string;
  supervisorPath: string;
  cleanup: () => void;
}> {
  const launchId = `${process.pid}-${randomUUID()}`;
  const launchesRoot = join(input.codexHome, '.single-turns');
  const launchRoot = join(launchesRoot, launchId);
  const overlayHome = join(launchRoot, 'codex-home');
  const privateDir = join(launchRoot, 'private');
  const guardBinDir = join(overlayHome, 'bin');
  const rulesDir = join(overlayHome, 'rules');
  const launchBinaryPath = join(privateDir, '.codex-main');
  const launchToolHostPath = join(privateDir, 'codex-code-mode-host');
  const supervisorPath = join(privateDir, '.single-supervisor.mjs');
  const cleanup = () => rmSync(launchRoot, { recursive: true, force: true });

  try {
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    mkdirSync(guardBinDir, { recursive: true, mode: 0o700 });
    mkdirSync(rulesDir, { recursive: true, mode: 0o700 });
    for (const fileName of ['auth.json', 'installation_id', 'version.json']) {
      const source = join(input.codexHome, fileName);
      if (existsSync(source)) copyFileSync(source, join(overlayHome, fileName));
    }
    const overlayAuth = join(overlayHome, 'auth.json');
    if (existsSync(overlayAuth)) chmodSync(overlayAuth, 0o600);

    const sessionsDir = join(input.codexHome, 'sessions');
    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    symlinkSync(sessionsDir, join(overlayHome, 'sessions'), 'dir');

    const binary = selectSoloCodexBinary(input.binary, input.env);
    const source = resolvePrivateCodexSource(binary);
    // The originally selected binary stays denied even when Solo runs another.
    const installations = discoverCodexInstallations([binary, input.binary], input.env);
    const toolHosts = discoverCodexToolHosts(input.env);
    const selectedToolHost = selectedCodexToolHost(source.nativeBinary, installations.nativeBinaries);
    copyFileSync(source.nativeBinary, launchBinaryPath, fsConstants.COPYFILE_FICLONE);
    chmodSync(launchBinaryPath, 0o700);
    if (selectedToolHost) {
      // Code mode resolves this sibling relative to argv[0] after relocation.
      copyFileSync(selectedToolHost, launchToolHostPath, fsConstants.COPYFILE_FICLONE);
      chmodSync(launchToolHostPath, 0o500);
      if (installations.nativeBinaries.some((binary) => hasSameExecutableBytes(launchToolHostPath, binary))) {
        throw new Error('Invalid code-mode host beside selected Codex executable');
      }
    }
    const blockedPrefixes = [
      ['codex'],
      ...installations.cliPaths.map((path) => [path]),
      ['/usr/local/bin/codex'],
      ['/opt/homebrew/bin/codex'],
      ...installations.cliPaths.filter((path) => path.endsWith('.js')).flatMap((path) => [
        [process.execPath, path],
        ['node', path],
      ]),
      ['npx', 'codex'],
      ['npm', 'exec', 'codex'],
      ['pnpm', 'exec', 'codex'],
      ['bunx', 'codex'],
      ['yarn', 'codex'],
    ].filter((prefix, index, all) => (
      all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(prefix)) === index
    ));
    const rulesPath = join(rulesDir, 'single-mode.rules');
    writeFileSync(rulesPath, `${blockedPrefixes.map((pattern) => (
      `prefix_rule(pattern=${JSON.stringify(pattern)}, decision="forbidden", justification="Single mode blocks recursive Codex launches")`
    )).join('\n')}\n`, { mode: 0o600 });

    const guardPath = join(guardBinDir, 'codex');
    writeFileSync(guardPath, '#!/bin/sh\necho "Single mode blocks recursive Codex launches" >&2\nexit 126\n', { mode: 0o700 });
    chmodSync(guardPath, 0o700);
    writeFileSync(supervisorPath, [
      "import { spawn } from 'node:child_process';",
      "import { chmodSync, rmSync } from 'node:fs';",
      "import { Transform } from 'node:stream';",
      'const [, , launchBinary, cleanupRoot, sandboxBinary, ...sandboxArgs] = process.argv;',
      "const child = spawn(sandboxBinary, sandboxArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });",
      'let sealed = false;',
      'let sealFailed = false;',
      'const relay = new Transform({ transform(chunk, _encoding, callback) {',
      '  if (!sealed) {',
      '    try { chmodSync(launchBinary, 0o000); sealed = true; }',
      '    catch (error) { sealFailed = true; child.kill(\'SIGTERM\'); callback(error); return; }',
      '  }',
      '  callback(null, chunk);',
      '} });',
      'relay.on(\'error\', (error) => { console.error(`Single mode seal failed: ${error.message}`); });',
      'child.stdout.pipe(relay).pipe(process.stdout);',
      'child.stderr.pipe(process.stderr);',
      "child.once('error', (error) => { console.error(error); process.exitCode = 1; });",
      "for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {",
      '  process.on(signal, () => { if (!child.killed) child.kill(signal); });',
      '}',
      "child.once('exit', (code, signal) => {",
      '  try { rmSync(cleanupRoot, { recursive: true, force: true }); } catch {}',
      "  if (signal && !sealFailed) { process.removeAllListeners(signal); process.kill(process.pid, signal); }",
      '  else process.exitCode = sealFailed ? 1 : (code ?? 1);',
      '});',
      '',
    ].join('\n'), { mode: 0o700 });
    chmodSync(supervisorPath, 0o700);

    const dataDirs = [process.env.CORTEX_IDE_DATA_DIR, process.env.O8_DATA_DIR]
      .filter((value): value is string => Boolean(value?.trim()));
    const prepared = await prepareWorkerSandbox({
      runId: launchId,
      profileDir: launchRoot,
      cwd: input.repoPath,
      repoPath: input.repoPath,
      binary: launchBinaryPath,
      args: input.args,
      extraDenyPaths: dataDirs,
      // Codex resume state lives under ~/.o8. Re-open only this runtime home,
      // then close the files that can reintroduce operator-controlled tools.
      trustedReadWritePaths: [input.codexHome],
      finalDenyPaths: [
        ...installations.denyReadPaths,
        launchesRoot,
        join(input.codexHome, 'config.toml'),
        join(input.codexHome, 'requirements.toml'),
        join(input.codexHome, 'managed_config.toml'),
        join(input.codexHome, 'mcp-oauth-locks'),
        join(input.codexHome, 'plugins'),
        join(input.codexHome, 'shell_snapshots'),
      ],
      finalAllowReadWritePaths: [overlayHome],
      finalDenyExecPaths: [...installations.denyExecPaths, launchesRoot],
      finalDenyExecNamePrefixes: ['codex'],
      finalDenyReadBasenames: ['codex', 'codex.js'],
      finalDenyWritePaths: [launchesRoot, ...(selectedToolHost ? [dirname(selectedToolHost)] : [])],
      finalImmutableWritePaths: [rulesPath, guardPath, ...(selectedToolHost ? [launchToolHostPath] : [])],
      // The signed app's tool host is not a Codex CLI installation. Solo still
      // denies CLI recursion, but this exact helper must run for workspace tools.
      finalAllowReadPaths: [launchBinaryPath, ...(selectedToolHost ? [launchToolHostPath] : []), ...toolHosts],
      finalAllowExecPaths: [launchBinaryPath, ...(selectedToolHost ? [launchToolHostPath] : []), ...toolHosts],
    });
    const env = singleOrchestratorEnvironment(input.env, overlayHome);
    const brainScope = getActiveProjectScopeForRepoSync(realpathSync(input.repoPath));
    env.O8_WORKER_TOKEN = mintBrainReadWorkerToken(input.repoPath, brainScope.repoInActiveProject ? brainScope.projectId : null);
    env.CODEX_SQLITE_HOME = input.codexHome;
    env.PATH = `${guardBinDir}${delimiter}${env.PATH ?? ''}`;
    return {
      binary: process.execPath,
      args: [supervisorPath, launchBinaryPath, launchRoot, prepared.binary, ...prepared.args],
      env,
      profileText: prepared.profileText,
      profilePath: prepared.profilePath,
      overlayPath: overlayHome,
      rulesPath,
      guardPath,
      launchBinaryPath,
      supervisorPath,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
