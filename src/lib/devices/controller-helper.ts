import 'server-only';

import { spawn } from '@/lib/providers/child-process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { helperEnvironment, installedTool } from './tools';
import { DeviceError } from './types';
import { probeMetadataLockProcessIdentitySync, type MetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';

/** Pin cwd, session and daemon state; callers cannot supply CLI flags or paths. */
export async function runControllerHelper(root: string, session: string, args: string[], onChild?: (child: { pid: number; identity: MetadataLockProcessIdentity }) => void): Promise<unknown> {
  const entry = await installedTool(root, 'agent');
  if (!entry) throw new DeviceError('device_agent_missing', 'Set up agent controls in Devices first.', 409);
  const stateDir = join(root, 'agent-state');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args, '--session', session, '--json'], {
      cwd: root, env: { ...helperEnvironment(root), AGENT_DEVICE_STATE_DIR: stateDir },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    let overflow = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > 1_000_000) { overflow = true; child.kill('SIGKILL'); }
      else output += chunk.toString();
    });
    child.stderr?.on('data', () => {});
    child.once('error', () => { clearTimeout(timer); reject(new DeviceError('device_helper_failed', 'Device input could not start. Ownership is retained; retry release from Devices.', 409)); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0 || overflow || timedOut) {
        reject(new DeviceError('device_helper_failed', 'The device helper could not confirm the action. Ownership is retained; retry release from Devices.', 409));
        return;
      }
      try {
        const value = JSON.parse(output);
        if (!value || typeof value !== 'object' || (value.ok !== true && value.success !== true)) throw new Error('Unconfirmed');
        resolve(value.data ?? value);
      } catch { reject(new DeviceError('device_helper_unverified', 'The device helper did not confirm the action. Ownership is retained.', 409)); }
    });
    if (child.pid && onChild) {
      try {
        const probe = probeMetadataLockProcessIdentitySync(child.pid);
        if (probe.state === 'live') onChild({ pid: child.pid, identity: probe.identity });
      } catch { overflow = true; child.kill('SIGKILL'); }
    }
  });
}
