import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');
const launcher = join(repoRoot, 'scripts/dogfood/loop.sh');
const presenceGate = join(repoRoot, 'scripts/dogfood/gate.sh');
const gitShim = join(repoRoot, 'scripts/dogfood/bin/git');
const hooksDir = join(repoRoot, 'scripts/dogfood/hooks');
const queueSync = join(repoRoot, 'scripts/dogfood/queue-sync.sh');
const installer = join(repoRoot, 'scripts/dogfood/install.sh');
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const tempRoots: string[] = [];

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `o8-dogfood-${label}-`));
  tempRoots.push(root);
  return root;
}

function executable(path: string, source: string): string {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

function baseEnv(root: string, gate: string, claude: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    O8_DOGFOOD_STATE_DIR: join(root, '.o8'),
    O8_DOGFOOD_GATE_BIN: gate,
    O8_DOGFOOD_CLAUDE_BIN: claude,
    O8_DOGFOOD_REAL_GIT: realGit,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('dogfood loop wrapper', () => {
  it('uses message timestamps instead of savedAt-only rewrites for attendance', () => {
    const root = tempRoot('presence');
    const stateDir = join(root, '.o8');
    const historyDir = join(stateDir, 'chat-history');
    const historyFile = join(historyDir, 'thoughts-restored.json');
    const gateEnv = {
      ...process.env,
      O8_DOGFOOD_STATE_DIR: stateDir,
      O8_DOGFOOD_APP_BIN: join(root, 'no-app-running'),
    };
    mkdirSync(historyDir, { recursive: true });

    writeFileSync(historyFile, JSON.stringify({
      savedAt: new Date().toISOString(),
      messages: [{ role: 'user', content: 'old message', timestamp: Date.now() - 20 * 60_000 }],
    }));
    const restored = spawnSync(presenceGate, [], {
      env: gateEnv,
      encoding: 'utf8',
    });
    expect(restored.status, restored.stderr).toBe(0);
    expect(restored.stdout.trim()).toBe('UNATTENDED');

    writeFileSync(historyFile, JSON.stringify({
      savedAt: new Date().toISOString(),
      messages: [{ role: 'user', content: 'new message', timestamp: Date.now() }],
    }));
    const active = spawnSync(presenceGate, [], {
      env: gateEnv,
      encoding: 'utf8',
    });
    expect(active.status, active.stderr).toBe(0);
    expect(active.stdout.trim()).toBe('ATTENDED');

    writeFileSync(historyFile, '{');
    const ambiguous = spawnSync(presenceGate, [], {
      env: gateEnv,
      encoding: 'utf8',
    });
    expect(ambiguous.status, ambiguous.stderr).toBe(0);
    expect(ambiguous.stdout.trim()).toBe('ATTENDED');
  });

  it('loads the restricted Claude and MCP profiles, then releases its owned state', () => {
    const root = tempRoot('profile');
    const argsFile = join(root, 'claude-args');
    const mcpCopy = join(root, 'mcp.json');
    const gate = executable(join(root, 'gate'), '#!/bin/bash\necho UNATTENDED\n');
    const claude = executable(join(root, 'claude'), `#!/bin/bash
set -e
printf '%s\\n' "$@" > "$O8_TEST_ARGS_FILE"
previous=''
for arg in "$@"; do
  if [ "$previous" = '--mcp-config' ]; then cp "$arg" "$O8_TEST_MCP_COPY"; fi
  previous="$arg"
done
`);

    const result = spawnSync(launcher, [], {
      env: {
        ...baseEnv(root, gate, claude),
        O8_TEST_ARGS_FILE: argsFile,
        O8_TEST_MCP_COPY: mcpCopy,
      },
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    const args = readFileSync(argsFile, 'utf8').trim().split('\n');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual([
      '--tools',
      'Read,Edit,Write,Bash,Glob,Grep,WebFetch,WebSearch,Agent',
    ]);
    expect(args).toContain('TaskCreate');
    expect(args).toContain('EnterPlanMode');
    expect(args).not.toContain('TeamCreate');
    expect(args).not.toContain('TeamDelete');
    expect(args).toContain('--append-system-prompt-file');

    const mcp = JSON.parse(readFileSync(mcpCopy, 'utf8')) as {
      mcpServers: { o8: { env: Record<string, string> } };
    };
    expect(mcp.mcpServers.o8.env.O8_OPERATOR_MCP_PROFILE).toBe('dogfood');
    expect(mcp.mcpServers.o8.env.O8_DOGFOOD_GUARDED).toBe('1');
    expect(existsSync(join(root, '.o8', '.dogfood.lock'))).toBe(false);
    expect(existsSync(join(root, '.o8', '.dogfood-pr-only'))).toBe(false);
  });

  it('allows only one live launcher to own the driver lock', async () => {
    const root = tempRoot('lock');
    const gate = executable(join(root, 'gate'), '#!/bin/bash\necho UNATTENDED\n');
    const claude = executable(join(root, 'claude'), '#!/bin/bash\nsleep 30\n');
    const env = baseEnv(root, gate, claude);
    const first = spawn(launcher, [], { env, stdio: 'ignore' });
    const lockPid = join(root, '.o8', '.dogfood.lock', 'pid');

    for (let attempt = 0; attempt < 100 && !existsSync(lockPid); attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    expect(existsSync(lockPid)).toBe(true);

    const second = spawnSync(launcher, [], { env, encoding: 'utf8' });
    expect(second.status).toBe(75);
    expect(second.stderr).toContain('another driver owns');

    first.kill('SIGTERM');
    await new Promise<void>((resolveExit) => first.once('exit', () => resolveExit()));
    expect(existsSync(join(root, '.o8', '.dogfood.lock'))).toBe(false);
  }, 10_000);

  it('blocks every resolved push to main while feature-branch pushes still work', () => {
    const root = tempRoot('git');
    const origin = join(root, 'origin.git');
    const repo = join(root, 'repo');
    execFileSync(realGit, ['init', '--bare', '-q', origin]);
    execFileSync(realGit, ['clone', '-q', origin, repo]);
    execFileSync(realGit, ['config', 'user.email', 'dogfood@example.test'], { cwd: repo });
    execFileSync(realGit, ['config', 'user.name', 'Dogfood Guard'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'guard\n');
    execFileSync(realGit, ['add', 'README.md'], { cwd: repo });
    execFileSync(realGit, ['commit', '-qm', 'init'], { cwd: repo });
    execFileSync(realGit, ['branch', '-M', 'main'], { cwd: repo });

    const guardedEnv = {
      ...process.env,
      O8_DOGFOOD_GUARDED: '1',
      O8_DOGFOOD_REAL_GIT: realGit,
      O8_DOGFOOD_HOOKS_DIR: hooksDir,
    };
    const mainPush = spawnSync(gitShim, ['push', 'origin', 'main'], {
      cwd: repo,
      env: guardedEnv,
      encoding: 'utf8',
    });
    expect(mainPush.status).not.toBe(0);
    expect(mainPush.stderr).toContain('pushes to refs/heads/main are blocked');

    execFileSync(realGit, ['switch', '-q', '-c', 'fix/guard-proof'], { cwd: repo });
    const featurePush = spawnSync(gitShim, ['push', '-u', 'origin', 'fix/guard-proof'], {
      cwd: repo,
      env: guardedEnv,
      encoding: 'utf8',
    });
    expect(featurePush.status, featurePush.stderr).toBe(0);

    const noVerify = spawnSync(gitShim, ['push', '--no-verify', 'origin', 'fix/guard-proof'], {
      cwd: repo,
      env: guardedEnv,
      encoding: 'utf8',
    });
    expect(noVerify.status).toBe(64);

    execFileSync(realGit, ['switch', '-q', 'main'], { cwd: repo });
    const absoluteGit = spawnSync(realGit, ['push', 'origin', 'main'], {
      cwd: repo,
      env: {
        ...guardedEnv,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: hooksDir,
      },
      encoding: 'utf8',
    });
    expect(absoluteGit.status).not.toBe(0);
    expect(absoluteGit.stderr).toContain('pushes to refs/heads/main are blocked');
  });

  it('syncs the active o8 repository by default', () => {
    const root = tempRoot('queue');
    const bin = join(root, 'bin');
    const ghArgs = join(root, 'gh-args');
    mkdirSync(bin);
    executable(join(bin, 'gh'), `#!/bin/bash
printf '%s\\n' "$@" > "$O8_TEST_GH_ARGS"
echo '[]'
`);

    const result = spawnSync(queueSync, [], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        O8_DOGFOOD_STATE_DIR: join(root, '.o8'),
        O8_TEST_GH_ARGS: ghArgs,
      },
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    const args = readFileSync(ghArgs, 'utf8').trim().split('\n');
    expect(args.slice(args.indexOf('--repo'), args.indexOf('--repo') + 2)).toEqual([
      '--repo',
      'o8-run/o8',
    ]);
  });

  it('installs working entrypoints and preserves replaced owner artifacts', () => {
    const root = tempRoot('install');
    const gate = executable(join(root, 'test-gate'), '#!/bin/bash\necho UNATTENDED\n');
    writeFileSync(join(root, 'o8-dogfood-gate.sh'), 'legacy gate\n');

    const installed = spawnSync(installer, [], {
      env: {
        ...process.env,
        HOME: root,
        O8_DOGFOOD_INSTALL_HOME: root,
        O8_DOGFOOD_STATE_DIR: join(root, '.o8'),
      },
      encoding: 'utf8',
    });
    expect(installed.status, installed.stderr).toBe(0);
    expect(installed.stdout).toContain('Previous artifacts are recoverable');

    const checked = spawnSync(join(root, 'o8-dogfood-loop.sh'), ['--check'], {
      env: {
        ...process.env,
        HOME: root,
        O8_DOGFOOD_STATE_DIR: join(root, '.o8'),
        O8_DOGFOOD_GATE_BIN: gate,
      },
      encoding: 'utf8',
    });
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.stdout).toContain(`repo=${repoRoot}`);
    expect(checked.stdout).toContain('mcp_profile=dogfood');

    const backups = execFileSync('find', [join(root, '.o8', 'dogfood-artifact-backups'), '-name', 'o8-dogfood-gate.sh'], {
      encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);
    expect(backups).toHaveLength(1);
    expect(readFileSync(backups[0], 'utf8')).toBe('legacy gate\n');
  });

  it('enforces the dogfood profile through the real stdio MCP entrypoint', () => {
    const root = tempRoot('mcp-entry');
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'approve_and_merge', arguments: { packetId: 'pkt-blocked' } },
      },
    ].map((message) => JSON.stringify(message)).join('\n') + '\n';

    const result = spawnSync('npx', ['tsx', 'src/lib/mcp/operator-mcp-server.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CORTEX_IDE_DATA_DIR: join(root, '.o8'),
        O8_MCP_NO_ORPHAN_KILL: '1',
        O8_OPERATOR_MCP_PROFILE: 'dogfood',
      },
      input,
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(result.status, result.stderr).toBe(0);
    const messages = result.stdout.split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as {
        id: number;
        result?: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text?: string }> };
      });
    const listed = messages.find((message) => message.id === 2)?.result?.tools?.map((tool) => tool.name) ?? [];
    expect(listed).toContain('o8_view_type');
    // Dogfood exposes only view tools, plus the read-only result pager that #4834
    // appends to every profile. Any other tool name must fail this check.
    expect(listed).toContain('o8_result_page');
    expect(listed.filter((name) => !name.startsWith('o8_view_') && name !== 'o8_result_page')).toEqual([]);
    expect(messages.find((message) => message.id === 3)?.result).toMatchObject({ isError: true });
    expect(messages.find((message) => message.id === 3)?.result?.content?.[0]?.text)
      .toContain('Tool unavailable in operator MCP profile dogfood');
  }, 40_000);
});
