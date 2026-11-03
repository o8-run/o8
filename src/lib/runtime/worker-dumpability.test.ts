import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstatSync } from 'node:fs';
import { userInfo } from 'node:os';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'linux')('spawns a dumpable worker child with cwd link owned by our uid', async () => {
  const child = spawn(process.execPath, ['-e', 'process.send("ready");setInterval(() => {}, 1000);'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const closed = once(child, 'close');
  try {
    await once(child, 'message');
    expect(child.pid).toBeGreaterThan(0);
    expect(lstatSync(`/proc/${child.pid}/cwd`).uid).toBe(userInfo().uid);
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
});
