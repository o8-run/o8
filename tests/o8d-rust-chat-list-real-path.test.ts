import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { CHAT_LIST_PARAMETERS, generateRequests, mismatchReceipt, normalize, seedSessionFixture, send, startSessionServer } from '../scripts/o8d/parity';
import { seedChatListEdges } from '../scripts/o8d/chat-list-fixture';

const targetDir = join(process.cwd(), 'crates/o8d/target/session-reads');
const binary = process.env.O8D_TEST_BINARY ?? process.env.O8D_BINARY ?? join(targetDir, 'debug', process.platform === 'win32' ? 'o8d.exe' : 'o8d');
beforeAll(async () => {
  if (process.env.O8D_TEST_BINARY || process.env.O8D_BINARY) return;
  await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--target-dir', targetDir],
    { maxBuffer: 64 * 1024 * 1024 });
}, 900_000);

it('matches the TypeScript chat-list oracle on 500 seeded requests through the public socket with Next stopped', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-chat-list-parity-')));
  let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  try {
    await seedSessionFixture(directory);
    seedChatListEdges(directory);
    const requests = generateRequests({ path: '/api/v2/chat-history/list', parameters: CHAT_LIST_PARAMETERS, count: 500 });
    const recorded: Array<{ status: number; body: unknown }> = [];
    server = await startSessionServer(directory, false, binary);
    for (const request of requests) {
      const response = await send(server, request.path);
      expect(response.native).toBe(false);
      recorded.push({ status: response.status, body: normalize(response.body) });
    }
    await server.stop(); server = undefined;
    server = await startSessionServer(directory, true, binary);
    for (const request of requests) {
      const response = await send(server, request.path);
      expect(response.native, `Native route was not reached: /api/v2/chat-history/list; seed=${request.seed} case=${request.caseIndex}`).toBe(true);
      const difference = mismatchReceipt(request, recorded[request.caseIndex], { status: response.status, body: normalize(response.body) });
      expect(difference, difference ? JSON.stringify(difference) : undefined).toBeNull();
    }
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 300_000);
