import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const parityModule = await import(pathToFileURL(join(process.cwd(), 'scripts/o8d/parity.ts')).href);
const parity = parityModule.default ?? parityModule;
const fixtureModule = await import(pathToFileURL(join(process.cwd(), 'tests/fixtures/ws-parity-server.ts')).href);
const fixture = fixtureModule.default ?? fixtureModule;
const { seedSessionFixture, normalize } = parity;
const { startParityReference } = fixture;
const notes = process.env.O8D_PROFILE_OUTPUT!;
assert.ok(notes);
assert.ok(process.env.O8D_TEST_BINARY);
const paths = ['/api/panel/ws-info', '/api/setup/identity'];
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-startup-gates-')));
async function freePort() {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}
const fixedPorts = { api: await freePort(), ws: await freePort() };
const cases = [
  { label: 'missing-bearer', headers: { authorization: '' }, method: 'GET' },
  { label: 'wrong-bearer', headers: { authorization: 'Bearer wrong' }, method: 'GET' },
  { label: 'readonly-bearer', headers: { authorization: 'Bearer o8ro_fixture' }, method: 'GET' },
  { label: 'spoofed-bridge', headers: { authorization: '', 'x-o8d-session-read': 'authorize', 'x-o8d-bridge': 'spoofed', 'x-o8d-peer': '127.0.0.1' }, method: 'GET' },
  { label: 'wrong-host', headers: { host: 'untrusted.invalid', authorization: '' }, method: 'GET' },
  { label: 'cross-origin-write', headers: { origin: 'https://untrusted.invalid', 'content-type': 'application/json' }, method: 'POST' },
];
let server;
const reference: unknown[] = [];
try {
  await seedSessionFixture(directory);
  writeFileSync(join(directory, 'instance-id'), 'fixture-gates-instance\n', { mode: 0o600 });
  writeFileSync(join(directory, 'boot-id'), 'fixture-gates-boot\n', { mode: 0o600 });
  for (const native of [false, true]) {
    server = await startParityReference({ directory, nativeHttp: true, o8d: true, nativeSessionReads: native, fixedPorts,
      binary: process.env.O8D_TEST_BINARY, startupTimeoutMs: 60_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const decisions = [];
    let index = 0;
    for (const path of paths) for (const c of cases) {
      const response = await fetch(origin + path, { method: c.method,
        headers: { authorization: `Bearer ${server.token}`, ...c.headers },
        ...(c.method === 'POST' ? { body: '{}' } : {}) });
      const wire = normalize({ status: response.status, body: await response.json(), headers:
        Object.fromEntries(['content-type','cache-control','access-control-allow-origin','allow'].map(name => [name, response.headers.get(name)])) });
      if (!native) reference.push(wire);
      else assert.deepEqual(wire, reference[index], `Startup decision differs: ${path} ${c.label}`);
      const reached = response.headers.get('x-o8d-native-session-read') === '1';
      assert.equal(reached, false, `${path} ${c.label}: credential cases stay TypeScript-owned`);
      decisions.push({ path, label: c.label, status: response.status, native: reached });
      index++;
    }
    const timings = [];
    for (const path of paths) {
      for (let i = 0; i < 10; i++) {
        const response = await fetch(origin + path, { headers: { authorization: `Bearer ${server.token}` } });
        await response.arrayBuffer();
      }
      const samples = [];
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        const response = await fetch(origin + path, { headers: { authorization: `Bearer ${server.token}` } });
        await response.arrayBuffer();
        const elapsed = performance.now() - start;
        const measured = Object.fromEntries([response.headers.get('server-timing'), response.headers.get('x-o8d-profile')]
          .filter(Boolean).flatMap(header => header!.split(',')).map(part => {
            const [name, duration] = part.trim().split(';dur='); return [name, Number(duration)];
          }));
        const sample = native ? { elapsed, admission: measured.admission, exactReader: measured.exact_reader,
          preflight: measured.preflight, dispatchTotal: measured.reader,
          dispatchOverhead: measured.reader - measured.preflight - measured.exact_reader,
          transportResidual: elapsed - measured.admission - measured.reader } : { elapsed };
        for (const [key, value] of Object.entries(sample)) assert.ok(Number.isFinite(value) && value >= 0, `${path} ${key}: ${value}`);
        samples.push(sample);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('x-o8d-native-session-read') === '1', native, `Native route was not reached: ${path}`);
      }
      const stats = Object.fromEntries(Object.keys(samples[0]).map(key => {
        const values = samples.map(sample => sample[key]).sort((a,b) => a-b);
        return [key, { p50Ms: values[49], p95Ms: values[94], meanMs: values.reduce((a,b) => a+b, 0) / values.length }];
      }));
      timings.push({ path, ...stats, samples });
    }
    const report = { profile: 'release', native, warmups: 10, samples: 100, decisions, timings, exactDecisionComparisons: native ? index : 0 };
    writeFileSync(notes + `startup-gates-${native ? 'native' : 'reference'}.json`, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ native, exactDecisionComparisons: report.exactDecisionComparisons, timings: timings.map(({samples,...timing}) => timing) }));
    await server.stop(); server = undefined;
  }
} finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
