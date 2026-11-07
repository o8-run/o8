import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOwnedAcpSessionStore } from '@/lib/runtimes/shared/owned-acp/store';
import { readSharedCheckoutTeam, recordSharedCheckoutMember, reserveSharedCheckoutMember, settleSharedCheckoutTeam } from '@/lib/orchestrator/shared-checkout-team';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-team-interrupt-')));
const data = join(root, 'data');
const repoPath = join(data, 'repo');
const children = new Set<number>();
const parentThreadId = 'thoughts-interrupt-owner';

beforeAll(() => {
  mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: repoPath });
  vi.stubEnv('O8_DATA_DIR', data);
  vi.stubEnv('O8_OWNED_PI_ROOT', join(data, 'owned-pi'));
});

afterAll(async () => {
  for (const pid of children) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
  await new Promise(resolve => setTimeout(resolve, 100));
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function fixture(runtime: string) {
  const binary = join(root, `${runtime}.mjs`);
  const ready = join(root, `${runtime}.ready`);
  const signalled = join(root, `${runtime}.signalled`);
  const release = join(root, `${runtime}.release`);
  writeFileSync(binary, `#!${process.execPath}
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('pi 1.0.2'); process.exit(0); }
const send = value => console.log(JSON.stringify(value));
const stop = () => {
  writeFileSync(${JSON.stringify(signalled)}, 'signal');
  setInterval(() => {
    if (existsSync(${JSON.stringify(release)})) {
      process.removeAllListeners('SIGINT');
      process.kill(process.pid, 'SIGINT');
    }
  }, 10);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (message.method === 'session/new') send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fixture' } });
  if (message.type === 'prompt' || message.method === 'session/prompt') writeFileSync(${JSON.stringify(ready)}, String(process.pid));
});
`);
  chmodSync(binary, 0o755);
  return { binary, ready, signalled, release };
}

describe.skipIf(process.platform === 'win32')('shared team interrupt process exit proof', () => {
  // Pi still clears its run on interrupt before the child exits; holding it
  // safely needs disk-merged exit handling (tracked on #5654).
  it.each(['acp'])('holds a %s claim while its real child delays exit after interruption', async runtime => {
    const stub = fixture(runtime);
    const clientMutationId = `interrupt-${runtime}`;
    const input = { repoPath, parentThreadId, dataDir: data };
    await reserveSharedCheckoutMember({ ...input, runtime, clientMutationId, taskName: runtime, paths: [`src/${runtime}.ts`] });
    let surfaceId: string;
    let interrupt: () => Promise<unknown>;
    if (runtime === 'pi') {
      vi.stubEnv('O8_PI_BIN', stub.binary);
      const pi = await import('@/lib/pi/owned');
      const launched = await pi.launchOwnedPiSession({ cwd: repoPath, prompt: 'Wait', clientMutationId });
      expect(launched.ok).toBe(true);
      surfaceId = launched.surfaceId!;
      interrupt = () => pi.interruptOwnedPiSession(surfaceId);
    } else {
      const store = createOwnedAcpSessionStore({
        runtimeId: 'grok', surfaceIdPrefix: 'grok-owned:', sessionIdPrefix: 'grok-owned-',
        rootEnvVar: 'O8_OWNED_GROK_ROOT', rootDefault: join(data, 'owned-grok'),
        binaryName: 'fixture', humanLabel: 'Fixture', squadShortName: 'Fixture',
        resolveLaunch: async () => ({ command: process.execPath, args: [stub.binary] }),
        parseRunLog: () => ({ entries: [], completedTurn: false }),
      });
      const launched = await store.launch({ cwd: repoPath, prompt: 'Wait', clientMutationId });
      expect(launched.ok).toBe(true);
      surfaceId = launched.surfaceId!;
      interrupt = () => store.interrupt(surfaceId);
    }
    await recordSharedCheckoutMember({ ...input, runtime, clientMutationId, taskName: runtime, surfaceId });
    await vi.waitFor(() => expect(existsSync(stub.ready)).toBe(true));
    const pid = Number(readFileSync(stub.ready, 'utf8'));
    children.add(pid);
    const stopping = interrupt();
    try {
      await vi.waitFor(() => expect(existsSync(stub.signalled)).toBe(true));
      expect(() => process.kill(pid, 0)).not.toThrow();
      await settleSharedCheckoutTeam(input);
      expect(readSharedCheckoutTeam(input)?.members.find(member => member.surfaceId === surfaceId)?.state).toBe('running');
      await expect(reserveSharedCheckoutMember({ ...input, runtime, clientMutationId: `${clientMutationId}-overlap`,
        taskName: 'overlap', paths: [`src/${runtime}.ts`] })).rejects.toThrow('overlaps worker');
    } finally { writeFileSync(stub.release, 'exit'); await stopping; }
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    children.delete(pid);
    await vi.waitFor(async () => {
      await settleSharedCheckoutTeam(input);
      expect(readSharedCheckoutTeam(input)?.members.find(member => member.surfaceId === surfaceId)).toMatchObject({ state: 'failed', settledOutcome: 'interrupted' });
    });
    await expect(reserveSharedCheckoutMember({ ...input, runtime, clientMutationId: `${clientMutationId}-retry`,
      taskName: 'retry', paths: [`src/${runtime}.ts`] })).resolves.toBeDefined();
  });
});
