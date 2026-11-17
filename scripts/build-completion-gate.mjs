import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function buildCompletionGate() {
  const destination = new URL('../dist/hooks/', import.meta.url);
  mkdirSync(destination, { recursive: true });
  copyFileSync(new URL('./hooks/completion-gate.cjs', import.meta.url),
    fileURLToPath(new URL('completion-gate.js', destination)));
}
