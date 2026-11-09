import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// The o8 MCP message tools call /api/agents/{message,inbox,presence} on the API port. With Next
// stopped the WS listener must serve them, with the same split: a packet worker messages agents
// in its own lane's repository, presence join and history are the operator's, and every other
// credential is refused.
it.skipIf(process.platform === 'win32')('serves the agent bus natively with Next stopped (#5576)', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-agent-bus-')));
  const device = 'agent-bus-fixture-device-0123456789abcdef';
  const unbound = 'agent-bus-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), unbound);
  const repo = join(directory, 'repo-shared');
  const otherRepo = join(directory, 'repo-other');
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const env = { ...process.env, O8_DATA_DIR: directory, CORTEX_IDE_DATA_DIR: directory,
      CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'), WS_TOKEN: server.token };
    const seeded = await promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--eval', `
      const { createLane } = require('./src/lib/lane/registry.ts');
      const { mintPacketWorkerToken } = require('./src/lib/auth/packet-worker-token.ts');
      const sender = createLane({ repoPath: ${JSON.stringify(repo)}, branch: 'fixture-bus-sender', runtime: 'codex', packetId: 'fixture-bus-sender' });
      const outsider = createLane({ repoPath: ${JSON.stringify(otherRepo)}, branch: 'fixture-bus-outsider', runtime: 'codex', packetId: 'fixture-bus-outsider' });
      console.log('seed ' + JSON.stringify({ sender: mintPacketWorkerToken(sender.packetId), outsider: mintPacketWorkerToken(outsider.packetId) }));
      require('./src/lib/db/index.ts').closeDb();
    `], { env });
    const tokens = JSON.parse(seeded.stdout.split('\n').find(line => line.startsWith('seed '))!.slice(5)) as { sender: string; outsider: string };
    const call = (method: string, path: string, bearer: string | null, body?: unknown) => fetch(`${origin}${path}`, {
      method,
      headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const presencePath = `/api/agents/presence?repo=${encodeURIComponent(repo)}`;
    const send = { to: 'Receiver', text: 'Native bus fixture message.' };

    // The operator joins a receiver in the shared repository.
    const joined = await call('POST', '/api/agents/presence', server.token, { agentId: 'fixture-receiver', name: 'Receiver',
      repo, worktreePath: join(repo, 'receiver'), runtime: 'claude-code', sessionKey: 'claude-code:fixture-receiver' });
    expect(joined.status).toBe(201);

    // A packet worker sees its repository's agents and messages one of them.
    const presence = await call('GET', presencePath, tokens.sender);
    expect(presence.status).toBe(200);
    expect((await presence.json()).agents).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Receiver' })]));
    const sent = await call('POST', '/api/agents/message', tokens.sender, send);
    expect(sent.status).toBe(201);
    // The fixture receiver has no live terminal, so live delivery is deferred and the message is
    // kept for the receiver's inbox, from the WS process as from Next.
    expect(await sent.json()).toMatchObject({ ok: true, message: { to: 'Receiver', text: send.text, delivery: 'poll' } });
    expect((await call('GET', '/api/agents/inbox', tokens.sender)).status).toBe(200);
    const inbox = await call('GET', '/api/agents/inbox?agentId=fixture-receiver', server.token);
    expect(inbox.status).toBe(200);
    expect(JSON.stringify(await inbox.json())).toContain(send.text);
    const history = await call('GET', '/api/agents/message?scope=all', server.token);
    expect(history.status).toBe(200);

    // A packet worker from another repository cannot inspect this one.
    const foreign = await call('GET', presencePath, tokens.outsider);
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ error: { code: 'agent_repo_mismatch' } });

    // Lesser credentials are refused: at the gate, or by the service for a worker with no packet.
    for (const [method, path] of [['GET', presencePath], ['POST', '/api/agents/message'], ['GET', '/api/agents/inbox']] as const) {
      const body = method === 'POST' ? send : undefined;
      expect((await call(method, path, null, body)).status, `${method} ${path} anonymous`).toBe(401);
      expect((await call(method, path, device, body)).status, `${method} ${path} device`).toBe(403);
    }
    expect((await call('POST', '/api/agents/presence', tokens.sender, { agentId: 'x', name: 'x', repo })).status).toBe(403);
    expect((await call('GET', '/api/agents/message?scope=all', tokens.sender)).status).toBe(403);
    const unboundSend = await call('POST', '/api/agents/message', unbound, send);
    expect(unboundSend.status).toBe(403);
    expect(await unboundSend.json()).toMatchObject({ error: { code: 'agent_bus_packet_required' } });
  } finally {
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
