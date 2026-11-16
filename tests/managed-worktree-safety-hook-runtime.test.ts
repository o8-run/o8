import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  managedWorkspaceSafetyHooksContent,
  previousManagedWorkspaceSafetyHooksContent,
  resolveManagedWorkspaceSafetyHookRuntime,
} from '@/lib/worktree/safety-hooks';

const timeLedger = createRequire(import.meta.url)(
  path.join(process.cwd(), 'dist', 'hooks', 'time-ledger.js'),
) as {
  normalizeCommand(command: unknown, cwd?: string): string | null;
  formatDuration(ms: number): string;
};

const parent = path.join(os.tmpdir(), "o8 hook's packaged runtime");
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(path.join(parent, 'case-'));
const serverRoot = path.join(root, 'server');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('managed worktree safety-hook runtime', () => {
  it('exports and executes the packaged hook runtime with exact quoted paths', async () => {
    const tauriConfig = JSON.parse(readFileSync(
      path.join(process.cwd(), 'src-tauri', 'tauri.conf.json'),
      'utf8',
    )) as { bundle: { resources: Record<string, string> } };
    expect(tauriConfig.bundle.resources['../out/server']).toBe('server/');
    expect(readFileSync(path.join(process.cwd(), 'scripts', 'tauri-export.mjs'), 'utf8'))
      .toContain('exportTauriSafetyHookResources(root, server)');
    const helperUrl = pathToFileURL(
      path.join(process.cwd(), 'scripts', 'tauri-hook-resources.mjs'),
    ).href;
    execFileSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `const { exportTauriSafetyHookResources } = await import(${JSON.stringify(helperUrl)}); exportTauriSafetyHookResources(process.argv[1], process.argv[2]);`,
      process.cwd(),
      serverRoot,
    ]);

    const runtime = await resolveManagedWorkspaceSafetyHookRuntime({
      runtimeRoot: serverRoot,
      packaged: true,
      nodePath: process.execPath,
    });
    expect(Object.values(runtime.hookPaths).every((hookPath) => existsSync(hookPath))).toBe(true);

    const settings = JSON.parse(managedWorkspaceSafetyHooksContent(runtime)) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const command = settings.hooks.PreToolUse[0]!.hooks[0]!.command;
    const executed = spawnSync('/bin/sh', ['-c', command], {
      cwd: root,
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'safety-hook-runtime-proof',
        tool_name: 'Bash',
        tool_input: { command: 'git status --short' },
        tool_use_id: 'tool-proof',
      }),
    });
    expect(executed.status, executed.stderr).toBe(0);
    expect(JSON.parse(executed.stdout.trim())).toMatchObject({ decision: 'approve' });
  });

  it('fails closed when the packaged hook resources are absent', async () => {
    await expect(resolveManagedWorkspaceSafetyHookRuntime({
      runtimeRoot: path.join(root, 'missing'),
      packaged: true,
      nodePath: process.execPath,
    })).rejects.toThrow(/no complete safety-hook runtime/);
  });
});

describe('time ledger hook', () => {
  const repo = path.join(root, 'clock repo');
  const slowCommand = 'cargo build --release';
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

  async function clockCommand(): Promise<string> {
    const runtime = await resolveManagedWorkspaceSafetyHookRuntime({
      runtimeRoot: process.cwd(),
      packaged: false,
      nodePath: process.execPath,
    });
    const settings = JSON.parse(managedWorkspaceSafetyHooksContent(runtime)) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      expect(settings.hooks[event]!.at(-1)).toMatchObject({ matcher: 'Bash' });
    }
    expect(settings.hooks.SessionStart).toHaveLength(1);
    const previous = JSON.parse(previousManagedWorkspaceSafetyHooksContent(runtime)) as typeof settings;
    expect(Object.keys(previous.hooks)).toEqual(['PreToolUse', 'PostToolUse']);
    expect(JSON.stringify(previous)).not.toContain('time-ledger.js');
    return settings.hooks.PreToolUse!.at(-1)!.hooks[0]!.command;
  }

  function run(command: string, payload: Record<string, unknown>, managed: boolean) {
    const env = { ...process.env };
    delete env.O8_TIME_GATE_MS;
    delete env.O8_TIME_LEDGER;
    if (managed) env.O8_MANAGED_SESSION = '1';
    else delete env.O8_MANAGED_SESSION;
    const executed = spawnSync('/bin/sh', ['-c', command], {
      cwd: repo,
      encoding: 'utf8',
      env,
      input: JSON.stringify({ session_id: 'clock-proof', cwd: repo, tool_name: 'Bash', ...payload }),
    });
    expect(executed.status, executed.stderr).toBe(0);
    const output = executed.stdout.trim();
    return output
      ? (JSON.parse(output) as { hookSpecificOutput: Record<string, string> }).hookSpecificOutput
      : null;
  }

  it('reduces a command to the part that costs time', () => {
    expect(timeLedger.normalizeCommand(
      `cd ${repo} && CI=true timeout 3600 npm run verify:ci 2>&1 | tail -20`,
      repo,
    )).toBe('npm run verify:ci');
    expect(timeLedger.normalizeCommand('cargo build --release > build.log 2>&1')).toBe(slowCommand);
    expect(timeLedger.normalizeCommand('cd native && cargo test; echo done')).toBe('cargo test');
    expect(timeLedger.normalizeCommand('cd /tmp')).toBeNull();
    expect(timeLedger.formatDuration(28 * 60_000)).toBe('28 min');
  });

  it('records a slow run, stops a managed agent once, and names what changed', async () => {
    mkdirSync(repo, { recursive: true });
    git('init', '-q');
    writeFileSync(path.join(repo, 'main.rs'), 'fn main() {}\n');
    git('add', '-A');
    git('-c', 'user.email=test@o8.invalid', '-c', 'user.name=o8-test', 'commit', '-q', '-m', 'fixture');
    const command = await clockCommand();
    const tool_input = { command: `cd ${repo} && ${slowCommand} 2>&1 | tail -5` };

    expect(run(command, { hook_event_name: 'PreToolUse', tool_use_id: 'first', tool_input }, true))
      .toBeNull();
    const note = run(command, {
      hook_event_name: 'PostToolUse', tool_use_id: 'first', tool_input, duration_ms: 28 * 60_000,
    }, true);
    expect(note?.additionalContext).toContain('`cargo build --release` took 28 min');
    expect(git('status', '--porcelain')).toBe('');

    appendFileSync(path.join(repo, 'main.rs'), '// one\n// two\n');
    const stopped = run(command, { hook_event_name: 'PreToolUse', tool_use_id: 'second', tool_input }, true);
    expect(stopped).toMatchObject({ permissionDecision: 'deny' });
    expect(stopped?.permissionDecisionReason).toContain('takes about 28 min here (median of 1 run)');
    expect(stopped?.permissionDecisionReason).toContain('2 lines in 1 file changed since its last run');
    expect(git('status', '--porcelain').trim()).toBe('M main.rs');

    expect(run(command, { hook_event_name: 'PreToolUse', tool_use_id: 'third', tool_input }, true))
      .toBeNull();
    expect(run(command, { hook_event_name: 'PreToolUse', tool_use_id: 'fourth', tool_input }, true))
      .toMatchObject({ permissionDecision: 'deny' });

    const advised = run(command, { hook_event_name: 'PreToolUse', tool_use_id: 'fifth', tool_input }, false);
    expect(advised?.permissionDecision).toBeUndefined();
    expect(advised?.additionalContext).toContain('takes about 28 min here');

    expect(run(command, {
      hook_event_name: 'PreToolUse', tool_use_id: 'sixth', tool_input: { command: 'git status --short' },
    }, true)).toBeNull();
    expect(run(command, {
      hook_event_name: 'PreToolUse',
      tool_use_id: 'seventh',
      tool_input: { ...tool_input, run_in_background: true },
    }, true)).toBeNull();

    const listed = run(command, { hook_event_name: 'SessionStart', tool_name: undefined }, true);
    expect(listed?.additionalContext).toContain('- `cargo build --release`: about 28 min');
    expect(existsSync(path.join(repo, '.git', 'o8', 'time-ledger.json'))).toBe(true);
  });

  it('lets every command run outside a Git repository', async () => {
    const command = await clockCommand();
    const outside = mkdtempSync(path.join(os.tmpdir(), 'o8-clock-outside-'));
    try {
      const executed = spawnSync('/bin/sh', ['-c', command], {
        cwd: outside,
        encoding: 'utf8',
        env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(outside) },
        input: JSON.stringify({
          hook_event_name: 'PreToolUse', cwd: outside, tool_name: 'Bash', tool_input: { command: slowCommand },
        }),
      });
      expect(executed.status, executed.stderr).toBe(0);
      expect(executed.stdout).toBe('');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
