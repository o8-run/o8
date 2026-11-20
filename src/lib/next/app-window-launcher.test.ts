import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// #6529: with Next off, the launcher owns the window. WS attaches to the
// launcher's control socket for browser actions and never starts the window.
const directory = mkdtempSync(join(tmpdir(), 'o8-window-control-'));
const path = join(directory, 'window-control.sock');
let server: Server | undefined;
const open = new Set<Socket>();

afterEach(async () => {
  const closing = new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  for (const socket of open) socket.destroy();
  await closing;
  server = undefined;
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

/** A launcher stand-in: records each attachment's first line, answers frames like the window. */
function launcher(): { keys: string[]; sockets: Socket[]; frames: string[] } {
  const seen = { keys: [] as string[], sockets: [] as Socket[], frames: [] as string[] };
  server = createServer(socket => {
    seen.sockets.push(socket);
    open.add(socket);
    socket.once('close', () => open.delete(socket));
    let buffered = '';
    let keyed = false;
    socket.on('data', chunk => {
      buffered += String(chunk);
      for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        if (!keyed) { keyed = true; seen.keys.push(line); continue; }
        seen.frames.push(line);
        const frame = JSON.parse(line) as { id: string };
        socket.write(`o8-next-browser-result:${JSON.stringify({ id: frame.id, result: { ok: true, via: 'launcher' } })}\n`);
      }
    });
  });
  server.listen(path);
  return seen;
}

describe('launcher-owned o8 next window', () => {
  it('attaches with the launcher key, round-trips browser actions, and reattaches after a drop', async () => {
    const seen = launcher();
    vi.stubEnv('O8_PACKAGED_APP', '1');
    vi.stubEnv('O8_NEXT_MAIN_WINDOW', '1');
    vi.stubEnv('O8_NEXT_BIN', '');
    vi.stubEnv('O8_NEXT_WINDOW_CONTROL', path);
    vi.stubEnv('O8_NEXT_WINDOW_CONTROL_KEY', 'fixture-launcher-key');
    const { restoreNextWindow, setNextWindowEnabled, nextWindowError } = await import('./app-window');
    const { requestNextBrowser } = await import('./browser-pipe');
    await restoreNextWindow();
    await vi.waitFor(() => expect(seen.keys).toEqual(['fixture-launcher-key']));
    expect(await requestNextBrowser('read', {})).toEqual({ ok: true, via: 'launcher' });
    expect(JSON.parse(seen.frames[0]).type).toBe('browser-agent');

    // Turning the window on or off never spawns or stops anything from this process.
    await expect(setNextWindowEnabled(true)).resolves.toBeUndefined();
    await expect(setNextWindowEnabled(false)).resolves.toBeUndefined();
    expect(nextWindowError()).toBeNull();

    // The launcher dropping the attachment ends nothing for good: WS attaches again.
    seen.sockets[0].destroy();
    await vi.waitFor(() => expect(seen.keys).toHaveLength(2), { timeout: 3_000 });
    await vi.waitFor(async () => expect(await requestNextBrowser('read', {})).toEqual({ ok: true, via: 'launcher' }));
  });
});
