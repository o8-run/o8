import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildCliBundle } from './fixtures/cli-bundle';

const root = mkdtempSync(join(tmpdir(), 'o8-rex-auto-real-'));
const cli = join(root, 'o8.mjs');
const bin = join(root, 'bin');
const config = join(root, 'config');
const data = join(root, 'data');
const rexLog = join(root, 'rex.log');
const action = join(config, 'rex', 'o8.lua');
const marker = join(data, 'rex-shortcut-removed');

function env(): NodeJS.ProcessEnv {
  // A clean environment of its own, so nothing from the test runner reaches the CLI.
  return {
    NODE_ENV: 'test',
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: root,
    REX_SESSION: 'session:test',
    XDG_CONFIG_HOME: config,
    O8_DATA_DIR: data,
    // Nothing listens here, so a command that needs o8 fails fast after the setup ran.
    O8_API_PORT: '9',
    O8_WS_PORT: '9',
  };
}

function o8(args: string[]): { status: number | null; stdout: string } {
  const run = spawnSync(process.execPath, [cli, ...args], { env: env(), encoding: 'utf8', timeout: 30_000 });
  return { status: run.status, stdout: run.stdout };
}

/** Runs the CLI with a terminal on stdin and stdout, as a person in a Rex pane would. */
function o8AtTerminal(args: string[]): void {
  const command = [process.execPath, cli, ...args].map((word) => `'${word.replace(/'/g, `'\\''`)}'`).join(' ');
  const argv = process.platform === 'darwin'
    ? ['-q', '/dev/null', '/bin/sh', '-c', command]
    : ['-qec', command, '/dev/null'];
  spawnSync('script', argv, { env: env(), encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

const hasScript = (() => {
  try { execFileSync('sh', ['-c', 'command -v script'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

beforeAll(async () => {
  await buildCliBundle(cli);
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'rex'), `#!/bin/sh\necho "$@" >> '${rexLog}'\n`);
  writeFileSync(join(bin, 'o8'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'rex'), 0o755);
  chmodSync(join(bin, 'o8'), 0o755);
}, 120_000);

beforeEach(() => {
  rmSync(config, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
  rmSync(rexLog, { force: true });
  mkdirSync(data, { recursive: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the Rex shortcut through the o8 command', () => {
  it('remembers a removal, and forgets it when the shortcut is asked for again', () => {
    expect(o8(['terminal', 'shortcut']).status).toBe(0);
    expect(existsSync(action)).toBe(true);
    expect(o8(['terminal', 'shortcut', '--remove']).status).toBe(0);
    expect(existsSync(action)).toBe(false);
    expect(existsSync(marker)).toBe(true);
    expect(o8(['terminal', 'shortcut']).status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('adds nothing without a person at the terminal', () => {
    o8(['terminal', 'list']);
    expect(existsSync(action)).toBe(false);
  });

  it.skipIf(!hasScript || !['linux', 'darwin'].includes(process.platform))(
    'adds the shortcut on the first command a person runs in Rex, for the o8 on PATH, and not after a removal',
    () => {
      o8AtTerminal(['--human', 'terminal', 'list']);
      expect(readFileSync(action, 'utf8')).toContain(`"--", "${join(bin, 'o8')}", "--human", "terminal", "panes"`);
      expect(readFileSync(join(config, 'rex', 'init.lua'), 'utf8')).toContain('require("o8")');
      expect(readFileSync(rexLog, 'utf8')).toContain('config reload');

      o8(['terminal', 'shortcut', '--remove']);
      o8AtTerminal(['--human', 'terminal', 'list']);
      expect(existsSync(action)).toBe(false);

      // Help never sets anything up.
      rmSync(marker);
      o8AtTerminal(['--help']);
      expect(existsSync(action)).toBe(false);
    },
    60_000,
  );
});
