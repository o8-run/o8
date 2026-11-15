import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

let root: string;
const children: ChildProcess[] = [];
function child(path: string, probe = false) {
  const process = spawn(globalThis.process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--require=tsx/cjs', 'tests/fixtures/symon-brain-owner-child.cjs', path, probe ? 'probe' : 'hold'],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.push(process);
  return process;
}
async function result(process: ChildProcess) {
  let stderr = '';
  process.stderr!.on('data', chunk => { stderr += String(chunk); });
  return Promise.race([
    once(process, 'message').then(([message]) => message as { opened: boolean; error?: string }),
    once(process, 'exit').then(() => { throw new Error(`Brain fixture exited before ready: ${stderr}`); }),
  ]);
}
afterEach(async () => {
  for (const process of children.splice(0)) {
    if (process.exitCode === null && process.signalCode === null) {
      const exit = once(process, 'exit'); process.kill('SIGKILL'); await exit;
    }
  }
  if (root) rmSync(root, { recursive: true, force: true });
});
it('refuses a second real store opener and permits recovery after the holder is killed', async () => {
  root = mkdtempSync(join(tmpdir(), 'o8-brain-owner-'));
  const path = join(root, 'symon', 'durable.sqlite');
  const holder = child(path);
  expect(await result(holder)).toEqual({ opened: true });
  expect(await result(child(path, true))).toMatchObject({ opened: false, error: expect.stringContaining('symon_brain_owned') });
  const exit = once(holder, 'exit'); holder.kill('SIGKILL'); await exit;
  expect(await result(child(path, true))).toEqual({ opened: true });
}, 60_000);
