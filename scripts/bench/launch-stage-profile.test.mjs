import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectLaunchStageProfile } from './launch-stage-summary.mjs';

test('observes real listener, request and module-load work in a private server process', { timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-launch-stage-test-'));
  const observer = fileURLToPath(new URL('./launch-stage-preload.cjs', import.meta.url));
  fs.writeFileSync(path.join(root, 'slow.cjs'), 'const end = performance.now() + 30; while (performance.now() < end) {} module.exports = 1;');
  fs.writeFileSync(path.join(root, 'server.js'), `require('./slow.cjs');
    const server = require('node:http').createServer((req, res) => setTimeout(() => res.end('ok'), 25));
    server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));`);
  const started = Date.now();
  const child = spawn(process.execPath, ['--require', observer, path.join(root, 'server.js')], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, O8_DATA_DIR: root, O8_LAUNCH_CPU_PROFILE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const [chunk] = await once(child.stdout, 'data');
    const { port } = JSON.parse(String(chunk));
    for (const headers of [{}, { Accept: 'text/html' }]) {
      const response = await fetch(`http://127.0.0.1:${port}/dashboard`, { headers });
      assert.equal(await response.text(), 'ok');
    }
    const [result] = await collectLaunchStageProfile(root, started);
    assert.equal(result.role, 'http');
    assert.equal(result.listeners.length, 1);
    assert(result.listeners[0].atMs >= result.entryMs);
    assert.deepEqual(result.requests.map(row => row.caller), ['background', 'webview']);
    assert(result.requests.every(row => row.route === '/dashboard' && row.complete && row.durationMs >= 15));
    assert(result.modules.some(row => row.owner.includes('slow.cjs') && row.exclusiveMs >= 25));
    assert(result.cpu.length > 0);
  } finally {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 3000);
    if (child.exitCode === null && child.signalCode === null) await exited;
    clearTimeout(force);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
