import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFile } from '@/lib/providers/child-process';
import { pickNativePath } from '@/lib/desktop/native-picker';

const run = promisify(execFile);
const displayNames = ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];
let root: string;
let bin: string;
let capture: string;
let baseline: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'o8-native-picker-display-'));
  bin = join(root, 'bin'); mkdirSync(bin);
  capture = join(root, 'picker.json'); baseline = join(root, 'baseline.json');
  vi.stubEnv('PATH', bin + delimiter + process.env.PATH);
  vi.stubEnv('DISPLAY', ':8877');
  vi.stubEnv('XAUTHORITY', join(root, 'non-default.Xauthority'));
  vi.stubEnv('WAYLAND_DISPLAY', 'wayland-o8-fixture');
  vi.stubEnv('XDG_RUNTIME_DIR', join(root, 'runtime'));
  vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', `unix:path=${join(root, 'bus')}`);
  vi.stubEnv('O8_PICKER_UNRELATED_INPUT', 'must-stay-in-parent');
  vi.stubEnv('O8_WORKER_ENV_INHERIT', undefined);
  vi.stubEnv('O8_WORKER_ENV_ALLOW', undefined);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function program(path: string, target: string, picker: boolean) {
  writeFileSync(path, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(target)}, JSON.stringify({
  display: Object.fromEntries(${JSON.stringify(displayNames)}.map(name => [name, process.env[name] ?? null])),
  unrelated: process.env.O8_PICKER_UNRELATED_INPUT ?? null, names: Object.keys(process.env).sort(),
}));
${picker ? `if (!process.env.DISPLAY) { process.stderr.write('Gtk-WARNING **: cannot open display\\n'); process.exit(1); }
process.stdout.write('/tmp/selected\\n');` : ''}
`, { mode: 0o755 });
}

it.skipIf(process.platform !== 'linux').each(['zenity', 'kdialog'])('passes only the picker display additions to %s through the real process wrapper', async command => {
  const control = join(bin, 'control.cjs'); program(control, baseline, false);
  if (command === 'kdialog') writeFileSync(join(bin, 'zenity'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  program(join(bin, command), capture, true);
  await run(process.execPath, [control]);
  const expectedBase = JSON.parse(readFileSync(baseline, 'utf8')) as { names: string[] };
  await expect(pickNativePath('folder', 'Pick')).resolves.toEqual({ path: '/tmp/selected' });
  const observed = JSON.parse(readFileSync(capture, 'utf8')) as { display: Record<string, string>; unrelated: string | null; names: string[] };
  expect(observed.display).toEqual(Object.fromEntries(displayNames.map(name => [name, process.env[name]])));
  expect(observed.unrelated).toBeNull();
  expect(observed.names).toEqual([...new Set([...expectedBase.names, ...displayNames])].sort());
});
