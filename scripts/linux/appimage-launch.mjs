// AppImage mounts/extractions are temporary. Keep daemons and repeat launches
// on the same application path after the AppImage runtime has exited.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [identity, ...args] = process.argv.slice(2);
if (!/^[a-f0-9]{64}$/.test(identity || '')) throw new Error('Missing AppImage payload identity');
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const data = process.env.XDG_DATA_HOME || join(homedir(), '.local/share');
if (!isAbsolute(data)) throw new Error('XDG_DATA_HOME must be absolute');
const parent = join(data, 'o8/appimage');
const installed = join(parent, identity);
mkdirSync(parent, { recursive: true, mode: 0o700 });
if (!existsSync(installed)) {
  const scratch = mkdtempSync(join(parent, '.install-'));
  try {
    cpSync(join(source, 'usr'), join(scratch, 'usr'), { recursive: true });
    try { renameSync(scratch, installed); } catch (error) {
      // Another launch can finish copying the identical immutable payload first.
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !existsSync(installed)) throw error;
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (args.length === 1 && args[0] === '--o8-appimage-root') {
  console.log(installed);
} else {
  const child = spawn(join(installed, 'usr/bin/o8'), args, { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  const [code, signal] = await once(child, 'exit');
  process.exitCode = code ?? (signal ? 1 : 0);
}
