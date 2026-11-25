import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { forgetLocalMachineName, readChosenMachineName } from '@/lib/mobile/machine-name';

const MAX_LABEL = 80;

/** A generic name for this kind of computer; it never comes from the system. */
export function defaultMachineLabel(platform: string = process.platform): string {
  if (platform === 'darwin') return 'Mac';
  if (platform === 'win32') return 'Windows PC';
  if (platform === 'linux') return 'Linux computer';
  return 'Computer';
}

/** A label the user typed: one line, no control characters, at most 80 characters. */
export function normalizeMachineLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = (value.split(/\r?\n/)[0] ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_LABEL).trim();
  return label || null;
}

/**
 * The name this computer has in the account's machine list: the label the user
 * chose, or a generic name. The system host name is never sent.
 */
export function accountMachineLabel(platform: string = process.platform): string {
  return readChosenMachineName() ?? defaultMachineLabel(platform);
}

/** Saves the user's label (the same `computer-name` file paired phones show). */
export function saveMachineLabel(label: string, dataDir: string = getDataDir()): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dataDir, 'computer-name'), `${label}\n`, { mode: 0o600 });
  forgetLocalMachineName();
}
