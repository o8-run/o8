import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';

export const REQUIRED_SAFETY_HOOKS = [
  'claude-code-pretool-hook.js',
  'post-edit-typecheck.js',
  'completion-gate.js',
  'time-ledger.js',
];

export function exportTauriSafetyHookResources(projectRoot, serverRoot) {
  const sourceRoot = join(projectRoot, 'dist', 'hooks');
  const destinationRoot = join(serverRoot, 'hooks');
  mkdirSync(destinationRoot, { recursive: true });
  for (const hookName of REQUIRED_SAFETY_HOOKS) {
    const source = join(sourceRoot, hookName);
    if (!existsSync(source)) {
      throw new Error(`Missing required safety hook: ${source}`);
    }
    const sourceEntry = lstatSync(source);
    if (!sourceEntry.isFile() || sourceEntry.isSymbolicLink()) {
      throw new Error(`Safety hook source is not an exact file: ${source}`);
    }
    const destination = join(destinationRoot, hookName);
    copyFileSync(source, destination);
    chmodSync(destination, 0o755);
    const destinationEntry = lstatSync(destination);
    if (!destinationEntry.isFile() || destinationEntry.isSymbolicLink()) {
      throw new Error(`Safety hook export is not an exact file: ${destination}`);
    }
  }
  return destinationRoot;
}
