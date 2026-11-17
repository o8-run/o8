import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { firstDifference, normalize, seedSessionFixture, send, startSessionServer } from '../scripts/o8d/parity';

const binary = process.env.O8D_TEST_BINARY ?? join(process.cwd(), 'crates/o8d/target/session-reads/debug/o8d');
it('keeps linked-work key presence and the chosen machine name through the public socket', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-thread-projection-')));
  let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  try {
    await seedSessionFixture(directory);
    writeFileSync(join(directory, 'computer-name'), 'Fixture computer\nignored line');
    const path = '/api/mobile/orchestrator/threads?limit=500';
    server = await startSessionServer(directory, false, binary);
    const expected = await send(server, path);
    await server.stop(); server = undefined;
    server = await startSessionServer(directory, true, binary);
    const actual = await send(server, path);
    expect(actual.native).toBe(true);
    expect(firstDifference(normalize(expected.body), normalize(actual.body))).toBeNull();
    const body = actual.body as { threads: Array<Record<string, unknown>> };
    expect(body.threads.length).toBeGreaterThan(0);
    for (const thread of body.threads) {
      expect(thread.machineDisplayName).toBe('Fixture computer');
      expect(thread).toHaveProperty('linkedWork');
    }
    expect(Object.keys(body.threads[0]).sort()).toMatchSnapshot('mobile thread response keys');
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 180_000);
