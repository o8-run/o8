import 'server-only';

import { spawn, type ChildProcess } from '@/lib/providers/child-process';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { helperEnvironment, inspectPlatforms, inspectTools, installedTool, installTool, stopOwnedChild } from './tools';
import { DeviceError, type DeviceState, type DeviceTool } from './types';
import { DeviceControllers } from './controllers';
import { bindViewerAuthority } from './viewer-authority';
import { VIEWER_BOOTSTRAP, VIEWER_BOUNDARIES, VIEWER_LOADER } from './viewer-bootstrap';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('No port')); return; }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, 100);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

async function deviceList(response: Response): Promise<NonNullable<DeviceState['devices']>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1_000_000) throw new Error('Response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { simulators?: unknown; emulators?: unknown };
  if (!Array.isArray(payload.simulators) || !Array.isArray(payload.emulators)) throw new Error('Invalid device response');
  return [...payload.simulators, ...payload.emulators].slice(0, 500).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const device = item as Record<string, unknown>;
    if (typeof device.id !== 'string' || typeof device.name !== 'string' || !['ios', 'android'].includes(String(device.platform))) return [];
    return [{ id: device.id.slice(0, 256), name: device.name.slice(0, 256), platform: device.platform as 'ios' | 'android', state: device.booted === true ? 'running' : 'stopped', ...(typeof device.version === 'string' ? { version: device.version.slice(0, 80) } : {}) }];
  });
}

export class DeviceManager {
  private phase: DeviceState['phase'] = 'idle';
  private error?: string;
  private stage?: string;
  private child: ChildProcess | null = null;
  private pending: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private installer: ChildProcess | null = null;
  private abort?: AbortController;
  private origin?: string;
  private embedOrigin?: string;
  private token?: string;
  private frameAncestor?: string;
  private devices?: DeviceState['devices'];
  private platformRead?: { at: number; value: Promise<DeviceState['platforms']> };
  private viewerGuarded = false;

  constructor(readonly root: string) {}

  async state(): Promise<DeviceState> {
    // HMR may retain a helper started by an older, unfenced manager.
    if (this.phase === 'running' && !this.viewerGuarded) {
      await this.stop();
      this.phase = 'error'; this.error = 'Reopen the device viewer to enable controller checks.';
    }
    const phase = this.phase;
    if (!this.platformRead || Date.now() - this.platformRead.at > 10_000) this.platformRead = { at: Date.now(), value: inspectPlatforms() };
    const [tools, platforms, agent] = await Promise.all([inspectTools(this.root), this.platformRead.value, installedTool(this.root, 'agent')]);
    const authority = new DeviceControllers(this.root);
    await authority.roster();
    const snapshot = authority.snapshot();
    return { phase, tools, platforms, controllers: snapshot.controllers, controllerRevision: snapshot.revision,
      ...(this.error ? { error: this.error } : {}), ...(this.stage ? { stage: this.stage } : {}),
      ...(agent ? { agentCommand: [process.execPath, agent] } : {}),
      ...(phase === 'running' && this.embedOrigin && this.token ? { embedUrl: `${this.embedOrigin}/?token=${encodeURIComponent(this.token)}`, devices: this.devices } : {}),
    };
  }

  private run(phase: 'installing' | 'starting', work: () => Promise<void>): void {
    if (this.pending || this.stopping) throw new DeviceError('device_busy', 'A device helper operation is already in progress.', 409);
    this.phase = phase;
    this.error = undefined;
    const task = work().catch(async (error: unknown) => {
      await this.clearChild();
      this.phase = 'error';
      this.stage = undefined;
      this.error = error instanceof DeviceError ? error.message : 'The device helper operation failed. Check the required tools and retry.';
    }).finally(() => { if (this.pending === task) this.pending = null; });
    this.pending = task;
  }

  install(tool: DeviceTool | 'all'): void {
    if (this.phase === 'running') throw new DeviceError('device_busy', 'Stop the device panel before installing helpers.', 409);
    this.run('installing', async () => {
      for (const selected of tool === 'all' ? ['hub', 'agent'] as const : [tool]) {
        await installTool(this.root, selected, (stage) => { this.stage = stage; }, (child) => { this.installer = child; });
      }
      this.phase = 'idle';
      this.stage = undefined;
    });
  }

  start(frameAncestor: string): void {
    const frame = new URL(frameAncestor);
    // The upstream HTTP helper uses a Lax cookie. Keep the iframe on the same
    // loopback site; secure/custom-scheme shells need their local HTTP app page.
    if (frame.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(frame.hostname)) {
      throw new DeviceError('device_embed_origin_unsupported', 'Open the device panel from the app’s local HTTP page.', 409);
    }
    if (this.stopping) throw new DeviceError('device_busy', 'The device dashboard is stopping. Retry shortly.', 409);
    if (this.phase === 'running' || this.phase === 'starting') {
      if (frameAncestor !== this.frameAncestor) throw new DeviceError('device_origin_changed', 'Stop and reopen the device panel from this app window.', 409);
      return;
    }
    this.frameAncestor = frameAncestor;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.run('starting', async () => {
      this.stage = 'Checking the installed device helper';
      const entry = await installedTool(this.root, 'hub');
      if (!entry) throw new DeviceError('device_hub_missing', 'Install the device dashboard helper before opening the panel.', 409);
      if (signal.aborted) return;
      const port = await freePort();
      await mkdir(join(this.root, 'sessions'), { recursive: true, mode: 0o700 });
      if (signal.aborted) return;
      const origin = `http://127.0.0.1:${port}`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', VIEWER_BOOTSTRAP, entry, JSON.stringify({ boundaries: VIEWER_BOUNDARIES, loader: VIEWER_LOADER }), '--host', '127.0.0.1', '--port', String(port), '--require-token', '--frame-ancestor', frameAncestor], {
        cwd: this.root, env: helperEnvironment(this.root), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
      });
      this.child = child;
      let guarded = false;
      bindViewerAuthority(child, new DeviceControllers(this.root), () => this.child === child && this.phase === 'running', () => { guarded = true; this.viewerGuarded = true; });
      let output = '';
      let token: string | undefined;
      let exited = false;
      child.stdout?.on('data', (chunk: Buffer) => {
        // Retain only enough startup output to parse its loopback token link.
        output = (output + chunk.toString()).slice(-8_192);
        for (const match of output.matchAll(/https?:\/\/[^\s<>"']+/g)) {
          try {
            const url = new URL(match[0]);
            const candidate = url.searchParams.get('token');
            // The helper prints localhost even when its listener binds 127.0.0.1.
            if (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
              && url.port === String(port) && !url.username && !url.password && url.pathname === '/'
              && candidate && /^[A-Za-z0-9_-]{32,128}$/.test(candidate)) token = candidate;
          } catch { /* Startup output is untrusted data. */ }
        }
      });
      // Never relay child logs: URLs, SDK paths and credentials can appear in them.
      child.stderr?.on('data', () => {});
      const ended = () => {
        exited = true;
        if (this.child === child && this.phase === 'running') {
          this.child = null; this.origin = undefined; this.embedOrigin = undefined; this.token = undefined; this.devices = undefined; this.viewerGuarded = false;
          this.phase = 'error'; this.error = 'The device dashboard stopped. Reopen it to reconnect.';
        }
      };
      child.once('error', ended);
      child.once('exit', ended);
      this.stage = 'Starting the device dashboard';
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !signal.aborted && !exited) {
        if (token && guarded) {
          try {
            const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(3_000)]);
            const options = { signal: requestSignal, redirect: 'error' as const, cache: 'no-store' as const };
            const ready = await fetch(`${origin}/readyz`, options);
            void ready.body?.cancel();
            if (!ready.ok) { await pause(signal); continue; }
            const denied = await fetch(`${origin}/api/devices`, options);
            void denied.body?.cancel();
            if (![401, 403].includes(denied.status)) throw new DeviceError('device_auth_unverified', 'The device dashboard did not enforce its access token. It was stopped.');
            const authenticated = await fetch(`${origin}/api/devices`, { ...options, headers: { Authorization: `Bearer ${token}` } });
            if (!authenticated.ok) { void authenticated.body?.cancel(); await pause(signal); continue; }
            const devices = await deviceList(authenticated);
            if (signal.aborted || exited) break;
            this.origin = origin; this.embedOrigin = `http://${frame.hostname}:${port}`; this.token = token; this.devices = devices;
            output = ''; this.phase = 'running'; this.stage = undefined;
            return;
          } catch (error) { if (error instanceof DeviceError) throw error; }
        }
        await pause(signal);
      }
      throw new DeviceError('device_start_failed', signal.aborted ? 'Device dashboard startup was cancelled.' : 'The device dashboard could not start securely. Check the installed tools and retry.');
    });
  }

  private async clearChild(): Promise<void> {
    const child = this.child;
    this.child = null; this.origin = undefined; this.embedOrigin = undefined; this.token = undefined; this.devices = undefined; this.viewerGuarded = false;
    if (child) await stopOwnedChild(child);
  }

  async stop(): Promise<void> {
    if (this.phase === 'installing') throw new DeviceError('device_busy', 'Wait for device helper installation to finish.', 409);
    if (this.stopping) return this.stopping;
    const task = (async () => {
      this.abort?.abort();
      this.stage = 'Stopping the device dashboard';
      if (this.pending) await this.pending;
      await this.clearChild();
      this.phase = 'idle'; this.stage = undefined; this.error = undefined; this.frameAncestor = undefined;
    })().finally(() => { if (this.stopping === task) this.stopping = null; });
    this.stopping = task;
    return task;
  }

  async refresh(): Promise<void> {
    this.platformRead = undefined;
    if (this.phase !== 'running' || !this.origin || !this.token) return;
    const child = this.child;
    try {
      const response = await fetch(`${this.origin}/api/devices`, {
        headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(5_000), redirect: 'error', cache: 'no-store',
      });
      if (!response.ok) { void response.body?.cancel(); throw new Error('Refresh failed'); }
      const devices = await deviceList(response);
      if (this.child === child) { this.devices = devices; this.error = undefined; }
    } catch { if (this.child === child) this.error = 'Devices could not be refreshed. Retry from the panel.'; }
  }

  dispose(): void { this.abort?.abort(); this.child?.kill('SIGTERM'); this.installer?.kill('SIGTERM'); }
}

const globalState = globalThis as typeof globalThis & {
  __o8DeviceManager?: DeviceManager;
  __o8DeviceManagerClass?: typeof DeviceManager;
};
// Register only when a module is evaluated. A retained older route/getter must
// not restore obsolete methods after HMR; owned processes and fields stay intact.
globalState.__o8DeviceManagerClass = DeviceManager;
if (globalState.__o8DeviceManager) Object.setPrototypeOf(globalState.__o8DeviceManager, DeviceManager.prototype);
export function getDeviceManager(): DeviceManager {
  if (!globalState.__o8DeviceManager) {
    const manager = new (globalState.__o8DeviceManagerClass ?? DeviceManager)(join(getDataDir(), 'devices'));
    globalState.__o8DeviceManager = manager;
    process.once('exit', () => manager.dispose());
  }
  return globalState.__o8DeviceManager;
}
