import { terminalToolEnv } from '@/lib/llm/terminal-tool-env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sanitizePtyEnv } from './pty-support';
import { createChildTerminalHost } from './terminal-host-client';

/**
 * o8's terminal panel is xterm.js, whatever terminal started the server. A PTY
 * child must not inherit the server terminal's identity: with TERM_PROGRAM=tern
 * a TSP-aware program would draw for Tern, and the Tern lab's probe gate would
 * send its hello into the panel (#3734). Driven through the real forked
 * terminal host and node-pty, so the env is what the child shell actually sees.
 */
describe('sanitizePtyEnv through a real PTY', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each([{name:'panel', env:sanitizePtyEnv}, {name:'tool', env:() => terminalToolEnv() as Record<string,string>}])('does not pass server identity or ambient hooks to a $name PTY child', async source => {
    vi.stubEnv('TERM_PROGRAM', 'tern');
    vi.stubEnv('TERM_PROGRAM_VERSION', '0.6.2');
    vi.stubEnv('O8_UNAPPROVED_AMBIENT', 'fixture-unapproved');
    vi.stubEnv('NODE_OPTIONS', '--no-warnings');
    vi.stubEnv('BASH_ENV', '/fixture-startup-hook');
    const host = createChildTerminalHost();
    try {
      const handle = host.spawn({
        file: '/bin/sh',
        args: ['-c', 'printf "[%s|%s|%s]" "${TERM_PROGRAM-unset}" "${TERM_PROGRAM_VERSION-unset}" "$TERM"; printf "[%s|%s|%s]" "${O8_UNAPPROVED_AMBIENT-unset}" "${NODE_OPTIONS-unset}" "${BASH_ENV-unset}"'],
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        env: source.env(),
      });
      let buffer = '';
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no exit; buffer=${JSON.stringify(buffer)}`)), 15000);
        handle.onData((d) => { buffer += d; });
        handle.onExit(() => { clearTimeout(timer); resolve(); });
      });
      expect(buffer).toContain('[unset|unset|xterm-256color]');
      expect(buffer).toContain('[unset|unset|unset]');
    } finally {
      host.dispose();
    }
  }, 20000);
});
