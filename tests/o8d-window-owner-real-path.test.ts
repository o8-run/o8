import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until<T>(read: () => T | undefined, label: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}

// With Next stopped, the WS process serves the API port, and the shell gives it the o8 next
// binary, so it owns the window. It must open o8 next once at startup, and the shell's
// `experimentalNext: true` settings POST must find that window rather than open a second.
it.skipIf(process.platform === 'win32')('opens one o8 next window from the WS process and never a second', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-window-owner-')));
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'o8-window-owner-bin-')));
  const launches = join(scratch, 'launches');
  const binary = join(scratch, 'o8-next');
  writeFileSync(binary, `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(launches)}, process.pid + '\\n');
console.log('o8-next-ready');
if (process.env.O8_NEXT_PARENT_PIPE === '1') { process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); }
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const device = 'window-owner-fixture-device-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  const windows = () => existsSync(launches) ? readFileSync(launches, 'utf8').trim().split('\n').filter(Boolean).map(Number) : [];
  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    // The shell's environment for the window-owning process, inherited by the WS child.
    Object.assign(process.env, { O8_PACKAGED_APP: '1', O8_NEXT_BIN: binary, O8_NEXT_MAIN_WINDOW: '1' });
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const settings = (headers: Record<string, string>) => fetch(`${origin}/api/panel/operator-defaults`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ experimentalNext: true }) });

    const [window] = await until(() => windows().length > 0 ? windows() : undefined, 'o8 next opened at startup');
    expect(alive(window)).toBe(true);

    // The shell's show() POST, twice, finds the open window.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await settings({ authorization: `Bearer ${server.token}` });
      expect([attempt, response.status]).toEqual([attempt, 200]);
    }
    // A paired device may change settings too (DEVICE_CAPABILITIES); it reaches the same window.
    expect((await settings({ authorization: `Bearer ${device}` })).status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(windows()).toEqual([window]);
    expect(alive(window)).toBe(true);
  } finally {
    await server?.stop();
    for (const pid of windows()) if (alive(pid)) process.kill(pid, 'SIGKILL');
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}, 180_000);
