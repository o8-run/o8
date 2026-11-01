import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => state.dir }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
import {
  bindThreadProviderInstance, createProviderInstance, deleteProviderInstance, listProviderInstances,
  readInstanceEnvironment, resolveProviderInstanceLaunch, saveInstanceEnvironment, updateProviderInstance,
} from './instances';
import { runWithThreadProviderInstance } from './instance-launch';
import { childEnvironment } from './spawn-environment';
import { localAcpProcessLaunch, readLocalAcpConnection, saveLocalAcpConnection } from '@/lib/acp/local-connection';
import { acpEnvironmentId, readAcpEnvironment, saveAcpEnvironment } from '@/lib/acp/connection-environment';
import { resolveCli } from '@/lib/runtimes/shared/cli-resolver';

state.dir = mkdtempSync(join(tmpdir(), 'o8-provider-instances-'));
beforeEach(() => { rmSync(join(state.dir, 'provider-instances.json'), { force: true }); vi.stubEnv('O8_ACP_COMMAND', ''); });
afterAll(() => { rmSync(state.dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

it('stores instances without secrets and keeps env encrypted in the ACP env store', () => {
  const work = createProviderInstance({ runtime: 'codex', name: 'work', homeDir: '/tmp/codex-work', binaryPath: '/opt/codex-work/codex' });
  expect(work).toMatchObject({ id: 'codex-work', runtime: 'codex', enabled: true });
  expect(createProviderInstance({ runtime: 'codex', name: 'work' }).id).toBe('codex-work-2');
  saveInstanceEnvironment('codex-work', 0, [{ name: 'WORK_TOKEN', secret: true, value: 'fixture-secret-value' }, { name: 'WORK_REGION', secret: false, value: 'eu' }]);
  const inventory = readInstanceEnvironment('codex-work');
  expect(inventory.variables).toEqual(expect.arrayContaining([{ name: 'WORK_TOKEN', secret: true, configured: true }]));
  expect(JSON.stringify(inventory)).not.toContain('fixture-secret-value');
  expect(readFileSync(join(state.dir, 'provider-instances.json'), 'utf8')).not.toContain('fixture-secret-value');
  expect(readFileSync(join(state.dir, 'acp-environment.sqlite')).toString('latin1')).not.toContain('fixture-secret-value');
  expect(updateProviderInstance('codex-work', { name: 'Work', enabled: false })).toMatchObject({ name: 'Work', homeDir: '/tmp/codex-work', enabled: false });
  expect(() => createProviderInstance({ runtime: 'codex', name: 'x', homeDir: 'relative' })).toThrow(/absolute/);
  expect(() => createProviderInstance({ runtime: 'nope', name: 'x' })).toThrow(/Unknown runtime/);
  expect(() => deleteProviderInstance('codex')).toThrow(/Default/);
  expect(deleteProviderInstance('codex-work')).toBe(true);
  expect(readAcpEnvironment('instance:codex-work').variables).toEqual([]);
  expect(listProviderInstances().map(i => i.id)).toEqual(['codex-work-2']);
});

it('presents the Local ACP slot as an instance without moving its data', () => {
  const connection = { name: 'My agent', command: '/bin/agent', args: ['acp'], useOpenRouter: false };
  saveLocalAcpConnection(connection);
  saveAcpEnvironment({ connectionId: acpEnvironmentId(connection), revision: 0 }, [{ name: 'AGENT_MODE', secret: false, value: 'fast' }]);
  expect(listProviderInstances()[0]).toMatchObject({ id: 'acp', runtime: 'acp', name: 'My agent', default: true, acp: connection });
  expect(readInstanceEnvironment('acp').connectionId).toBe(acpEnvironmentId(connection));
  expect(existsSync(join(state.dir, 'provider-instances.json'))).toBe(false);
  expect(readLocalAcpConnection()).toEqual(connection);
  expect(localAcpProcessLaunch()).toMatchObject({ command: '/bin/agent', env: { AGENT_MODE: 'fast' } });
  expect(() => deleteProviderInstance('acp')).toThrow(/Default/);
});

it('injects the bound instance home, env and binary only into its own runtime', async () => {
  createProviderInstance({ runtime: 'codex', name: 'work', homeDir: '/tmp/codex-work', binaryPath: '/opt/codex-work/codex' });
  saveInstanceEnvironment('codex-work', readInstanceEnvironment('codex-work').revision, [{ name: 'WORK_REGION', secret: false, value: 'eu' }]);
  expect(resolveProviderInstanceLaunch('thread-1', 'codex')).toBeNull();
  bindThreadProviderInstance('thread-1', 'codex-work');
  const seen = await runWithThreadProviderInstance('codex', 'thread-1', async () => ({
    codex: childEnvironment({ runtimeId: 'codex', inherit: false, env: { CODEX_HOME: '/default/home' } }),
    claude: childEnvironment({ runtimeId: 'claude-code', inherit: false }),
    cli: (await resolveCli({ runtimeId: 'codex', binaryName: 'codex' } as never)).path,
  }));
  expect(seen.codex).toMatchObject({ CODEX_HOME: '/tmp/codex-work', WORK_REGION: 'eu' });
  expect(seen.claude.WORK_REGION).toBeUndefined();
  expect(seen.cli).toBe('/opt/codex-work/codex');
  const plain = await runWithThreadProviderInstance('codex', 'thread-2', async () => childEnvironment({ runtimeId: 'codex', inherit: false, env: { CODEX_HOME: '/default/home' } }));
  expect(plain.CODEX_HOME).toBe('/default/home');
  expect(plain.WORK_REGION).toBeUndefined();
  updateProviderInstance('codex-work', { enabled: false });
  await expect(runWithThreadProviderInstance('codex', 'thread-1', async () => 1)).rejects.toThrow(/turned off/);
  deleteProviderInstance('codex-work');
  await expect(runWithThreadProviderInstance('codex', 'thread-1', async () => 1)).resolves.toBe(1);
});

it('runs a bound ACP instance with its own command and env', async () => {
  const instance = createProviderInstance({ runtime: 'acp', name: 'second', acp: { command: '/bin/second', args: ['--acp'], useOpenRouter: false } });
  saveInstanceEnvironment(instance.id, 0, [{ name: 'SECOND_MODE', secret: false, value: 'x' }]);
  bindThreadProviderInstance('acp-thread', instance.id);
  const launch = await runWithThreadProviderInstance('acp', 'acp-thread', async () => localAcpProcessLaunch());
  expect(launch).toMatchObject({ command: '/bin/second', args: ['--acp'], env: { SECOND_MODE: 'x' }, localEnvironment: { connectionId: `instance:${instance.id}` } });
});
