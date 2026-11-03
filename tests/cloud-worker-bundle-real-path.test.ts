import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

const bundle = join(process.cwd(), 'dist/worker/o8-worker.mjs');
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !/^(?:O8_|CORTEX_|NODE_OPTIONS$|NODE_PATH$)/.test(name)
  ))),
  NODE_ENV: 'test',
};

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-worker.mjs'], { stdio: 'pipe' });
});

describe('bundled cloud worker startup', () => {
  it('loads its dependencies before reporting missing arguments', () => {
    const result = spawnSync(process.execPath, [bundle], { env, encoding: 'utf8', timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('[worker] fatal: [worker] --o8-url is required\n');
  });

  it.skipIf(process.platform === 'win32')('starts the real entry point, persists state, polls and shuts down', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'o8-worker-bundle-'));
    const polls: string[] = [];
    const server = createServer((request, response) => {
      polls.push(request.url ?? '');
      response.writeHead(204);
      response.end();
    });
    let child: ReturnType<typeof spawn> | undefined;
    let exited: Promise<unknown[]> | undefined;
    let output = '';
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      child = spawn(process.execPath, [
        bundle, '--o8-url', `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        '--workspace-dir', workspace, '--worker-id', 'bundle-fixture', '--poll-interval-ms', '60000',
      ], {
        env: { ...env, O8_CLOUD_WORKER_KEY: 'cwk_bundle_fixture', CORTEX_IDE_DATA_DIR: workspace },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      exited = once(child, 'close');
      child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString(); });

      await expect.poll(() => polls.length > 0 || child!.exitCode !== null, { timeout: 10_000 }).toBe(true);
      expect(output).toContain('[worker] online as bundle-fixture; polling durable cloud queue');
      expect(polls).toHaveLength(1);
      const poll = new URL(polls[0], 'http://localhost');
      expect(poll.pathname).toBe('/api/cloud/worker-poll');
      expect(poll.searchParams.get('workerId')).toBe('bundle-fixture');
      expect(poll.searchParams.get('cursor')).toBe('0');
      expect(JSON.parse(readFileSync(join(workspace, 'worker-state.json'), 'utf8'))).toEqual({
        workerId: 'bundle-fixture', cursor: 0,
      });

      child.kill('SIGTERM');
      await expect.poll(() => child!.exitCode, { timeout: 5_000 }).toBe(0);
      await exited;
      expect(output).toContain('[worker] shutdown complete');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
