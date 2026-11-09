import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// A stand-in for `opencode2 acp`: a real child process speaking just enough ACP
// for the model probe. Each mode tries to put the OpenRouter key it was given
// into the reply. Child launches get a curated environment, so paths are written in.
const agent = (mode: string, log: string) => `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const readline = require('node:readline');
const key = process.env.OPENROUTER_API_KEY || '';
const kind = readFileSync(${JSON.stringify(mode)}, 'utf8').trim();
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind, sawKey: key.length > 0 }) + '\\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (kind === 'crash') { process.stderr.write('fatal: rejected key ' + key + '\\n'); process.exit(1); }
readline.createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line);
  if (r.method === 'initialize') return send({ jsonrpc: '2.0', id: r.id, result: { protocolVersion: 1 } });
  if (r.method === 'session/new' && kind === 'error') return send({ jsonrpc: '2.0', id: r.id,
    error: { code: -32000, message: 'provider refused key ' + key, data: { key } } });
  if (r.method === 'session/new') return send({ jsonrpc: '2.0', id: r.id, result: { sessionId: 'fixture', configOptions: [
    { id: 'model', type: 'select', currentValue: 'openrouter/' + key, options: [
      { value: 'openrouter/fixture-a', name: 'Fixture A' },
      { value: 'openrouter/' + key, name: 'Echo ' + key, description: key },
    ] },
  ] } });
  if (r.id != null) send({ jsonrpc: '2.0', id: r.id, result: {} });
});
setTimeout(() => process.exit(0), 10000).unref();
`;

it.skipIf(process.platform === 'win32')('serves the model catalogue with Next stopped, operator-only, and never returns the OpenRouter key', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-backend-models-')));
  const mode = join(directory, 'agent-mode');
  const log = join(directory, 'agent.log');
  const bin = join(directory, 'opencode2');
  writeFileSync(bin, agent(mode, log));
  chmodSync(bin, 0o700);
  writeFileSync(log, '');
  // A fixture key: unique per run, so any appearance in a body is this leak.
  const key = `sk-or-v1-fixture-${randomBytes(16).toString('hex')}`;
  const device = 'backend-models-fixture-device-0123456789abcdef';
  const worker = 'backend-models-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  // The operator's API-billing opt-in for opencode: the only way a launched agent receives a provider key.
  mkdirSync(join(directory, 'runtime-billing'), { mode: 0o700 });
  writeFileSync(join(directory, 'runtime-billing', 'opencode.json'), JSON.stringify({ mode: 'api' }));
  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    Object.assign(process.env, { OPENROUTER_API_KEY: key, O8_OPENCODE_BIN: bin });
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const read = (bearer?: string) => fetch(`${origin}/api/orchestrator/backend-models?backend=opencode&refresh=1`,
      { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });

    // The operator gate holds over the native transport: no grant for a phone or a worker.
    writeFileSync(mode, 'models');
    expect((await read()).status).toBe(401);
    for (const token of [device, worker]) expect((await read(token)).status).toBe(403);
    expect(readFileSync(log, 'utf8'), 'a refused caller never starts the agent').toBe('');

    for (const kind of ['models', 'error', 'crash']) {
      writeFileSync(mode, kind);
      const response = await read(server.token);
      const body = await response.text();
      expect([kind, response.status]).toEqual([kind, 200]);
      expect(body.includes(key), `${kind}: the OpenRouter key reached the body`).toBe(false);
      const payload = JSON.parse(body) as { backend: string; available: boolean; groups: unknown[]; error?: string };
      expect([payload.backend, payload.available]).toEqual(['opencode', true]);
      if (kind === 'models') expect(JSON.stringify(payload.groups)).toContain('fixture-a');
      else expect(payload.error, `${kind} reports a failure`).toBeTruthy();
    }
    // The agent did receive the key, so the absence above is redaction, not a missing secret.
    const runs = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { kind: string; sawKey: boolean });
    expect(runs.map(run => [run.kind, run.sawKey])).toEqual([['models', true], ['error', true], ['crash', true]]);
    // Nothing on disk either: the probe cache holds the redacted catalogue.
    expect(readFileSync(join(directory, 'acp-models', 'opencode.json'), 'utf8').includes(key)).toBe(false);
  } finally {
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
