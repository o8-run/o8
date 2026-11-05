import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, it, vi } from 'vitest';
import { readRepositoryRequest, stopRepositoryReader } from '../src/lib/ws-server/repository-http-client';

const targetDir = join(process.cwd(), 'crates/o8d/target/repository-reads');
const binary = resolve(process.env.O8D_TEST_BINARY ?? process.env.O8D_BINARY ?? join(targetDir, 'debug', process.platform === 'win32' ? 'o8d.exe' : 'o8d'));
beforeAll(async () => {
  if (process.env.O8D_TEST_BINARY || process.env.O8D_BINARY) return;
  await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--target-dir', targetDir],
    { maxBuffer: 64 * 1024 * 1024 });
}, 900_000);

const quote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Reader lifecycle condition was not reached');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

it.skipIf(process.platform === 'win32')('coalesces native startup and stops an active Git child through the actual client', async () => {
  const directory = process.env.CORTEX_IDE_DATA_DIR!;
  const bin = join(directory, 'repository-client-bin');
  mkdirSync(bin, { recursive: true });
  const childPid = join(directory, 'repository-client-git-pid');
  const daemonPids = join(directory, 'repository-client-daemon-pids');
  const wrapper = join(bin, 'fixture-o8d');
  writeFileSync(join(directory, 'ws-token'), 'repository-client-token');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s' "$$" > ${quote(childPid)}\nexec sleep 60\n`, { mode: 0o700 });
  writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$$" >> ${quote(daemonPids)}\nexport PATH=${quote(bin)}:"$PATH"\nexec ${quote(binary)} "$@"\n`, { mode: 0o700 });
  const request = (query = '') => new Request(`http://127.0.0.1/api/panel/branches${query}`, { headers: { authorization: 'Bearer repository-client-token' } });
  vi.stubEnv('O8D_BINARY', wrapper);
  vi.stubEnv('O8D_NATIVE_REPOSITORY_READS', '0');
  try {
    expect(await readRepositoryRequest(request())).toBeNull();
    expect(existsSync(daemonPids)).toBe(false);
    vi.stubEnv('O8D_NATIVE_REPOSITORY_READS', '1');
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => readRepositoryRequest(request())));
    for (const response of concurrent) {
      expect(response?.status).toBe(400);
      expect(response?.headers.get('x-o8d-native-repository-read')).toBe('1');
    }
    const pids = readFileSync(daemonPids, 'utf8').trim().split('\n').map(Number);
    expect(pids).toHaveLength(1);
    const active = readRepositoryRequest(request('?path=fixture'));
    await until(() => existsSync(childPid));
    const gitPid = Number(readFileSync(childPid, 'utf8'));
    stopRepositoryReader();
    await until(() => !alive(pids[0]) && !alive(gitPid));
    expect(await active).toBeNull();
  } finally {
    stopRepositoryReader();
    vi.unstubAllEnvs();
  }
}, 20_000);
