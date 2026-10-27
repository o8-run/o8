import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// @ts-expect-error -- native launch instrumentation is plain JavaScript.
import { requireDisposableRunner } from '../scripts/bench/native-launch.mjs';

let root = '';
let platform: PropertyDescriptor | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'o8-local-launch-'));
  platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  vi.stubEnv('GITHUB_ACTIONS', '');
  vi.stubEnv('RUNNER_ENVIRONMENT', '');
});
afterEach(() => {
  if (platform) Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('accepts an explicitly scoped disposable Mac root without hosted-runner flags', () => {
  const app = join(root, 'artifact', 'o8.app');
  mkdirSync(app, { recursive: true });
  expect(() => requireDisposableRunner(app, { disposableRoot: root,
    readIdentifier: () => 'ai.o8.desktop.launchbench' })).not.toThrow();
});

it('refuses an app outside the explicitly scoped disposable Mac root', () => {
  const allowed = join(root, 'allowed');
  const app = join(root, 'outside', 'o8.app');
  mkdirSync(allowed); mkdirSync(app, { recursive: true });
  expect(() => requireDisposableRunner(app, { disposableRoot: allowed,
    readIdentifier: () => 'ai.o8.desktop.launchbench' })).toThrow('workspace artifact');
});
