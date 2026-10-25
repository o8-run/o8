import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.root, migrateDataDirOnce: () => {} }));
// Device installation is unrelated to the configured MCP attachment under test.
vi.mock('@/lib/devices/tools', () => ({ installedTool: async () => null }));
vi.mock('@/lib/devices/service', () => ({ getDeviceManager: () => ({ root: join(state.root, 'devices') }) }));
state.root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-mcp-command-payer-')));
const root = state.root;
const key = `fixture-${randomUUID()}`;
const symlink = join(root, 'bin', 'claude');
const target = join(root, 'package', 'cli.js');
const wrapped = join(root, 'wrapped', 'claude');
const direct = join(root, 'direct', 'claude');
const { mutateProviderKey } = await import('@/lib/providers/key-store');
const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
const { insertExternalMcpServer, removeExternalMcpServer } = await import('@/lib/mcp/external-servers');
const { prepareOwnedWorkerMcpConfig } = await import('@/lib/runtimes/shared/owned-session/worker-mcp-config');
const { claudeCodeOwnedAdapter } = await import('@/lib/claude-code/owned');
const { childEnvironment } = await import('@/lib/providers/spawn-environment');
const { spawn } = await import('@/lib/providers/child-process');
let serverId: string | undefined;
let fixturePath = '';

beforeAll(() => {
  vi.stubEnv('HOME', root);
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 39).toString('base64url'));
  vi.stubEnv('PATH', `${dirname(symlink)}${delimiter}${process.env.PATH}`);
  fixturePath = process.env.PATH!;
  mutateProviderKey('ANTHROPIC_API_KEY', { key, enabled: true });
  for (const file of [target, wrapped, direct]) mkdirSync(dirname(file), { recursive: true });
  mkdirSync(dirname(symlink));
  const cli = `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.argv.at(-1), JSON.stringify({
 key: process.env.ANTHROPIC_API_KEY === ${JSON.stringify(key)},
 alias: process.env.ANTHROPIC_AUTH_TOKEN === ${JSON.stringify(key)},
 service: process.env.FIXTURE_SERVICE_TOKEN === 'fixture-service'
}));
`;
  writeFileSync(target, cli, { mode: 0o700 });
  writeFileSync(direct, cli, { mode: 0o700 });
  symlinkSync(target, symlink);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(wrapped, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(target)} "$@"\n`, { mode: 0o700 });
});
afterEach(() => {
  if (serverId) removeExternalMcpServer(serverId);
  serverId = undefined;
  vi.stubEnv('PATH', fixturePath);
});
afterAll(async () => {
  (await import('@/lib/db')).closeDb();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const cases = [
  { kind: 'PATH symlink', command: 'claude', expected: symlink, apiAuthority: true },
  { kind: 'relative PATH symlink', command: 'claude', expected: symlink, apiAuthority: true },
  { kind: 'absolute symlink', command: symlink, expected: symlink, apiAuthority: true },
  { kind: 'shell wrapper', command: wrapped, expected: wrapped, apiAuthority: true },
  { kind: 'direct path', command: direct, expected: direct, apiAuthority: true },
  // Executable equivalence alone cannot promote a generic configured command.
  { kind: 'generic target', command: target, expected: target, apiAuthority: false },
];
for (const candidate of cases) it.each(['api', 'subscription'] as const)(`${candidate.kind} worker config preserves its configured payer under %s`, async mode => {
  if (candidate.kind === 'relative PATH symlink') vi.stubEnv('PATH', 'bin');
  saveRuntimeBillingMode('claude-code', mode);
  saveRuntimeBillingMode('codex', 'subscription');
  const sessionDir = join(root, `${candidate.kind.replaceAll(' ', '-')}-${mode}`);
  mkdirSync(sessionDir);
  const receipt = join(sessionDir, 'receipt.json');
  serverId = insertExternalMcpServer({ name: 'configured_cli', transport: 'stdio', command: candidate.command,
    args: ['mcp', 'serve', receipt], workerInjection: true,
    env: { ANTHROPIC_API_KEY: key, FIXTURE_SERVICE_TOKEN: 'fixture-service' } }).id;
  const session = { packetId: 'fixture', repoPath: root, branch: 'fixture', sessionDir } as OwnedSessionRecord;
  const prepared = await prepareOwnedWorkerMcpConfig({ adapter: claudeCodeOwnedAdapter, session,
    runId: 'fixture', mode: 'launch', sandboxEnabled: true });
  expect(prepared.servers.length).toBe(1);
  expect(Boolean(prepared.configPath && existsSync(prepared.configPath))).toBe(true);
  const config = JSON.parse(readFileSync(prepared.configPath!, 'utf8')) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  const entry = config.mcpServers.configured_cli;
  const api = mode === 'api' && candidate.apiAuthority;
  expect(basename(entry.command)).toBe(basename(candidate.expected));
  // A private launcher preserves the configured CLI name and verifies the
  // original executable at the nested spawn boundary; receipts below prove
  // which CLI actually received the environment.
  expect(Object.values(entry.env).some(value => value.includes(key))).toBe(api);
  expect(prepared.sandboxReadPaths).toContain(dirname(candidate.expected));
  expect(prepared.sandboxReadPaths).toContain(dirname(realpathSync(candidate.expected)));

  // The real application launch boundary rechecks the written file. The fake
  // consuming CLI then spawns it without our wrapper concealing a config leak.
  const consumer = `
const fs = require('node:fs');
const entry = JSON.parse(fs.readFileSync(process.argv.at(-1), 'utf8')).mcpServers.configured_cli;
const result = require('node:child_process').spawnSync(entry.command, entry.args, {
 env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: ${JSON.stringify(key)}, ...entry.env }, encoding: 'utf8'
});
process.exit(result.status ?? 1);
`;
  const consumerFile = join(sessionDir, 'consumer.cjs');
  writeFileSync(consumerFile, consumer, { mode: 0o600 });
  // Match the owned worker's asynchronous spawn: the nested helper reacquires
  // the store lock at its own process-creation boundary.
  const child = spawn(process.execPath, [consumerFile, '--mcp-config', prepared.configPath!], {
    env: childEnvironment({ runtimeId: 'codex' }), stdio: 'ignore',
  });
  const status = await new Promise<number | null>(resolve => child.once('close', resolve));
  expect(status).toBe(0);
  expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual({ key: api, alias: api, service: true });
});
