/**
 * Sets up the Rex "Show o8 Terminals" shortcut on its own, the first time a
 * person runs o8 inside Rex, so nothing has to be run after installing or
 * updating o8.
 *
 * It only adds what `o8 terminal shortcut` adds, never binds a key, and never
 * touches an `o8.lua` it did not write. The action starts the `o8` command
 * found on PATH, so an update that replaces o8 in place keeps it working.
 * `o8 terminal shortcut --remove` takes it out and is remembered, and
 * `O8_REX_SHORTCUT=0` turns this off.
 */

import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

import { resolveCliDataDir } from './config.js';
import { installShortcut, rexConfigFile, type ShortcutExec } from './commands/terminal-shortcut.js';

const DECLINED_FILE = 'rex-shortcut-removed';
const MODULE_FILE = 'o8.lua';
const UNSAFE_WORD = /[\x00-\x1f\x7f]/;

export interface AutoShortcutInput {
  env: Readonly<Record<string, string | undefined>>;
  /** The command being run, such as `['terminal', 'shortcut']`. */
  command: string[];
  /** Whether a person is at the terminal: stdin and stdout are both terminals. */
  interactive: boolean;
  dataDir: string;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  /** Whether a path is a file the shell would run. */
  runnable?: (path: string) => boolean;
}

/** Where o8 remembers that the operator removed the shortcut. */
export function declinedMarker(dataDir: string): string {
  return join(dataDir, DECLINED_FILE);
}

/** The `o8` command on PATH, as an absolute path, or null. */
export function o8OnPath(
  env: Readonly<Record<string, string | undefined>>,
  runnable: (path: string) => boolean = isRunnableFile,
): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir) || UNSAFE_WORD.test(dir)) continue;
    const candidate = join(dir, 'o8');
    if (runnable(candidate)) return candidate;
  }
  return null;
}

/** A file the shell would run: a regular file this user may execute. */
function isRunnableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The command the shortcut should start, when it should be set up now, or
 * null. Every check is a variable or a file lookup, so a command that does not
 * qualify pays almost nothing.
 */
export function autoShortcutCommand(input: AutoShortcutInput): string | null {
  const { env } = input;
  const exists = input.exists ?? existsSync;
  if (!env.REX_SESSION?.trim() || env.O8_REX_SHORTCUT?.trim() === '0') return null;
  // A worker runs o8 for its own work. Only a person at a terminal gets the shortcut.
  if (env.O8_WORKER_TOKEN?.trim() || !input.interactive) return null;
  // The shortcut command manages the shortcut itself.
  if (input.command[0] === 'terminal' && input.command[1] === 'shortcut') return null;
  // Rex on Windows is not supported here yet; `o8` there is a .cmd file.
  if ((input.platform ?? process.platform) === 'win32') return null;
  if (exists(declinedMarker(input.dataDir))) return null;
  // Present means it is installed already, or is the operator's own file. Either way, leave it.
  if (exists(join(dirname(rexConfigFile(env, input.platform)), MODULE_FILE))) return null;
  return o8OnPath(env, input.runnable);
}

/**
 * Set the shortcut up when `autoShortcutCommand` says so, and say so on stderr.
 * Never fails the command the person ran: any problem leaves Rex as it was.
 */
export function maybeSetUpRexShortcut(
  command: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    exec?: ShortcutExec;
    say?: (line: string) => void;
    interactive?: boolean;
    dataDir?: string;
  } = {},
): void {
  try {
    const env = options.env ?? process.env;
    const o8 = autoShortcutCommand({
      env,
      command,
      interactive: options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
      dataDir: options.dataDir ?? resolveCliDataDir(),
    });
    if (!o8) return;
    // A Rex server that does not answer must not hold up the command for long.
    const exec = options.exec ?? ((file: string, args: string[]) => execFileSync(file, args, {
      encoding: 'utf8', timeout: 3_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const result = installShortcut({ self: [o8], key: null, env, exec });
    if (result.action !== 'installed') return;
    const say = options.say ?? ((line: string) => { if (process.stderr.isTTY) process.stderr.write(`${line}\n`); });
    say(result.reloaded
      ? 'Added "Show o8 Terminals" to the Rex command palette. `o8 terminal shortcut --remove` takes it out.'
      : 'Added "Show o8 Terminals" to Rex; it appears in the command palette once Rex reloads its config. `o8 terminal shortcut --remove` takes it out.');
  } catch {
    // Setting up a convenience must never stand in the way of the command itself.
  }
}

/** Remember that the operator removed the shortcut, so it is not set up again. */
export function rememberRemoved(dataDir: string = resolveCliDataDir()): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(declinedMarker(dataDir), 'Removed with `o8 terminal shortcut --remove`. Delete this file to let o8 add it again.\n');
  } catch {
    // Without the note, o8 may add the shortcut again the next time it runs inside Rex.
  }
}

/** Forget a removal: the operator asked for the shortcut again. */
export function forgetRemoved(dataDir: string = resolveCliDataDir()): void {
  try {
    rmSync(declinedMarker(dataDir), { force: true });
  } catch {
    // A note that cannot be removed only keeps o8 from adding the shortcut on its own.
  }
}
