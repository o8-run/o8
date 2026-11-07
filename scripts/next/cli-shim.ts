/** Test-only stand-ins for the provider CLIs a fixture shell can launch. A
 * Terminal View resume line (`exec codex resume …`) typed into a fixture shell
 * must never reach a real CLI on the machine. The shells get a home of their
 * own, so the machine's rc files cannot put a real CLI back on PATH, and these
 * stubs come first on PATH. Only the fixture's `--cli-shim` flag uses this;
 * production shells keep the login environment. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CliShim { bin: string; home: string }

export const SHIMMED_CLIS = ['codex', 'claude'] as const;

/** Each stub says what it was asked to run and ends on Ctrl-C. The Claude
 * stand-in also records each line typed into it in its session file, as the
 * real CLI does, so Terminal View's import reads a real turn. */
function stub(name: string) {
  if (name !== 'claude') return `#!/bin/sh\necho "fixture ${name} stand-in: $*"\nexec cat >/dev/null\n`;
  return [
    '#!/bin/sh',
    'echo "fixture claude stand-in: $*"',
    'session=""; [ "$1" = "--resume" ] && session="$2"',
    'file="${CLAUDE_HOME:-$HOME/.claude}/projects/fixture/$session.jsonl"',
    'while IFS= read -r line; do',
    '  if [ -n "$session" ]; then',
    '    mkdir -p "$(dirname "$file")"',
    '    printf \'{"type":"user","message":{"role":"user","content":"%s"}}\\n\' "$line" >> "$file"',
    '    printf \'{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"stand-in reply"}]}}\\n\' >> "$file"',
    '  fi',
    '  echo "stand-in reply"',
    'done',
    '',
  ].join('\n');
}

export function prepareCliShim(dataDir: string): CliShim {
  const bin = join(dataDir, 'cli-shim', 'bin');
  const home = join(dataDir, 'cli-shim', 'home');
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const name of SHIMMED_CLIS) writeFileSync(join(bin, name), stub(name), { mode: 0o755 });
  // Login and interactive startup files of zsh and bash, each putting the
  // stubs first again after any system profile reordered PATH.
  const first = `export PATH='${bin.replaceAll("'", "'\\''")}':"$PATH"\n`;
  for (const rc of ['.zshenv', '.zprofile', '.zshrc', '.profile', '.bash_profile', '.bashrc']) {
    writeFileSync(join(home, rc), first);
  }
  return { bin, home };
}

/** The terminal server's environment with the shim in force. */
export function cliShimEnvironment(shim: CliShim, path = process.env.PATH ?? '') {
  return { HOME: shim.home, PATH: `${shim.bin}:${path}` };
}
