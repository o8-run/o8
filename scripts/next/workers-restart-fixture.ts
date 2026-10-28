/** Owned route process for the native Workers restart regression. */
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { NextRequest } from 'next/server';

async function main() {
  const repo = process.env.O8_NEXT_STEER_REPO!;
  const deliveries = process.env.O8_NEXT_STEER_DELIVERIES!;
  if (!repo || !deliveries || !process.send) throw new Error('Missing owned restart fixture context');
  const { isolateTranscriptDiscovery } = await import('./transcript-fixtures');
  await isolateTranscriptDiscovery(false);
  const { getRuntime } = await import('../../src/lib/runtimes');
  const runtime = getRuntime('pi')!;
  runtime.discoverSessions = async () => [{ sessionKey: 'fixture:worker-blocked', runtimeId: 'pi',
    displayName: 'Fixture worker', cwd: repo, branch: 'worker-blocked', status: 'idle', ownership: 'owned',
    sessionCapabilities: { canSendInput: true, canInterrupt: false, canReviewDiffs: true }, lastActivityAt: new Date() }];
  runtime.resume = async (sessionKey, message) => {
    appendFileSync(deliveries, JSON.stringify({ sessionKey, message }) + '\n');
    // Exit after the external effect, before either production receipt finalizes.
    if (process.env.O8_NEXT_STEER_CRASH === '1') process.exit(74);
    return { ok: true, note: 'Fixture accepted', sessionKey };
  };
  const { POST } = await import('../../src/app/api/orchestrator/steer-packet/route');
  const { drainQueuedPacketSteers } = await import('../../src/lib/orchestrator/operator-mission-service/steer-queue');
  // Use the production wake path to quarantine an abandoned sending claim.
  await drainQueuedPacketSteers();
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      const url = `http://${req.headers.host}/api/orchestrator/steer-packet`;
      const request = new NextRequest(url, { method: 'POST', body,
        headers: { 'content-type': 'application/json', 'x-o8-client-addr': '127.0.0.1',
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) } });
      const response = await POST(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error(error); res.writeHead(500).end('restart fixture failed');
    }
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing restart fixture port');
    process.send!({ origin: `http://127.0.0.1:${address.port}` });
  });
  process.once('disconnect', () => process.exit(0));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
