import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

const binary = process.env.O8D_BINARY ?? process.env.O8D_TEST_BINARY
  ?? join(process.env.CARGO_TARGET_DIR ?? 'crates/o8d/target', 'debug', process.platform === 'win32' ? 'o8d.exe' : 'o8d');
const AUDIO = [73, 68, 51, 42];

// A stand-in for python3: it records which process ran it, reports a current
// edge-tts and writes fixed audio, so the test never reaches pip or the network.
// Child launches get a curated environment, so the paths are written in.
const python = (log: string) => `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ parent: process.ppid, args }) + '\\n');
if (args[0] === '-c') process.stdout.write('7.3.1\\n');
else if (args.includes('edge_tts')) process.stdout.write(Buffer.from(${JSON.stringify(AUDIO)}));
`;

it.skipIf(process.platform === 'win32')('serves the voice with Next stopped and keeps one edge-tts owner', async () => {
  if (!existsSync(binary)) await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-ws']);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-tts-owner-')));
  const log = join(directory, 'python.log');
  const interpreter = join(directory, 'python3');
  writeFileSync(interpreter, python(log));
  chmodSync(interpreter, 0o700);
  writeFileSync(log, '');
  // The native Node client needs the network; start this process on the Python tier.
  const preload = join(directory, 'python-tier.cjs');
  writeFileSync(preload, 'globalThis.__o8EdgeTtsNativeDrift = true;\n');
  // An enrolled phone keeps its existing voice grant (DEVICE_CAPABILITIES).
  const device = 'tts-owner-fixture-device-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ o8d: true, binary, nativeHttp: true, directory, preload, ttsPython: interpreter, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const speak = (headers: Record<string, string>, text = 'Native voice check.') => fetch(`${origin}/api/tts`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ text }) });

    const refused = await speak({});
    expect(refused.status, 'the bearer gate still runs').toBe(401);
    const spoken = await speak({ authorization: `Bearer ${server.token}` });
    expect(spoken.status, spoken.status === 200 ? '' : `${await spoken.clone().text()} ${readFileSync(log, 'utf8')}`).toBe(200);
    expect(spoken.headers.get('content-type')).toBe('audio/mpeg');
    expect([...new Uint8Array(await spoken.arrayBuffer())]).toEqual(AUDIO);
    const phone = await speak({ authorization: `Bearer ${device}` }, 'Device voice check.');
    expect(phone.status, 'a device bearer keeps its voice grant').toBe(200);
    expect([...new Uint8Array(await phone.arrayBuffer())]).toEqual(AUDIO);

    // Next's route forwards to the owner instead of running its own installer.
    Object.assign(process.env, { O8_NEXT_O8D: '1', O8_API_PORT: '1', O8_WS_PORT: new URL(origin).port });
    const { POST } = await import('@/app/api/tts/route');
    const forwarded = await POST(new Request('http://127.0.0.1/api/tts', { method: 'POST', headers: {
      authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Forwarded voice check.' }) }));
    expect(forwarded.status).toBe(200);
    expect([...new Uint8Array(await forwarded.arrayBuffer())]).toEqual(AUDIO);

    const runs = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { parent: number; args: string[] });
    expect(runs.filter(run => run.args.includes('edge_tts')).map(run => run.args.at(-3))).toEqual(
      ['Native voice check.', 'Device voice check.', 'Forwarded voice check.']);
    expect(runs.filter(run => run.args[0] === '-c'), 'one installer check for the whole process').toHaveLength(1);
    expect(runs.filter(run => run.args.includes('pip'))).toEqual([]);
    expect(new Set(runs.map(run => run.parent))).toEqual(new Set([server.pid]));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
