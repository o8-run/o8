import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';

const tmux = spawnSync('which', ['tmux'], { encoding: 'utf8' }).stdout?.trim();
const directory = mkdtempSync(join(tmpdir(), 'o8-settlement-cli-'));
const data = join(directory, 'data');
mkdirSync(data);
process.env.CORTEX_IDE_DATA_DIR = data;
process.env.O8_DATA_DIR = data;
const route = await import('@/app/api/panel/managed-runs/route');
const { closeDb } = await import('@/lib/db');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const children: ChildProcess[] = [];
let server: Server;
let socket: string;
function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
afterAll(async () => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  if (socket) try { execFileSync(tmux, ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch {}
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  closeDb(); rmSync(directory, { recursive: true, force: true });
});
async function run(bundle: string, env: NodeJS.ProcessEnv, command: string[]) {
  const child = spawn(process.execPath, [bundle, 'run', '--', ...command], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  child.stdout!.on('data', (chunk) => { output += chunk; });
  child.stderr!.on('data', (chunk) => { output += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return { code, output };
}

describe.skipIf(!tmux || process.platform === 'win32')('settlement reservation through the actual CLI, API and durable ledger', () => {
  it('holds launch until persisted registration, replays a lost response, and never relaunches the same generation', async () => {
    socket = join(directory, 'sock');
    const bin = join(directory, 'bin'); mkdirSync(bin);
    const shim = join(bin, 'tmux');
    writeFileSync(shim, `#!/bin/sh\nexec ${quote(tmux)} -S ${quote(socket)} "$@"\n`); chmodSync(shim, 0o700);
    execFileSync(tmux, ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture-keepalive', 'sleep 90']);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    let lost = false;
    let cancelBeforeRetry = false;
    let ignoreBinding = false;
    let registrations = 0;
    server = createServer(async (incoming, outgoing) => {
      let body = ''; for await (const chunk of incoming) body += chunk;
      if (ignoreBinding && body) {
        const input = JSON.parse(body);
        delete input.settlementBinding;
        body = JSON.stringify(input);
      }
      const request = new Request(`http://localhost${incoming.url}`, { method: incoming.method,
        headers: { authorization: incoming.headers.authorization ?? '', 'content-type': 'application/json' },
        ...(incoming.method === 'POST' ? { body } : {}) });
      const result = incoming.method === 'POST' ? await route.POST(request) : await route.GET(request);
      if (body && JSON.parse(body).action === 'register') {
        registrations += 1;
        if (!lost) {
          lost = true;
          if (cancelBeforeRetry) {
            const registered = (await result.clone().json()).run;
            const headers = { authorization: incoming.headers.authorization ?? '', 'content-type': 'application/json' };
            const post = (input: unknown) => route.POST(new Request('http://localhost/api/panel/managed-runs', {
              method: 'POST', headers, body: JSON.stringify(input),
            }));
            const stop = post({ action: 'kill', session: registered.session });
            let current;
            for (let attempt = 0; attempt < 100; attempt += 1) {
              const state = await route.GET(new Request('http://localhost/api/panel/managed-runs', { headers }));
              current = (await state.json()).runs.find((row: { id: string }) => row.id === registered.id);
              if (current?.settlement.stopRequestId) break;
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            const sealed = await post({ action: 'settlement', id: registered.id, bindingDigest: registered.settlement.bindingDigest,
              receiptId: registered.settlement.binding.receiptId, sequence: 1, state: 'quiet', providerSessionId: null,
              cancelledBeforeLaunch: true, stopRequestId: current?.settlement.stopRequestId });
            expect(sealed.status).toBe(200);
            expect((await stop).status).toBe(200);
          }
          incoming.socket.destroy(); return;
        }
      }
      outgoing.writeHead(result.status, { 'content-type': 'application/json' }).end(await result.text());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
    const bundle = join(directory, 'o8.mjs');
    await build({ entryPoints: [join(process.cwd(), 'cli/src/index.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22',
      define: { __O8_CLI_VERSION__: '"fixture"' }, banner: { js: "import { createRequire as __o8_createRequire } from 'node:module'; const require = __o8_createRequire(import.meta.url); globalThis.require = require;" } });
    const bindingFile = join(directory, 'binding.json');
    writeFileSync(bindingFile, JSON.stringify({ schema: 'o8/managed-run-settlement-binding/v1', executionKey: 'fixture-cli', generation: 1,
      branch: 'fixture/cli', providerSessionId: null, profileDigest: 'b'.repeat(64), receiptId: 'fixture-cli-receipt' }));
    const host = join(directory, 'host.mjs');
    writeFileSync(host, `import { appendFileSync } from 'node:fs';
if (process.env.O8_MANAGED_RUN_SETTLEMENT_BINDING) throw new Error('binding path leaked');
appendFileSync(${JSON.stringify(join(directory, 'launches'))}, 'launch\\n');
const endpoint = 'http://127.0.0.1:' + process.env.O8_API_PORT + '/api/panel/managed-runs';
const headers = {authorization:'Bearer ' + process.env.O8_API_TOKEN, 'content-type':'application/json'};
const runs = await (await fetch(endpoint, {headers})).json();
const run = runs.runs.find(r => r.id === process.env.O8_MANAGED_RUN_ID);
const providerSessionId = '00000000-0000-4000-8000-000000000004';
for (const body of [
 {action:'bind-session', id:run.id, bindingDigest:run.settlement.bindingDigest, providerSessionId},
 {action:'settlement', id:run.id, bindingDigest:run.settlement.bindingDigest, providerSessionId, receiptId:'fixture-cli-receipt', sequence:1, state:'quiet'}
]) { const result = await fetch(endpoint, {method:'POST', headers, body:JSON.stringify(body)}); if (!result.ok) throw new Error(await result.text()); }
`);
    const env: NodeJS.ProcessEnv = { ...process.env, O8_MANAGED_RUN_SETTLEMENT_BINDING: bindingFile,
      O8_API_PORT: String(address.port), O8_API_TOKEN: getOrCreateWsToken(), CORTEX_IDE_DATA_DIR: data };
    for (const key of ['O8_WORKER_TOKEN', 'O8_WORKER_PACKET_ID', 'O8_SPECTATOR_TOKEN', 'NODE_OPTIONS']) delete env[key];
    const command = [process.execPath, host];
    const first = await run(bundle, env, command);
    expect(first.code, first.output).toBe(0);
    expect(registrations).toBe(2);
    const replay = await run(bundle, env, command);
    expect(replay.code, replay.output).toBe(0);
    expect(replay.output).toContain('"launched": false');
    expect(readFileSync(join(directory, 'launches'), 'utf8')).toBe('launch\n');
    const persisted = JSON.parse(readFileSync(join(data, 'managed-runs.json'), 'utf8')).runs[0];
    expect(persisted).toMatchObject({ status: 'finished', exitCode: 0, cwd: realpathSync(directory),
      settlement: { providerSessionId: '00000000-0000-4000-8000-000000000004', receipt: { state: 'quiet' } } });
    // A server that accepts unknown fields is not settlement-capable. Never
    // release the host command based only on its historical `ok: true` reply.
    ignoreBinding = true;
    const nextBinding = JSON.parse(readFileSync(bindingFile, 'utf8'));
    nextBinding.generation += 1;
    writeFileSync(bindingFile, JSON.stringify(nextBinding));
    const unsupported = await run(bundle, env, command);
    expect(unsupported.code, unsupported.output).toBe(5);
    expect(unsupported.output).toContain('Settlement-bound run was not started');
    expect(readFileSync(join(directory, 'launches'), 'utf8')).toBe('launch\n');
    // A lost response followed by an operator cancellation must not release
    // the original gated host when the exact registration replay succeeds.
    ignoreBinding = false;
    cancelBeforeRetry = true;
    lost = false;
    nextBinding.generation += 1;
    writeFileSync(bindingFile, JSON.stringify(nextBinding));
    const cancelled = await run(bundle, env, command);
    expect(cancelled.code, cancelled.output).toBe(5);
    expect(cancelled.output).toContain('Settlement-bound run was not started');
    expect(readFileSync(join(directory, 'launches'), 'utf8')).toBe('launch\n');
    const cancelledRecord = JSON.parse(readFileSync(join(data, 'managed-runs.json'), 'utf8')).runs
      .find((row: { settlement?: { binding: { generation: number } } }) => row.settlement?.binding.generation === nextBinding.generation);
    expect(cancelledRecord).toMatchObject({ status: 'killed', settlement: { providerSessionId: null,
      receipt: { state: 'quiet', cancelledBeforeLaunch: true } } });
  }, 30_000);
});
