// Real owned-session launch/reconciliation host. Only the provider is synthetic.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOwnedSessionStore } from '../../src/lib/runtimes/shared/owned-session/store';

async function main() {
  const root = process.env.O8_STDIN_FIXTURE_ROOT!;
  const server = createServer((_request, response) => response.end('{}'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.O8_API_PORT = String((server.address() as { port: number }).port);
  const store = createOwnedSessionStore({
    runtimeId: 'test-stdin', surfaceIdPrefix: 'test-stdin-owned:',
    rootEnvVar: 'O8_STDIN_SESSION_ROOT', rootDefault: join(root, 'sessions'),
    binaryName: 'node', binaryEnvOverride: 'O8_STDIN_NODE', humanLabel: 'Stdin fixture', squadShortName: 'Stdin',
    launchArgs: () => [join(process.cwd(), 'tests/fixtures/owned-stdin-worker.cjs'), root, process.env.O8_STDIN_FIXTURE_MODE!],
    launchStdin: ({ prompt }) => JSON.stringify({ prompt, context: 'x'.repeat(4 * 1024 * 1024) }) + '\n',
    resumeArgs: () => null,
    parseRunLog: raw => ({ entries: [], outcome: raw.includes('complete') ? 'finished' : 'running',
      completedTurn: raw.includes('complete') }),
  });
  process.on('message', async (message: { action: string; surfaceId?: string }) => {
    try {
      if (message.action === 'launch') {
        const result = await store.launch({ cwd: join(root, 'repo'), prompt: 'Deliver all staged context.' });
        if (!result.ok) throw new Error(result.note);
        const sessionPath = join(root, 'sessions', result.surfaceId.split(':')[1], 'session.json');
        process.send?.({ sessionPath, session: JSON.parse(readFileSync(sessionPath, 'utf8')) });
      } else {
        if (message.action === 'interrupt') {
          const result = await store.interrupt(message.surfaceId!);
          if (!result.interrupted) throw new Error(result.note);
        }
        await store.getReviewPacket(message.surfaceId!);
        const sessionPath = join(root, 'sessions', message.surfaceId!.split(':')[1], 'session.json');
        process.send?.({ sessionPath, session: JSON.parse(readFileSync(sessionPath, 'utf8')) });
      }
    } catch (error) { process.send?.({ error: String(error) }); }
  });
  process.send?.({ ready: true });
}
void main().catch(error => { console.error(error); process.exit(1); });
