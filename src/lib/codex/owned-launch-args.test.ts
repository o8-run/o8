import { describe, expect, it } from 'vitest';
import { codexLaunchArgs, codexResumeArgs } from './owned';

describe('codex worker launch args (#1402 isolation)', () => {
  it('workers ignore the user config so inherited MCP servers cannot slow or kill them', () => {
    const args = codexLaunchArgs({ cwd: '/tmp/wt', prompt: 'do the task' });
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('exec');
    expect(args[args.length - 1]).toBe('do the task');
  });
});

describe('codex worker time ledger hook', () => {
  const clockHookCommand = "'/opt/o8 app/node' '/opt/o8 app/hooks/time-ledger.js'";

  it.each([
    ['launch', () => codexLaunchArgs({ cwd: '/tmp/wt', prompt: 'do the task', clockHookCommand })],
    ['resume', () => codexResumeArgs({ threadId: 'thread-1', prompt: 'do the task', clockHookCommand })],
  ] as const)('passes the hook on %s for Bash and session start, before the prompt', (_mode, build) => {
    const args = build();
    const hook = `hooks=[{type="command",command=${JSON.stringify(clockHookCommand)},timeout=20}]`;
    expect(args).toContain('--dangerously-bypass-hook-trust');
    expect(args).toContain('--ignore-user-config');
    expect(args.filter((arg) => arg.startsWith('hooks.'))).toEqual([
      `hooks.PreToolUse=[{matcher="Bash",${hook}}]`,
      `hooks.PostToolUse=[{matcher="Bash",${hook}}]`,
      `hooks.SessionStart=[{${hook}}]`,
    ]);
    expect(args[args.length - 1]).toBe('do the task');
  });

  it('leaves the launch unchanged when the install has no hook runtime', () => {
    const args = codexLaunchArgs({ cwd: '/tmp/wt', prompt: 'do the task' });
    expect(args).not.toContain('--dangerously-bypass-hook-trust');
    expect(args.some((arg) => arg.startsWith('hooks.'))).toBe(false);
  });
});
