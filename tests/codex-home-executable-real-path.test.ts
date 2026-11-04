import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDataDir } from '@/lib/data-dir-migration';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

// Keep configuration preparation and the executable resolver real. Only the
// provider is replaced by an executable that speaks the batch JSON protocol.
vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>();
  const homedir = () => process.env.O8_CODEX_EXEC_TEST_HOME!;
  return { ...os, default: { ...os, homedir }, homedir };
});

const root = mkdtempSync(join(getDataDir(), 'codex-executable-'));
const home = join(root, 'home');
const runtimeHome = join(root, 'runtime-data');
const userConfig = join(home, '.codex', 'config.toml');
const binary = join(root, 'bin', 'codex');
const log = join(root, 'launch.json');
const repo = join(root, 'repo');
const inheritedPath = process.env.PATH ?? '';
mkdirSync(join(home, '.codex'), { recursive: true });
mkdirSync(runtimeHome);
mkdirSync(join(root, 'bin'));
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/fixture.git'], { cwd: repo });
writeFileSync(userConfig, 'model = "gpt-5.5"\n');
writeFileSync(join(runtimeHome, 'installation_id'), 'fixture-installation');
writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  console.log('codex-cli 0.161.0');
} else {
  fs.writeFileSync(process.env.O8_CODEX_EXEC_TEST_LOG, JSON.stringify({
    argv: process.argv.slice(2), codexHome: process.env.CODEX_HOME,
  }));
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-codex-thread' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fixture reply' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } }));
}
`);
chmodSync(binary, 0o700);
vi.stubEnv('O8_CODEX_EXEC_TEST_HOME', home);
vi.stubEnv('O8_CODEX_EXEC_TEST_LOG', log);
vi.stubEnv('O8_CRASH_SURVIVABLE_ORCHESTRATOR', '0');
// Worker children inherit only allowlisted names; the stand-in CLI reads this test knob.
vi.stubEnv('O8_WORKER_ENV_ALLOW', 'O8_CODEX_EXEC_TEST_LOG');

const { ensureCodexOrchestratorSession, sendToCodexOrchestrator } = await import('@/lib/lane/codex-orchestrator-session');
const { CliNotFoundError, getCachedCli, invalidateCliCache, resolveCli } = await import('@/lib/runtimes/shared/cli-resolver');
const { getOperatorDefaultsSync, updateOperatorDefaults } = await import('@/lib/operator/defaults');

beforeEach(async () => {
  invalidateCliCache('codex');
  rmSync(log, { force: true });
  vi.stubEnv('CODEX_HOME', runtimeHome);
  vi.stubEnv('O8_CODEX_BIN', '');
  vi.stubEnv('PATH', `${join(root, 'bin')}${delimiter}${inheritedPath}`);
  await updateOperatorDefaults({ codexAppThreads: false });
});

afterAll(() => {
  invalidateCliCache('codex');
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function turn(): Promise<OrchestratorEvent[]> {
  const events: OrchestratorEvent[] = [];
  const session = ensureCodexOrchestratorSession(repo);
  await sendToCodexOrchestrator(session, 'fixture prompt', (event) => events.push(event), { model: 'gpt-5.5' });
  expect(session.status).not.toBe('busy');
  return events;
}

describe.skipIf(process.platform === 'win32')('Codex executable discovery through orchestrator send', () => {
  it('uses PATH with a data-directory CODEX_HOME and preserves homes and saved settings', async () => {
    const settings = getOperatorDefaultsSync();
    const events = await turn();
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events).toContainEqual({ type: 'text', text: 'fixture reply' });
    expect(events.at(-1)).toMatchObject({ type: 'done', sessionId: 'fixture-codex-thread', terminalOutcome: 'completed' });
    expect(getCachedCli('codex')).toMatchObject({ path: binary, source: 'which' });
    const launch = JSON.parse(readFileSync(log, 'utf8')) as { argv: string[]; codexHome: string };
    expect(launch.argv.slice(0, 2)).toEqual(['exec', '--json']);
    expect(launch.codexHome).not.toBe(runtimeHome);
    expect(readFileSync(join(launch.codexHome, 'config.toml'), 'utf8')).toContain('model = "gpt-5.5"');
    expect(readFileSync(userConfig, 'utf8')).toBe('model = "gpt-5.5"\n');
    expect(readFileSync(join(runtimeHome, 'installation_id'), 'utf8')).toBe('fixture-installation');
    expect(process.env.CODEX_HOME).toBe(runtimeHome);
    expect(getOperatorDefaultsSync()).toEqual(settings);
  });

  it.each(['directory', 'non-executable file'])('reports an invalid explicit %s override before launch', async (kind) => {
    const override = kind === 'directory' ? runtimeHome : join(root, 'not-executable');
    if (kind !== 'directory') writeFileSync(override, 'fixture data', { mode: 0o600 });
    vi.stubEnv('O8_CODEX_BIN', override);
    const events = await turn();
    expect(events).toContainEqual({
      type: 'error',
      error: 'Failed to resolve Codex binary: Invalid executable override O8_CODEX_BIN: expected an executable file.',
    });
    expect(events.at(-1)?.type).toBe('done');
    expect(existsSync(log)).toBe(false);
    expect(getCachedCli('codex')).toBeUndefined();
  });

  it('keeps the supported executable override, including an executable symlink', async () => {
    const link = join(root, 'codex-link');
    symlinkSync(binary, link);
    vi.stubEnv('O8_CODEX_BIN', link);
    const events = await turn();
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events).toContainEqual({ type: 'text', text: 'fixture reply' });
    expect(getCachedCli('codex')).toMatchObject({ path: link, source: 'env', envHint: 'O8_CODEX_BIN' });
  });

  it('ignores legacy runtime-home override candidates used by background callers', async () => {
    const resolved = await resolveCli({
      runtimeId: 'fixture-background-codex', binaryName: 'codex',
      envOverride: 'O8_CODEX_BIN', extraEnvOverrides: ['CODEX_HOME'],
    });
    expect(resolved).toMatchObject({ path: binary, source: 'which' });
    invalidateCliCache('fixture-background-codex');
  });

  it('does not cache or create a shim for a directory returned by a login shell', async () => {
    const shell = join(root, 'fixture-shell');
    writeFileSync(shell, `#!/usr/bin/env node\nconsole.log(process.env.CODEX_HOME);\n`);
    chmodSync(shell, 0o700);
    vi.stubEnv('SHELL', shell);
    const spec = { runtimeId: 'fixture-directory-cli', binaryName: 'o8-fixture-directory-cli', envOverride: 'O8_FIXTURE_DIRECTORY_BIN' };
    vi.stubEnv('O8_FIXTURE_DIRECTORY_BIN', '');
    await expect(resolveCli(spec)).rejects.toBeInstanceOf(CliNotFoundError);
    expect(getCachedCli(spec.runtimeId)).toBeUndefined();
    expect(existsSync(join(getDataDir(), 'bin', spec.binaryName))).toBe(false);
  });
});
