/**
 * `o8 terminal shortcut` — add a "Show o8 Terminals" action to Rex, so the
 * terminals tab is one command palette entry, or one key, away.
 *
 * Rex reads one Lua file, `init.lua`. This command writes its action to a file
 * of its own beside it, `o8.lua`, and adds a single `require("o8")` line to
 * `init.lua`. Nothing else in `init.lua` is touched, and `--remove` deletes
 * the file and takes that one line back out.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { CliError, EXIT } from '../api.js';

export const SHORTCUT_ACTION = 'o8_terminals';
const MODULE_FILE = 'o8.lua';
const REQUIRE_LINE = 'require("o8") -- added by `o8 terminal shortcut`';
/** A Rex key such as `cmd+shift+o` or `ctrl+b>o`. It is written into a Lua string. */
const SAFE_KEY = /^[A-Za-z0-9+>,.;=\/\[\]-]{1,48}$/;
const UNSAFE_WORD = /[\x00-\x1f\x7f]/;
const USAGE = 'Use `terminal shortcut [--key <key>]` or `terminal shortcut --remove`.';

export interface ShortcutArgs { key: string | null; remove: boolean }

/** Parse `terminal shortcut` flags. */
export function parseShortcutArgs(rest: string[]): ShortcutArgs {
  if (rest.length === 0) return { key: null, remove: false };
  if (rest.length === 1 && rest[0] === '--remove') return { key: null, remove: true };
  if (rest.length === 2 && rest[0] === '--key' && SAFE_KEY.test(rest[1])) return { key: rest[1], remove: false };
  throw new CliError('invalid_args', USAGE, EXIT.INVALID_ARGS);
}

/** Where Rex reads `init.lua` from, following the rules in Rex's own documentation. */
export function rexConfigFile(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.REX_CONFIG) return env.REX_CONFIG;
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'rex', 'init.lua');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'rex', 'init.lua');
}

function luaString(word: string): string {
  return `"${word.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The directory that holds the `rex` command, found on the caller's PATH. The
 * Rex server runs the action with its own PATH, which may not include it.
 */
export function rexCommandDir(
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const name = platform === 'win32' ? 'rex.exe' : 'rex';
  for (const dir of (env.PATH ?? '').split(platform === 'win32' ? ';' : ':')) {
    if (dir && !UNSAFE_WORD.test(dir) && exists(join(dir, name))) return dir;
  }
  return null;
}

/**
 * The Lua file that defines the action. `self` is the command that starts this
 * CLI. The action runs it with the session the action was called from, so the
 * tab opens where the operator is looking. `rexDir` is put first on the
 * command's PATH so o8 can call `rex` back.
 */
export function shortcutModule(self: string[], key: string | null, rexDir: string | null = null): string {
  if (self.length === 0 || self.some((word) => !word || UNSAFE_WORD.test(word))) {
    throw new CliError('invalid_args', 'Could not work out how to start o8 from Rex.', EXIT.INVALID_ARGS);
  }
  if (key !== null && !SAFE_KEY.test(key)) throw new CliError('invalid_args', USAGE, EXIT.INVALID_ARGS);
  const argv = [...self, '--human', 'terminal', 'panes'].map(luaString).join(', ');
  return [
    '-- Written by `o8 terminal shortcut`. Run it again to update this file,',
    '-- or `o8 terminal shortcut --remove` to delete it. Edits here are overwritten.',
    'rex.action{',
    `  name = "${SHORTCUT_ACTION}",`,
    '  title = "Show o8 Terminals",',
    '  description = "Open a read-only pane for each running o8 worker and shell.",',
    '  category = "o8",',
    '  keywords = "o8 workers agents terminals panes",',
    '  run = function(ctx)',
    '    if ctx.session_id == nil then error("Run this from a Rex session.", 0) end',
    `    local result, err = rex.exec({ ${argv} }, {`,
    rexDir
      ? `      env = { REX_SESSION = ctx.session_id, PATH = ${luaString(rexDir + delimiter)} .. (os.getenv("PATH") or "") },`
      : '      env = { REX_SESSION = ctx.session_id },',
    '      timeout = 60,',
    '    })',
    '    if result == nil then error(err, 0) end',
    '    local output = result.stdout ~= "" and result.stdout or result.stderr',
    '    if not result.ok then error(output ~= "" and output or "o8 could not open the terminals.", 0) end',
    '    return { output = output }',
    '  end,',
    '}',
    ...(key ? [`rex.bind(${luaString(key)}, "${SHORTCUT_ACTION}")`] : []),
    '',
  ].join('\n');
}

/** `init.lua` with the one line that loads the action, added once at the end. */
export function withRequire(init: string): string {
  if (init.split(/\r?\n/).some((line) => line.trim() === REQUIRE_LINE)) return init;
  const body = init.length === 0 || init.endsWith('\n') ? init : `${init}\n`;
  return `${body}${REQUIRE_LINE}\n`;
}

/** `init.lua` without that line. Every other line is kept as written. */
export function withoutRequire(init: string): string {
  const lines = init.split('\n');
  const kept = lines.filter((line) => line.replace(/\r$/, '').trim() !== REQUIRE_LINE);
  return kept.length === lines.length ? init : kept.join('\n');
}

export interface ShortcutResult {
  action: 'installed' | 'removed' | 'absent';
  /** The file that holds the action. */
  file: string;
  /** Rex's own config file, which loads it. */
  config: string;
  key: string | null;
  /** False when Rex could not be told to read its config again. */
  reloaded: boolean;
  /** What to do next when the reload did not happen. */
  hint: string | null;
}

export type ShortcutExec = (file: string, args: string[]) => string;

function defaultExec(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function reload(exec: ShortcutExec): Pick<ShortcutResult, 'reloaded' | 'hint'> {
  try {
    exec('rex', ['config', 'reload']);
    return { reloaded: true, hint: null };
  } catch {
    return { reloaded: false, hint: 'Run `rex config reload` on this machine to apply the change.' };
  }
}

/** Write the action file, load it from `init.lua`, and ask Rex to read its config again. */
export function installShortcut(input: {
  self: string[];
  key: string | null;
  env: Readonly<Record<string, string | undefined>>;
  exec?: ShortcutExec;
}): ShortcutResult {
  const config = rexConfigFile(input.env);
  const file = join(dirname(config), MODULE_FILE);
  const module = shortcutModule(input.self, input.key, rexCommandDir(input.env));
  const exec = input.exec ?? defaultExec;
  try {
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(file, module);
    const init = existsSync(config) ? readFileSync(config, 'utf8') : '';
    const next = withRequire(init);
    if (next !== init) writeFileSync(config, next);
  } catch {
    throw new CliError('config_unwritable', `Could not write the Rex config in ${dirname(config)}.`, EXIT.CONFLICT);
  }
  return { action: 'installed', file, config, key: input.key, ...reload(exec) };
}

/** Delete the action file and take its line out of `init.lua`. */
export function removeShortcut(input: {
  env: Readonly<Record<string, string | undefined>>;
  exec?: ShortcutExec;
}): ShortcutResult {
  const config = rexConfigFile(input.env);
  const file = join(dirname(config), MODULE_FILE);
  const exec = input.exec ?? defaultExec;
  let changed = false;
  try {
    if (existsSync(config)) {
      const init = readFileSync(config, 'utf8');
      const next = withoutRequire(init);
      if (next !== init) { writeFileSync(config, next); changed = true; }
    }
    if (existsSync(file)) { rmSync(file); changed = true; }
  } catch {
    throw new CliError('config_unwritable', `Could not change the Rex config in ${dirname(config)}.`, EXIT.CONFLICT);
  }
  if (!changed) return { action: 'absent', file, config, key: null, reloaded: false, hint: null };
  return { action: 'removed', file, config, key: null, ...reload(exec) };
}
