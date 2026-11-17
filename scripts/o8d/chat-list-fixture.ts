/** Synthetic saved-store edge cases shared by capture and public-socket replay. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export function seedChatListEdges(directory: string) {
  const probe = 'Reply with exactly: terminal chat is connected';
  const cases: Array<[string, Record<string, unknown>]> = [
    ['mobile-chat-plain', {}],
    ['mobile-chat-archived', { archivedAt: '2026-10-02T00:00:00.000Z' }],
    ['mobile-chat-starred', { starred: true }],
    ['mobile-chat-assistant', { model: 'o8-operator' }],
    ['mobile-chat-probe', { title: '', messages: [{ role: 'user', content: `\ufeff${probe}!\ufeff`, timestamp: 1790812800000 }] }],
    ['mobile-chat-real-punctuation', { title: '', messages: [{ role: 'user', content: `${probe}!!`, timestamp: 1790812800000 }] }],
    ['mobile-chat-real-whitespace', { title: '', messages: [{ role: 'user', content: probe.replace(': ', ':\u0085'), timestamp: 1790812800000 }] }],
    ['mobile-chat-trim', { model: '\ufeff fixture-model \ufeff', agent: '\ufeff agent \ufeff', projectId: '\ufeff project \ufeff' }],
    ['mobile-chat-unpin', { pinned: true }],
    ['mobile-chat-settled', {}],
    ['thoughts-legacy-title', { title: '\ufeffOrchestrator session · 2026-10-01 00:00\ufeff', model: '', backend: 'claude' }],
    ['mobile-chat-long', { messages: [{ role: 'user', content: '雪'.repeat(501), timestamp: 1790812800000 }] }],
  ];
  for (const [id, fields] of cases) {
    writeFileSync(join(directory, 'chat-history', `${id}.json`), JSON.stringify({
      title: 'Fixture review 雪', model: 'fixture-model', backend: 'claude', savedAt: '2026-10-01T00:00:00.000Z',
      messages: [{ id: 'fixture-message', role: 'user', content: 'Fixture repository review 雪', timestamp: 1790812800000 }], ...fields,
    }));
  }
  const db = new Database(join(directory, 'cortex-ide.db'));
  try {
    const insert = db.prepare('INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)');
    for (const [id, state] of [
      ['mobile-chat-unpin', { pinnedAt: null, inboxRevision: null, settledAt: null }],
      ['mobile-chat-settled', { settledOverride: 'settled', settledAt: '2026-10-02T00:00:00.000Z',
        autoSettledAt: '2026-10-02T00:00:00.000Z', autoSettledReason: 'completed', inboxRevision: 2 }],
    ] as const) insert.run(`inbox:subject:${JSON.stringify(['conversation', null, id])}`, JSON.stringify(state), '2026-10-01T00:00:00.000Z');
  } finally { db.close(); }
}
