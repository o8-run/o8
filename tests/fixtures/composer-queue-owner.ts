import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, afterAll } from 'vitest';
import { startComposerOwner, type ComposerOwner } from '../../scripts/next/composer-owner';

export const COMPOSER_BINARY_SKIP = 'SKIP composer owner proofs: set O8D_TEST_BINARY to an already-built compatible o8d. No build is started.';
let suspend: (() => void) | undefined;
let resume: (() => Promise<void>) | undefined;
let restart: (() => Promise<void>) | undefined;
let childEnvironment: Record<string, string> | undefined;
export async function restartComposerOwnerFixture(): Promise<void> {
  if (!restart) throw Error('A native composer owner fixture is required.');
  await restart();
}
/** Child fixtures model the executor; the parent becomes a classic read/relay client. */
export async function withFixtureComposerExecutor<T>(run: () => Promise<T>): Promise<T> {
  if (!suspend || !resume) throw Error('A native composer owner fixture is required.');
  suspend();
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(childEnvironment ?? {})) { previous.set(name, process.env[name]); process.env[name] = value; }
  try { return await run(); } finally {
    for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await resume();
  }
}
export async function recoverComposerOwner(): Promise<void> {
  await withFixtureComposerExecutor(() => promisify(execFile)(process.execPath,
    ['--import=tsx', '--import=./scripts/register-server-only-stub.mjs', resolve('tests/fixtures/composer-queue-recover.mts')],
    { cwd: process.cwd(), env: process.env, timeout: 15000 }).then(() => undefined));
}
/** Legacy test assertions now call the real daemon, never a substitute TS row writer. */
export function installComposerOwnerFixture(): void {
  let owner: ComposerOwner | undefined;
  beforeAll(async () => {
    const binary = process.env.O8D_TEST_BINARY;
    if (!binary) { console.info('Native queue test transport requires O8D_TEST_BINARY; no implicit build or TS fallback.'); return; }
    owner = await startComposerOwner(binary);
    childEnvironment = owner.childEnvironment;
    suspend = owner.suspend; resume = owner.resume; restart = owner.restart;
  }, 30000);
  afterAll(async () => {
    suspend = undefined; resume = undefined; restart = undefined; childEnvironment = undefined;
    await owner?.close(); owner = undefined;
  });
}
