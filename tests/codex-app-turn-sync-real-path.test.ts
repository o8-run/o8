import { appendFileSync, chmodSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';

// #3573 follow-up: turns the operator adds from the Codex app (desktop or phone)
// appear in the o8 chat. The sync, its app-server reader, the history files and
// the change detection are real; only the Codex executable is a fixture.
const root = mkdtempSync(join(getDataDir(), 'codex-app-turn-sync-'));
const binary = join(root, 'codex');
const rollout = join(root, 'rollout.jsonl');
const turnsFile = join(root, 'turns.json');
writeFileSync(rollout, '{}\n');
vi.stubEnv('O8_CODEX_BIN', binary);
// Provider children inherit only allowlisted environment names. Keep these
// fixture-owned paths in the generated CLI rather than its ambient environment.
writeFileSync(binary, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.161.0'); process.exit(0); }
let buffer = '';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (message.method === 'initialize') send({ id: message.id, result: {} });
    if (message.method === 'thread/read') send({ id: message.id, result: { thread: { id: message.params.threadId, path: ${JSON.stringify(rollout)} } } });
    if (message.method === 'thread/turns/list') {
      send({ id: message.id, result: { data: JSON.parse(readFileSync(${JSON.stringify(turnsFile)}, 'utf8')), nextCursor: null } });
    }
  }
});
`);
chmodSync(binary, 0o700);

const history = await import('@/lib/mobile/orchestrator-thread-history');
const sync = await import('@/lib/codex/app-thread-sync');

const tabId = 'thoughts-codex-app-sync-1';
const repoPath = join(root, 'repo');

function turn(id: string, status: string, user: string, agent: string | null) {
  return {
    id, status, startedAt: 1_791_850_000, completedAt: status === 'inProgress' ? null : 1_791_850_010,
    items: [
      { type: 'userMessage', id: `${id}-u`, content: [{ type: 'text', text: user, text_elements: [] }] },
      ...(agent === null ? [] : [{ type: 'agentMessage', id: `${id}-a`, text: agent }]),
    ],
  };
}
function setTurns(turns: unknown[]): void {
  writeFileSync(turnsFile, JSON.stringify(turns));
  appendFileSync(rollout, '{}\n');
}
function transcript(): Array<{ role: string; content: string }> {
  return history.readOrchestratorThreadMessages(tabId)
    .map((message) => ({ role: message.role, content: message.content }));
}
const imported: Array<[string, number]> = [];
const deps = (busy = false) => ({
  isBusy: () => busy,
  openReader: sync.openCodexAppThreadReader,
  onImported: (id: string, count: number) => { imported.push([id, count]); },
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('Codex app turns in the o8 chat (#3573)', () => {
  it('imports a turn added from the Codex app once, after the turns o8 ran', async () => {
    history.appendMobileOrchestratorUserMessage({ tabId, repoPath, message: 'What is running?', backend: 'codex' });
    history.upsertMobileOrchestratorAssistantMessage({ tabId, repoPath, messageId: 'o8-answer', content: 'Two lanes.', backend: 'codex' });
    sync.noteCodexAppTurn({ tabId, repoPath, threadId: 'thread-1', turnId: 'turn-o8' });
    setTurns([
      turn('turn-phone', 'completed', 'Sent from my phone', 'Reply in the Codex app'),
      turn('turn-o8', 'completed', 'What is running?', 'Two lanes.'),
    ]);

    await sync.syncCodexAppThreads(deps());

    expect(transcript()).toEqual([
      { role: 'user', content: 'What is running?' },
      { role: 'assistant', content: 'Two lanes.' },
      { role: 'user', content: 'Sent from my phone' },
      { role: 'assistant', content: 'Reply in the Codex app' },
    ]);
    expect(imported).toEqual([[tabId, 1]]);
    expect(sync.readCodexAppSyncState(tabId)).toMatchObject({ threadId: 'thread-1', rolloutPath: rollout, turnIds: ['turn-o8', 'turn-phone'] });

    await sync.syncCodexAppThreads(deps());
    expect(transcript()).toHaveLength(4);
    expect(imported).toHaveLength(1);
  }, 30_000);

  it('waits for a Codex app turn to finish and skips the chat while o8 runs a turn', async () => {
    setTurns([
      turn('turn-phone-2', 'inProgress', 'Second phone message', null),
      turn('turn-phone', 'completed', 'Sent from my phone', 'Reply in the Codex app'),
    ]);
    await sync.syncCodexAppThreads(deps());
    expect(transcript()).toHaveLength(4);

    setTurns([
      turn('turn-phone-2', 'completed', 'Second phone message', 'Second reply'),
      turn('turn-phone', 'completed', 'Sent from my phone', 'Reply in the Codex app'),
    ]);
    await sync.syncCodexAppThreads(deps(true));
    expect(transcript()).toHaveLength(4);

    await sync.syncCodexAppThreads(deps());
    expect(transcript().slice(-2)).toEqual([
      { role: 'user', content: 'Second phone message' },
      { role: 'assistant', content: 'Second reply' },
    ]);
    expect(imported.at(-1)).toEqual([tabId, 1]);
  }, 30_000);

  // #3628: read from a second app-server, a turn still running in the Codex app
  // reports `interrupted` with no reply until it finishes.
  it('keeps a running turn that reads as interrupted out of the chat until it completes', async () => {
    setTurns([
      turn('turn-phone-3', 'interrupted', 'Third phone message', null),
      turn('turn-phone-2', 'completed', 'Second phone message', 'Second reply'),
    ]);
    await sync.syncCodexAppThreads(deps());
    expect(transcript()).toHaveLength(6);

    setTurns([
      turn('turn-phone-3', 'completed', 'Third phone message', 'Third reply'),
      turn('turn-phone-2', 'completed', 'Second phone message', 'Second reply'),
    ]);
    await sync.syncCodexAppThreads(deps());
    expect(transcript().slice(-2)).toEqual([
      { role: 'user', content: 'Third phone message' },
      { role: 'assistant', content: 'Third reply' },
    ]);
  }, 30_000);

  it('imports a turn that stays interrupted once its thread is quiet, then fills in a late reply', async () => {
    setTurns([
      turn('turn-phone-4', 'interrupted', 'Fourth phone message', null),
      turn('turn-phone-3', 'completed', 'Third phone message', 'Third reply'),
    ]);
    await sync.syncCodexAppThreads(deps());
    expect(transcript()).toHaveLength(8);

    const quietSince = new Date(Date.now() - 6 * 60_000);
    utimesSync(rollout, quietSince, quietSince);
    await sync.syncCodexAppThreads(deps());
    expect(transcript().slice(-2)).toEqual([
      { role: 'user', content: 'Fourth phone message' },
      { role: 'assistant', content: '(Codex turn interrupted without a reply)' },
    ]);

    setTurns([
      turn('turn-phone-4', 'completed', 'Fourth phone message', 'Fourth reply'),
      turn('turn-phone-3', 'completed', 'Third phone message', 'Third reply'),
    ]);
    await sync.syncCodexAppThreads(deps());
    expect(transcript()).toHaveLength(10);
    expect(transcript().at(-1)).toEqual({ role: 'assistant', content: 'Fourth reply' });
  }, 30_000);
});
