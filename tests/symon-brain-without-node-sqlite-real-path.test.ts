import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureV56ManagedSymonMessagesSchema } from '@/lib/db/v56-managed-symon-messages-migration';
import { ManagedSymonMessagesStore } from '@/lib/symon/managed-messages-store';
import { writeSymonTextBrainMode } from '@/lib/symon/durable/text-brain-setting';

const h = vi.hoisted(() => ({ store: null as unknown, readPlanner: vi.fn(), pollTurn: vi.fn() }));

// Node 22 releases before 22.13 have no node:sqlite: loading pi-durable's
// sqlite storage fails the way it does there (#3486).
vi.mock('@earendil-works/pi-durable/storage/sqlite/node', () => {
  throw Object.assign(new Error('No such built-in module: node:sqlite'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
});
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/symon/managed-messages-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/symon/managed-messages-store')>(),
  getManagedSymonMessagesStore: () => h.store,
}));
vi.mock('@/lib/chat/gateway-client', () => ({ generateSharedSymonText: vi.fn() }));
vi.mock('@/lib/mobile/symon-text-bridge-client', () => ({
  readSymonTextPlannerInfo: h.readPlanner,
  pollSymonTextTurn: h.pollTurn,
  pollSymonTextInterrupt: vi.fn(),
}));

let dataDir: string;
let previousDataDir: string | undefined;
let sqlite: Database.Database;

beforeEach(() => {
  vi.resetModules();
  previousDataDir = process.env.CORTEX_IDE_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'symon-no-node-sqlite-'));
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
  sqlite = new Database(':memory:');
  ensureV56ManagedSymonMessagesSchema(sqlite);
  h.store = new ManagedSymonMessagesStore(sqlite);
  h.readPlanner.mockReset();
  h.pollTurn.mockReset();
  delete (globalThis as { __o8SymonBrain?: unknown }).__o8SymonBrain;
});

afterEach(() => {
  delete (globalThis as { __o8SymonBrain?: unknown }).__o8SymonBrain;
  sqlite.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previousDataDir;
});

function request(overrides: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/symon/managed-messages/inbound', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventId: 'imessage:message-1',
      conversationId: 'imessage:direct:+15555550100',
      messageId: 'message-1',
      sender: '+15555550100',
      recipient: 'imessage',
      text: 'What is on my calendar?',
      context: '',
      ...overrides,
    }),
  });
}

describe('Symon routes on a Node without node:sqlite (#3486)', () => {
  it('still answers managed messages on the native planner', async () => {
    h.readPlanner.mockResolvedValue({ available: true, engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', tools: [] });
    h.pollTurn.mockResolvedValue({ state: 'done', result: { status: 'done', text: 'Planner answer.', model: 'gpt-6.1-sol', effort: 'high' } });
    const { POST } = await import('@/lib/symon/http/managed-inbound');

    const response = await POST(request());

    expect(await response.json()).toMatchObject({ ok: true, state: 'done', text: 'Planner answer.' });
  });

  it('fails a Pi turn with bounded text instead of breaking the route', async () => {
    writeSymonTextBrainMode('pi');
    const { POST } = await import('@/lib/symon/http/managed-inbound');

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, state: 'processing', error: 'brain_unavailable' });
  });

  it('loads the phone and conversations routes', async () => {
    await expect(import('@/app/api/mobile/symon/text-session/route')).resolves.toBeDefined();
    await expect(import('@/lib/symon/http/text-turn')).resolves.toBeDefined();
    await expect(import('@/lib/symon/http/conversations')).resolves.toBeDefined();
    await expect(import('@/lib/symon/messages-receiver/loop')).resolves.toBeDefined();
  });
});
