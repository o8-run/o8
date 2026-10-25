/**
 * PTY / tmux / shell support helpers for the ws-server terminal subsystem.
 *
 * Pure helpers (process.env + node builtins only — no shared ws-server state)
 * extracted from the ws-server monolith so both the entry process and the
 * forked terminal-host (O8_TERMINAL_HOST=child) share one implementation of
 * shell/tmux resolution. Faithful move — no behavior change.
 */

import { existsSync } from 'node:fs';
import { execSync, execFileSync } from '@/lib/providers/child-process';
import { workerParentEnvironment } from '@/lib/providers/worker-environment';

/** Allowlisted PTY ambient inputs, with terminal defaults and no parent terminal identity. */
export function sanitizePtyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(workerParentEnvironment(process.env))) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  env.TERM = 'xterm-256color';
  // The panel is o8's xterm.js, not the terminal that started the server.
  delete env.TERM_PROGRAM;
  delete env.TERM_PROGRAM_VERSION;
  env.LANG = env.LANG || 'en_US.UTF-8';
  env.LC_ALL = env.LC_ALL || 'en_US.UTF-8';
  env.PATH = env.PATH || '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  return env;
}

export function resolvePreferredShell(): string {
  const candidates = [
    process.env.SHELL,
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh',
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return '/bin/sh';
}

export function resolveTmuxBinary(): string {
  const candidates = [
    process.env.TMUX_BIN,
    '/opt/homebrew/bin/tmux',
    '/usr/local/bin/tmux',
    '/usr/bin/tmux',
    '/bin/tmux',
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  try {
    return execSync('command -v tmux', {
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 3000,
      env: sanitizePtyEnv() as NodeJS.ProcessEnv,
    }).trim() || 'tmux';
  } catch {
    return 'tmux';
  }
}

export function tmuxSessionExists(sessionName: string, serverArgs: readonly string[] = []): boolean {
  const target = sessionName.trim();
  if (!target) return false;

  try {
    execFileSync(resolveTmuxBinary(), [...serverArgs, 'has-session', '-t', target], {
      windowsHide: true,
      timeout: 2000,
      stdio: 'ignore',
      env: sanitizePtyEnv() as NodeJS.ProcessEnv,
    });
    return true;
  } catch {
    return false;
  }
}

export function isDashTerminalSession(sessionName: string): boolean {
  return sessionName.startsWith('cortex-dash-');
}
