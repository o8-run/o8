import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  autoShortcutCommand, declinedMarker, forgetRemoved, maybeSetUpRexShortcut, o8OnPath, rememberRemoved,
} from './rex-auto-shortcut';

let root: string;
let config: string;
let data: string;
let bin: string;
let env: Record<string, string>;
const reloads: string[][] = [];
const exec = (file: string, args: string[]) => { reloads.push([file, ...args]); return ''; };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'o8-rex-auto-'));
  config = join(root, 'config');
  data = join(root, 'data');
  bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'o8'), '#!/bin/sh\n');
  chmodSync(join(bin, 'o8'), 0o755);
  env = { REX_SESSION: 'session:abc', XDG_CONFIG_HOME: config, PATH: `/nowhere:${bin}` };
  reloads.length = 0;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const base = () => ({ env, command: ['mission', 'status'], interactive: true, dataDir: data, platform: 'linux' as const });

describe('when o8 sets up the Rex shortcut on its own', () => {
  it('does it for a person running o8 inside Rex, with the o8 on PATH', () => {
    expect(autoShortcutCommand(base())).toBe(join(bin, 'o8'));
  });

  it('does not outside Rex, when turned off, for a worker, or without a person at the terminal', () => {
    expect(autoShortcutCommand({ ...base(), env: { ...env, REX_SESSION: '' } })).toBeNull();
    expect(autoShortcutCommand({ ...base(), env: { ...env, O8_REX_SHORTCUT: '0' } })).toBeNull();
    expect(autoShortcutCommand({ ...base(), env: { ...env, O8_WORKER_TOKEN: 't' } })).toBeNull();
    expect(autoShortcutCommand({ ...base(), interactive: false })).toBeNull();
  });

  it('leaves the shortcut command to itself, and skips Windows', () => {
    expect(autoShortcutCommand({ ...base(), command: ['terminal', 'shortcut'] })).toBeNull();
    expect(autoShortcutCommand({ ...base(), platform: 'win32' })).toBeNull();
  });

  it('does not when o8 is not on PATH, or a relative PATH entry is the only match', () => {
    expect(autoShortcutCommand({ ...base(), env: { ...env, PATH: '/nowhere' } })).toBeNull();
    expect(o8OnPath({ PATH: 'bin:.' }, () => true)).toBeNull();
  });

  it('does not after the operator removed it, until they ask for it again', () => {
    rememberRemoved(data);
    expect(existsSync(declinedMarker(data))).toBe(true);
    expect(autoShortcutCommand(base())).toBeNull();
    forgetRemoved(data);
    expect(autoShortcutCommand(base())).toBe(join(bin, 'o8'));
  });

  it('does not when an o8.lua is already there, whoever wrote it', () => {
    mkdirSync(join(config, 'rex'), { recursive: true });
    writeFileSync(join(config, 'rex', 'o8.lua'), '-- my own\n');
    expect(autoShortcutCommand(base())).toBeNull();
  });
});

describe('setting the shortcut up', () => {
  it('writes the action for the o8 on PATH, binds no key, reloads Rex, and says so once', () => {
    const said: string[] = [];
    maybeSetUpRexShortcut(['mission', 'status'], { env, exec, interactive: true, dataDir: data, say: (line) => said.push(line) });
    const lua = readFileSync(join(config, 'rex', 'o8.lua'), 'utf8');
    expect(lua).toContain(`"--", "${join(bin, 'o8')}", "--human", "terminal", "panes", "--watch", "--here"`);
    expect(lua).not.toContain('rex.bind');
    expect(readFileSync(join(config, 'rex', 'init.lua'), 'utf8')).toContain('require("o8")');
    expect(reloads).toEqual([['rex', 'config', 'reload']]);
    expect(said).toEqual(['Added "Show o8 Terminals" to the Rex command palette. `o8 terminal shortcut --remove` takes it out.']);
    // The next command finds it in place and does nothing.
    maybeSetUpRexShortcut(['mission', 'status'], { env, exec, interactive: true, dataDir: data, say: (line) => said.push(line) });
    expect(said).toHaveLength(1);
  });

  it('never fails the command when the Rex config cannot be written', () => {
    writeFileSync(config, 'a file where the config folder should be');
    expect(() => maybeSetUpRexShortcut(['mission', 'status'], { env, exec, interactive: true, dataDir: data, say: () => undefined })).not.toThrow();
  });
});
