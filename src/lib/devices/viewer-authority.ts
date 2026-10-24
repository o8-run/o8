import type { ChildProcess } from '@/lib/providers/child-process';
import { probeMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import { DeviceControllers } from './controllers';
import { DeviceError } from './types';

/** Only the owned helper's IPC channel can request native input admission. */
export function bindViewerAuthority(child: ChildProcess, authority: DeviceControllers, running: () => boolean, ready: () => void): void {
  const pending = new Map<string, { resolve: () => void; reject: () => void; completion?: string }>();
  let identity: ReturnType<typeof probeMetadataLockProcessIdentity> | undefined;
  const live = () => child.connected && child.exitCode === null && child.signalCode === null && running();
  const respond = (requestId: string, ok: boolean, lease?: string) => {
    if (child.connected) child.send?.({ type: 'o8-device-result', requestId, ok, ...(lease ? { lease } : {}) });
  };
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const input = message as Record<string, unknown>;
    if (input.type === 'o8-device-ready') { ready(); return; }
    if (typeof input.requestId !== 'string' || !/^[0-9]{1,16}$/.test(input.requestId)) return;
    const requestId = input.requestId;
    if (input.type === 'o8-device-complete') {
      const task = pending.get(String(input.lease));
      if (!task) { respond(requestId, false); return; }
      task.completion = requestId;
      if (input.failed === true) task.reject(); else task.resolve();
      return;
    }
    if (input.type !== 'o8-device-begin' || !live() || pending.size >= 64
      || typeof input.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(input.deviceId)) { respond(requestId, false); return; }
    const deviceId = input.deviceId;
    void (async () => {
      // The owned IPC channel and ChildProcess instance cannot survive PID reuse.
      const probe = child.pid ? await (identity ??= probeMetadataLockProcessIdentity(child.pid)) : { state: 'absent' as const };
      if (probe.state !== 'live' || !live()) { respond(requestId, false); return; }
      let admitted = false;
      try {
        await authority.operatorInput(deviceId, () => new Promise<void>((resolve, reject) => {
          if (!live()) { reject(new DeviceError('device_viewer_stopped', 'The device viewer stopped.', 409)); return; }
          admitted = true;
          pending.set(requestId, { resolve, reject: () => reject(new DeviceError('device_viewer_input_failed', 'Viewer input could not be confirmed. Release control before retrying.', 409)) });
          respond(requestId, true, requestId);
        }), { pid: child.pid!, identity: probe.identity });
        const completion = pending.get(requestId)?.completion;
        if (completion) respond(completion, true);
      } catch {
        const completion = pending.get(requestId)?.completion;
        respond(completion ?? requestId, false);
      } finally { if (admitted) pending.delete(requestId); }
    })();
  });
  const ended = () => { for (const task of pending.values()) task.reject(); };
  child.once('exit', ended); child.once('error', ended);
}
