import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  installShortcut, parseShortcutArgs, removeShortcut, rexCommandDir, rexConfigFile, shortcutModule, withoutRequire, withRequire,
} from './terminal-shortcut';

const self = ['/usr/bin/node', '/opt/o8 app/o8.mjs'];
const LINE = 'require("o8") -- added by `o8 terminal shortcut`';
const dirs: string[] = [];

function configDir(): { env: Record<string, string>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'o8-rex-shortcut-'));
  dirs.push(dir);
  return { env: { REX_CONFIG: join(dir, 'init.lua') }, dir };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('terminal shortcut arguments', () => {
  it('takes no flags, one key, or --remove', () => {
    expect(parseShortcutArgs([])).toEqual({ key: null, remove: false });
    expect(parseShortcutArgs(['--key', 'cmd+shift+o'])).toEqual({ key: 'cmd+shift+o', remove: false });
    expect(parseShortcutArgs(['--key', 'ctrl+b>o'])).toEqual({ key: 'ctrl+b>o', remove: false });
    expect(parseShortcutArgs(['--remove'])).toEqual({ key: null, remove: true });
  });

  it('refuses a key that could break out of a Lua string, and any other shape', () => {
    for (const rest of [['--key'], ['--key', 'a"b'], ['--key', 'a\\b'], ['--key', 'a b'], ['--key', ''],
      ['--remove', '--key', 'a'], ['--key', 'a', '--remove'], ['--other']]) {
      expect(() => parseShortcutArgs(rest)).toThrow(/terminal shortcut/);
    }
  });
});

describe('where Rex keeps its config', () => {
  it('follows REX_CONFIG, then XDG_CONFIG_HOME, then the home directory', () => {
    expect(rexConfigFile({ REX_CONFIG: '/x/custom.lua' }, 'darwin', '/home/q')).toBe('/x/custom.lua');
    expect(rexConfigFile({ XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/q')).toBe(join('/cfg', 'rex', 'init.lua'));
    expect(rexConfigFile({}, 'darwin', '/home/q')).toBe(join('/home/q', '.config', 'rex', 'init.lua'));
    expect(rexConfigFile({ APPDATA: 'C:\\Roaming' }, 'win32', 'C:\\Users\\q')).toBe(join('C:\\Roaming', 'rex', 'init.lua'));
  });
});

describe('the action file', () => {
  it('runs this CLI for the session the action was called from', () => {
    const lua = shortcutModule(self, null);
    expect(lua).toContain('name = "o8_terminals"');
    expect(lua).toContain('rex.exec({ "/usr/bin/node", "/opt/o8 app/o8.mjs", "--human", "terminal", "panes" }, {');
    expect(lua).toContain('env = { REX_SESSION = ctx.session_id }');
    expect(lua).not.toContain('rex.bind');
  });

  it('puts the directory that holds rex first on the PATH the command gets', () => {
    expect(shortcutModule(self, null, '/Apps/Rex Server/MacOS'))
      .toContain('env = { REX_SESSION = ctx.session_id, PATH = "/Apps/Rex Server/MacOS:" .. (os.getenv("PATH") or "") },');
    const has = (path: string) => path === join('/b', 'rex');
    expect(rexCommandDir({ PATH: '/a:/b:/c' }, has, 'darwin')).toBe('/b');
    expect(rexCommandDir({ PATH: '/a:/c' }, has, 'darwin')).toBeNull();
    expect(rexCommandDir({}, has, 'darwin')).toBeNull();
  });

  it('binds a key only when asked', () => {
    expect(shortcutModule(self, 'cmd+shift+o')).toContain('rex.bind("cmd+shift+o", "o8_terminals")');
  });

  it('escapes quotes and backslashes in the path to o8, and refuses control characters', () => {
    expect(shortcutModule(['C:\\Program Files\\node.exe', 'D:\\o8 "beta"\\o8.mjs'], null))
      .toContain('"C:\\\\Program Files\\\\node.exe", "D:\\\\o8 \\"beta\\"\\\\o8.mjs"');
    expect(() => shortcutModule(['/usr/bin/node', '/opt/o8\n.mjs'], null)).toThrow();
    expect(() => shortcutModule([], null)).toThrow();
    expect(() => shortcutModule(self, 'a"b')).toThrow();
  });
});

describe('the line in init.lua', () => {
  it('is added once, at the end, and leaves every other line alone', () => {
    expect(withRequire('')).toBe(`${LINE}\n`);
    expect(withRequire('rex.bind("cmd+d", "pane.zoom")')).toBe(`rex.bind("cmd+d", "pane.zoom")\n${LINE}\n`);
    const once = withRequire('-- mine\n');
    expect(withRequire(once)).toBe(once);
  });

  it('is removed without touching a require the operator wrote', () => {
    const mine = '-- mine\nrequire("o8")\n';
    expect(withoutRequire(mine)).toBe(mine);
    expect(withoutRequire(`-- mine\n${LINE}\nrequire("keys")\n`)).toBe('-- mine\nrequire("keys")\n');
    expect(withoutRequire(withRequire('-- mine\r\n'))).toBe('-- mine\r\n');
  });
});

describe('installing and removing', () => {
  it('writes the action file, loads it from init.lua, and reloads Rex', () => {
    const { env, dir } = configDir();
    writeFileSync(env.REX_CONFIG, '-- mine\n');
    const calls: string[][] = [];
    const result = installShortcut({ self, key: 'cmd+shift+o', env: { ...env, PATH: '' }, exec: (file, args) => { calls.push([file, ...args]); return ''; } });
    expect(result).toEqual({
      action: 'installed', file: join(dir, 'o8.lua'), config: env.REX_CONFIG, key: 'cmd+shift+o', reloaded: true, hint: null,
    });
    expect(calls).toEqual([['rex', 'config', 'reload']]);
    expect(readFileSync(env.REX_CONFIG, 'utf8')).toBe(`-- mine\n${LINE}\n`);
    expect(readFileSync(join(dir, 'o8.lua'), 'utf8')).toContain('rex.bind("cmd+shift+o", "o8_terminals")');
  });

  it('creates init.lua when there is none, and updates the file on a second run without a second line', () => {
    const { env, dir } = configDir();
    installShortcut({ self, key: 'cmd+shift+o', env, exec: () => '' });
    installShortcut({ self, key: null, env, exec: () => '' });
    expect(readFileSync(env.REX_CONFIG, 'utf8')).toBe(`${LINE}\n`);
    expect(readFileSync(join(dir, 'o8.lua'), 'utf8')).not.toContain('rex.bind');
  });

  it('still installs when Rex cannot be reloaded, and says what to run', () => {
    const { env } = configDir();
    const result = installShortcut({ self, key: null, env, exec: () => { throw new Error('no rex'); } });
    expect(result.action).toBe('installed');
    expect(result.reloaded).toBe(false);
    expect(result.hint).toContain('rex config reload');
  });

  it('removes only what it added, and reports when there was nothing to remove', () => {
    const { env, dir } = configDir();
    writeFileSync(env.REX_CONFIG, '-- mine\n');
    expect(removeShortcut({ env, exec: () => '' }).action).toBe('absent');
    installShortcut({ self, key: null, env, exec: () => '' });
    const calls: string[][] = [];
    expect(removeShortcut({ env, exec: (file, args) => { calls.push([file, ...args]); return ''; } }).action).toBe('removed');
    expect(calls).toEqual([['rex', 'config', 'reload']]);
    expect(readFileSync(env.REX_CONFIG, 'utf8')).toBe('-- mine\n');
    expect(existsSync(join(dir, 'o8.lua'))).toBe(false);
  });
});
