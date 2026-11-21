import { afterEach, describe, it, expect, vi } from 'vitest';

import {
  formatPersistedRuntimeSessionKey,
  loadTabState,
  pruneTabs,
  saveTabState,
  stripPersistedRuntimeSessionKey,
  stripPersistedTabs,
} from './tab-state';

afterEach(() => vi.unstubAllGlobals());

/**
 * Single source of truth for "is this a valid persisted tab?". Covers both
 * zombie shapes: #717 (orchestrator-prefixed id + non-orchestrator kind) and
 * #1293 (best-of-N comparison candidate chat tabs that reopened as phantom
 * "Agent working" tabs every reboot).
 */
describe('stripPersistedTabs', () => {
  it('strips shape-1 zombies (orchestrator-prefixed id, non-orchestrator kind)', () => {
    const tabs = [
      { id: 'orchestrator-abc', kind: 'chat' }, // zombie
      { id: 'orchestrator-real', kind: 'orchestrator' }, // legit
      { id: 'chat-xyz', kind: 'chat' }, // legit
    ];
    expect(stripPersistedTabs(tabs).map((t) => t.id)).toEqual(['orchestrator-real', 'chat-xyz']);
  });

  it('strips shape-2 zombies — best-of-N comparison candidate chat tabs (#1293)', () => {
    const tabs = [
      { id: 'chat-1', kind: 'chat', orchestrationPacket: { packetId: 'pkt-9a524bdd-cmp-0', branchTarget: 'inline/x-cmp-0' } },
      { id: 'chat-2', kind: 'chat', orchestrationPacket: { packetId: 'pkt-9a524bdd-cmp-1', branchTarget: 'inline/x-cmp-1' } },
      { id: 'chat-keep', kind: 'chat', orchestrationPacket: { packetId: 'pkt-normal', branchTarget: 'inline/normal-task' } },
    ];
    expect(stripPersistedTabs(tabs).map((t) => t.id)).toEqual(['chat-keep']);
  });

  it('detects a candidate by branchTarget even when packetId lacks the suffix', () => {
    const tabs = [
      { id: 'chat-a', kind: 'chat', orchestrationPacket: { packetId: 'pkt-a', branchTarget: 'inline/doc-cmp-2' } },
    ];
    expect(stripPersistedTabs(tabs)).toHaveLength(0);
  });

  it('keeps legit tabs with no orchestrationPacket and normal packets', () => {
    const tabs = [
      { id: 'term-1', kind: 'terminal' },
      { id: 'chat-3', kind: 'chat' },
      { id: 'orch-1', kind: 'orchestrator', orchestrationPacket: null },
      { id: 'chat-4', kind: 'chat', orchestrationPacket: { packetId: 'pkt-z', branchTarget: 'feature/comp-helper' } },
    ];
    // 'feature/comp-helper' contains "comp" but not "-cmp-<n>" — must NOT be stripped.
    expect(stripPersistedTabs(tabs).map((t) => t.id)).toEqual(['term-1', 'chat-3', 'orch-1', 'chat-4']);
  });

  it('drops non-object entries defensively', () => {
    const tabs = [null, undefined, { id: 'chat-ok', kind: 'chat' }] as Array<{ id?: string; kind?: string } | null | undefined>;
    expect(stripPersistedTabs(tabs as never).map((t) => t.id)).toEqual(['chat-ok']);
  });
});

describe('loadTabState', () => {
  it('treats a missing saved state as an expected empty result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));

    await expect(loadTabState('tile-root')).resolves.toBeNull();
  });
});

describe('saved remote terminal continuity', () => {
  const remoteMachine = { id: '12345678-1234-1234-1234-123456789abc', label: 'Studio', sessionId: 'dash-1' };
  const remoteTab = { id: 'remote-tab', kind: 'terminal' as const, label: 'Studio / dash-1', cliAgent: 'shell', remoteMachine };

  it('keeps an inactive remote terminal through save and load pruning', async () => {
    const state = {
      version: 1 as const,
      activeTabId: 'active-tab',
      savedAt: new Date(0).toISOString(),
      tabs: [{ id: 'active-tab', kind: 'terminal' as const, label: 'Active', cliAgent: 'shell', tmuxSession: 'active-session' }, remoteTab],
    };
    expect(pruneTabs(state.tabs, state.activeTabId).tabs).toContainEqual(remoteTab);
    let saved: typeof state | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_input: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        saved = JSON.parse(String(init.body)) as typeof state;
        return new Response('{}', { status: 200 });
      }
      return new Response(JSON.stringify(saved), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    await saveTabState(state, 'remote-roundtrip');
    expect((await loadTabState('remote-roundtrip'))?.tabs).toContainEqual(remoteTab);
  });
});

describe('owned runtime session persistence', () => {
  it.each([
    ['pi', 'pi-owned:abc'],
    ['qwen', 'qwen-owned:abc'],
  ] as const)('preserves %s session identity', (runtime, sessionKey) => {
    expect(formatPersistedRuntimeSessionKey(runtime, sessionKey)).toBe(sessionKey);
    expect(stripPersistedRuntimeSessionKey(runtime, sessionKey)).toBe(sessionKey);
  });
});
