/**
 * Guard: o8's local servers (Next API on the 47100 block, ws-server on the
 * 47105 block) must not hard-code a wildcard bind. They resolve their host via
 * src/lib/panel/listen-host.ts (TS) / sidecar_listen_host() (Rust), which is
 * 127.0.0.1 unless the operator opts in with O8_LAN_ACCESS=1.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('local server bind address', () => {
  it('ws-server and the o8d bridge never listen on a hard-coded wildcard', () => {
    for (const file of ['src/ws-server.ts', 'src/lib/ws-server/o8d-bridge.ts']) {
      const source = read(file);
      expect(source, file).not.toMatch(/\.listen\([^)]*['"`](0\.0\.0\.0|::)['"`]/);
      expect(source, file).not.toMatch(/--listen['"`],\s*`0\.0\.0\.0/);
    }
    expect(read('src/ws-server.ts')).toContain('resolveListenHost()');
  });

  it('the Tauri sidecar passes the resolved host as HOSTNAME to the Next server', () => {
    const source = read('src-tauri/src/lib.rs');
    expect(source).not.toMatch(/\.env\("HOSTNAME",\s*"0\.0\.0\.0"\)/);
    expect(source).toContain('.env("HOSTNAME", sidecar_listen_host())');
  });

  it('`o8 serve` pins HOSTNAME so Next does not fall back to 0.0.0.0', () => {
    expect(read('cli/src/commands/serve.ts')).toContain('HOSTNAME: resolveListenHost(process.env)');
  });
});
