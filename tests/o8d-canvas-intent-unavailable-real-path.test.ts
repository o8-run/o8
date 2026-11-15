import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// The canvas intent bus is retired from the Next-stopped scope: it drives a canvas page only Next
// renders. With Next stopped the WS listener answers it with a reason the o8_canvas tool shows,
// instead of a bare 404, and still only to the operator.
it.skipIf(process.platform === 'win32')('tells canvas callers why the canvas is unavailable with Next stopped (#5576)', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-canvas-intent-')));
  const worker = 'canvas-intent-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'worker-token'), worker);
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const intent = (bearer?: string) => fetch(`${origin}/api/canvas/intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ verb: 'enter' }),
    });
    expect((await intent()).status).toBe(401);
    expect((await intent(worker)).status).toBe(403);
    const refused = await intent(server.token);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ ok: false, code: 'canvas_unavailable', error: expect.stringContaining('need Next running') });

    // The o8_canvas tool, pointed at this listener the way it finds the API port, shows the reason.
    const client = realpathSync(mkdtempSync(join(tmpdir(), 'o8-canvas-mcp-')));
    try {
      writeFileSync(join(client, 'api-port'), new URL(origin).port);
      writeFileSync(join(client, 'ws-token'), server.token);
      const { stdout } = await promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--eval', `
        const { handleCanvas } = require('./src/lib/mcp/operator-handlers/canvas.ts');
        handleCanvas({ verb: 'enter' }).then(result => console.log('result ' + JSON.stringify(result)));
      `], { env: { ...process.env, CORTEX_IDE_DATA_DIR: client, O8_DATA_DIR: client }, timeout: 60_000 });
      const result = JSON.parse(stdout.split('\n').find(line => line.startsWith('result '))!.slice(7)) as
        { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('need Next running');
    } finally {
      rmSync(client, { recursive: true, force: true });
    }
  } finally {
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
