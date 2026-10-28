import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/repos/repo-path-registry', () => ({ resolveRepoPathFromRegistry: async (repoRoot: string) => ({ ok: true, repoRoot }) }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => true) }));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-compaction-turn-race-')));
const repoPath = join(root, 'repo'); mkdirSync(repoPath);
const entered = join(root, 'entered'); const release = join(root, 'release');
const binary = join(root, 'summarizer.mjs');
writeFileSync(binary, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('codex-cli 0.161.0'); process.exit(0); }
writeFileSync(${JSON.stringify(entered)}, 'started');
while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Decisions made\\n- Keep the sample decision.\\nFiles touched\\n- None.\\nOpen questions\\n- None.\\nCurrent mission state\\n- Continue the new turn.' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 40 } }));
`); chmodSync(binary, 0o700);
vi.stubEnv('O8_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DB_PATH', join(root, 'data.db'));
vi.stubEnv('O8_CODEX_BIN', binary);
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { persistCanonicalChatHistoryRecord, readPersistedLlmChat } = await import('@/lib/llm/chat-history-store');
const compactRoute = await import('@/app/api/orchestrator/compact/route');
const { POST } = compactRoute;
const { closeDb } = await import('@/lib/db');
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it('preserves a follow-up and its completed turn admitted while the real compactor process holds an older history snapshot', async () => {
  await updateOperatorDefaults({ inAppOrchestratorEnabled: true, productTelemetryEnabled: false });
  const threadId = 'thoughts-compaction-turn-race';
  const messages = Array.from({ length: 12 }, (_, index) => ({ id: `before-${index}`, role: index % 2 ? 'assistant' : 'user',
    content: `Sample turn ${index}`, timestamp: Date.now() - 12_000 + index * 100 }));
  persistCanonicalChatHistoryRecord(threadId, { repoPath, backend: 'codex', messages });
  const running = POST(new NextRequest('http://localhost/api/orchestrator/compact', { method: 'POST',
    headers: { host: 'localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ repoPath, threadId, trigger: 'manual' }) }));
  try {
    await vi.waitFor(() => expect(existsSync(entered)).toBe(true), { timeout: 10_000 });
    const current = readPersistedLlmChat(threadId)!.history;
    persistCanonicalChatHistoryRecord(threadId, { ...current, title: 'Latest conversation title', messages: [...current.messages,
      { id: 'composer-queued-follow-up', role: 'user', content: 'Keep the follow-up.', timestamp: Date.now() },
      { id: 'follow-up-completed', role: 'assistant', content: 'The follow-up completed.', timestamp: Date.now() + 1 }] });
    writeFileSync(release, 'continue');
    const response = await running;
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    const saved = readPersistedLlmChat(threadId)!.history;
    expect(saved.messages.filter(message => message.id === 'composer-queued-follow-up')).toHaveLength(1);
    expect(saved.messages.filter(message => message.id === 'follow-up-completed')).toHaveLength(1);
    expect(saved.title).toBe('Latest conversation title');
    const getStatus = Reflect.get(compactRoute, 'GET');
    if (typeof getStatus === 'function') {
      const receipt = (await (await getStatus(new NextRequest(`http://localhost/api/orchestrator/compact?${new URLSearchParams({ repoPath, threadId })}`))).json()).operation;
      console.log('Measured scripted compaction:', JSON.stringify({ phase: receipt.phase,
        waitingMs: receipt.startedAt - receipt.requestedAt, compactingMs: receipt.settledAt - receipt.startedAt,
        preservedFollowUps: 1, preservedCompletedTurns: 1 }));
    }
    const archive = (await response.json()).archiveRef;
    expect(JSON.parse(readFileSync(join(root, 'orchestrator-archives', archive), 'utf8')).turns.length).toBeGreaterThan(0);
  } finally { writeFileSync(release, 'continue'); await running; }
}, 20_000);
