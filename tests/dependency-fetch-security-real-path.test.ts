import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Each package resolves its own installed fetch implementation. A subprocess is
// essential: the vulnerable implementation emits an unhandled stream error even
// when its caller catches the fetch rejection.
const consumerRoots = [
  '@ai-sdk/provider-utils',
  '@earendil-works/pi-coding-agent',
  'jsdom',
  'node-gyp',
];

const fixture = String.raw`
  const { createServer } = require('node:http');
  const { gzipSync } = require('node:zlib');
  const { fetch, Agent } = require(process.argv[1]);
  const dispatcher = new Agent();
  const server = createServer((request, response) => {
    if (request.url === '/truncated') {
      response.writeHead(200, {
        'content-encoding': Array(6).fill('gzip').join(', '),
        'content-length': '100',
        connection: 'close',
      });
      response.flushHeaders();
      response.socket.end();
    } else {
      response.writeHead(200, { 'content-encoding': 'gzip' });
      response.end(gzipSync('healthy response'));
    }
  });
  server.listen(0, '127.0.0.1', async () => {
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
      let refused = false;
      try {
        const response = await fetch(origin + '/truncated', { dispatcher });
        await response.text();
      } catch {
        refused = true;
      }
      if (!refused) throw new Error('excessive encoding was accepted');
      const response = await fetch(origin + '/healthy', { dispatcher });
      if (await response.text() !== 'healthy response') throw new Error('normal fetch failed');
      // Closing the dispatcher settles the rejected response as well as the
      // successful control before reporting that the process survived.
      await dispatcher.close();
      server.close(() => process.stdout.write('refused; healthy response; settled\n'));
    } catch (error) {
      console.error('[dependency-fetch-security]', error.message);
      await dispatcher.destroy();
      server.close(() => { process.exitCode = 1; });
    }
  });
`;

describe('installed dependency fetch rejects excessive encodings without crashing', () => {
  it.each(consumerRoots)('%s survives a truncated hostile response and serves the next request', (consumer) => {
    const consumerRequire = createRequire(resolve('node_modules', consumer, 'package.json'));
    const result = spawnSync(process.execPath, ['-e', fixture, consumerRequire.resolve('undici')], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('refused; healthy response; settled\n');
  });
});
