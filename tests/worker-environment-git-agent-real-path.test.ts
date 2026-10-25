import { afterAll, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createServer, connect } from 'node:net';
import { execFileSync, spawn as fixtureSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.root, migrateDataDirOnce: () => {} }));
state.root = mkdtempSync(join(tmpdir(), 'o8-env-git-agent-'));
const root = state.root;
const { childEnvironment } = await import('@/lib/providers/spawn-environment');
const { spawn } = await import('@/lib/providers/child-process');
const children: import('node:child_process').ChildProcess[] = [];
afterAll(async () => {
  for (const child of children) if (child.exitCode === null) {
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.kill('SIGTERM'); await closed;
  }
  vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const status = (child: import('node:child_process').ChildProcess) => new Promise<number | null>((resolve, reject) => {
  child.once('error', reject); child.once('close', resolve);
});

it.skipIf(process.platform !== 'linux')('a worker authenticates Git using only its SSH agent socket', async () => {
  expect(existsSync('/usr/sbin/sshd'), 'the Linux receipt requires a real SSH daemon').toBe(true);
  const home = join(root, 'home'); mkdirSync(home);
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: process.env.PATH, HOME: home, LC_ALL: 'C' };
  const host = join(root, 'host');
  const key = join(root, 'client');
  for (const file of [host, key]) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file], { env, stdio: 'ignore' });
  const socket = join(root, 'agent.sock');
  children.push(fixtureSpawn('ssh-agent', ['-D', '-a', socket], { env, stdio: 'ignore' }));
  await vi.waitFor(() => expect(existsSync(socket)).toBe(true));
  execFileSync('ssh-add', [key], { env: { ...env, SSH_AUTH_SOCK: socket }, stdio: 'ignore' });
  // No private key remains on disk or under HOME when the worker authenticates.
  unlinkSync(key);
  writeFileSync(join(root, 'authorized_keys'), readFileSync(`${key}.pub`));
  const repository = join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', '-q', repository], { env, stdio: 'ignore' });
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const config = join(root, 'sshd.conf');
  writeFileSync(config, [
    `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${host}`, `PidFile ${join(root, 'sshd.pid')}`,
    `AuthorizedKeysFile ${join(root, 'authorized_keys')}`, 'StrictModes no', 'UsePAM no',
    'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes',
    'PermitRootLogin no', 'LogLevel ERROR', `AllowUsers ${userInfo().username}`,
  ].join('\n'));
  children.push(fixtureSpawn('/usr/sbin/sshd', ['-D', '-e', '-f', config], { env, stdio: 'ignore' }));
  await vi.waitFor(async () => {
    const ready = await new Promise<boolean>(resolve => {
      const client = connect(port, '127.0.0.1');
      client.once('connect', () => { client.destroy(); resolve(true); }); client.once('error', () => resolve(false));
    });
    expect(ready, 'fixture SSH server must accept connections').toBe(true);
  });
  const ssh = `ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=no -o IdentityFile=none -o PreferredAuthentications=publickey -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o StrictHostKeyChecking=no -o UserKnownHostsFile=${quote(join(root, 'known_hosts'))}`;
  const args = ['ls-remote', `ssh://${userInfo().username}@127.0.0.1:${port}${repository}`];
  const transport = { ...env, GIT_SSH_COMMAND: ssh };
  // Positive and negative fixture controls prove agent-only authentication.
  expect(await status(fixtureSpawn('git', args, { env: { ...transport, SSH_AUTH_SOCK: socket }, stdio: 'ignore' }))).toBe(0);
  expect(await status(fixtureSpawn('git', args, { env: transport, stdio: 'ignore' }))).not.toBe(0);
  vi.stubEnv('HOME', home);
  vi.stubEnv('SSH_AUTH_SOCK', socket);
  vi.stubEnv('O8_MASTER_KEY', randomBytes(32).toString('base64url'));
  vi.stubEnv('O8_WORKER_ENV_ALLOW', ''); vi.stubEnv('O8_WORKER_ENV_INHERIT', '0');
  const worker = childEnvironment({ runtimeId: 'codex', env: { GIT_SSH_COMMAND: ssh } });
  expect(await status(spawn('git', args, { env: worker, stdio: 'ignore' })), 'worker must retain agent-only Git authentication').toBe(0);
}, 20_000);
