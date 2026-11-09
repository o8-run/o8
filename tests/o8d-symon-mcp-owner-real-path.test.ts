import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

const fixture = join(process.cwd(), 'tests/fixtures/symon-mcp-server.mjs');
const SENTINEL = 'o8-fixture-sentinel-provider-key';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Condition did not become true within ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

// Symon's connected MCP tools with the native transport on: the WS process owns
// the MCP sessions and their children, Next's routes forward to it, and a registry
// write made by another process still reaches the owner's sessions.
it.skipIf(process.platform === 'win32')('keeps one owner for Symon MCP sessions and sees registry writes from another process', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-symon-mcp-owner-')));
  const device = 'symon-mcp-owner-fixture-device-0123456789abcdef';
  const worker = 'symon-mcp-owner-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  const files = (tag: string) => ({ SYMON_MCP_PID_FILE: join(directory, `${tag}.pid`), SYMON_MCP_EXIT_FILE: join(directory, 'exit.log'),
    SYMON_MCP_SENTINEL_FILE: join(directory, `${tag}.sentinel`) });
  const saved = { ...process.env };
  // Provider keys the owner process holds; the MCP child must never receive them.
  Object.assign(process.env, { OPENAI_API_KEY: SENTINEL, ANTHROPIC_API_KEY: SENTINEL });
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const operator = { authorization: `Bearer ${server.token}` };
    // Registry writes from a separate process, standing in for Next's /api/setup/mcp-servers.
    const registry = async (script: string) => {
      const env = { ...process.env, O8_DATA_DIR: directory, CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db') };
      const { stdout } = await promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--eval', `
        const servers = require('./src/lib/mcp/external-servers.ts');
        const result = (${script})(servers);
        console.log('RESULT' + JSON.stringify(result ?? null));
        require('./src/lib/db/index.ts').closeDb();
      `], { env });
      return JSON.parse(stdout.split('\n').find(line => line.startsWith('RESULT'))!.slice(6)) as { id: string } | null;
    };
    const created = await registry(`(s) => s.insertExternalMcpServer({ name: 'fixture', transport: 'stdio', command: ${JSON.stringify(process.execPath)},
      args: [${JSON.stringify(fixture)}], env: ${JSON.stringify(files('first'))}, enabled: true, symonInjection: true })`);
    const id = created!.id;
    const call = (path: string, headers: Record<string, string>, body?: unknown) => fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } });
    const echo = { name: 'mcp__fixture__echo', args: { value: 'fixture-value' } };

    // Operator only over the native transport, even with forged loopback markers; no child starts.
    const forged = { 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1' };
    for (const [path, body] of [['/api/symon/mcp/tools'], ['/api/symon/mcp/call', echo]] as const) {
      expect([path, (await call(path, forged, body)).status]).toEqual([path, 401]);
      for (const token of [device, worker]) {
        expect([path, (await call(path, { ...forged, authorization: `Bearer ${token}` }, body)).status]).toEqual([path, 403]);
      }
    }
    expect(existsSync(files('first').SYMON_MCP_PID_FILE), 'a refused caller starts no MCP child').toBe(false);

    const catalog = await (await call('/api/symon/mcp/tools', operator)).json() as { ok: boolean; tools: Array<{ name: string }> };
    expect([catalog.ok, catalog.tools.map(tool => tool.name)]).toEqual([true, ['mcp__fixture__echo']]);
    const first = Number(readFileSync(files('first').SYMON_MCP_PID_FILE, 'utf8'));
    expect(readFileSync(files('first').SYMON_MCP_SENTINEL_FILE, 'utf8'), 'no provider key reaches the MCP child').toBe('false');
    const called = await (await call('/api/symon/mcp/call', operator, echo)).json() as { ok: boolean; result: { observedData: { data: unknown } } };
    expect([called.ok, called.result.observedData.data]).toMatchObject([true, { structuredContent: { echo: 'fixture-value' } }]);

    // Next's routes forward to the owner instead of starting a second child.
    Object.assign(process.env, { O8_NEXT_O8D: '1', O8_API_PORT: '1', O8_WS_PORT: new URL(origin).port });
    const { GET: tools } = await import('@/app/api/symon/mcp/tools/route');
    const { POST: callTool } = await import('@/app/api/symon/mcp/call/route');
    const forwarded = await (await tools(new Request('http://127.0.0.1/api/symon/mcp/tools', { headers: operator }))).json();
    expect(forwarded).toEqual(catalog);
    const forwardedCall = await callTool(new Request('http://127.0.0.1/api/symon/mcp/call', { method: 'POST',
      headers: { ...operator, 'content-type': 'application/json' }, body: JSON.stringify(echo) }));
    expect(await forwardedCall.json()).toEqual(called);
    expect(Number(readFileSync(files('first').SYMON_MCP_PID_FILE, 'utf8')), 'the same child served every call').toBe(first);
    expect(alive(first)).toBe(true);

    // Symon's access revoked by another process: the owner refuses the tool and stops the child.
    await registry(`(s) => s.updateExternalMcpServer(${JSON.stringify(id)}, { symonInjection: false })`);
    const revoked = await call('/api/symon/mcp/call', operator, echo);
    expect(revoked.status).toBe(400);
    expect((await revoked.json() as { error: string }).error).toContain('Unknown or unavailable connected MCP tool');
    await waitFor(() => !alive(first));
    // Restored by another process: the owner starts a fresh child for the next call.
    await registry(`(s) => s.updateExternalMcpServer(${JSON.stringify(id)}, { symonInjection: true })`);
    const restored = await (await call('/api/symon/mcp/call', operator, echo)).json() as typeof called;
    expect(restored.ok).toBe(true);
    const second = Number(readFileSync(files('first').SYMON_MCP_PID_FILE, 'utf8'));
    expect(second).not.toBe(first);
    expect(alive(second)).toBe(true);

    // A removal written by another process: the owner refuses the tool and stops the child.
    await registry(`(s) => s.removeExternalMcpServer(${JSON.stringify(id)})`);
    const removed = await call('/api/symon/mcp/call', operator, echo);
    expect(removed.status).toBe(400);
    expect((await removed.json() as { error: string }).error).toContain('Unknown or unavailable connected MCP tool');
    await waitFor(() => !alive(second));
    expect(((await (await call('/api/symon/mcp/tools', operator)).json()) as { tools: unknown[] }).tools).toEqual([]);

    for (const body of [catalog, called, forwarded, restored]) expect(JSON.stringify(body)).not.toContain(SENTINEL);
  } finally {
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
