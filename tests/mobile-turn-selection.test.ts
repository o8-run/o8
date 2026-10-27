import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedLlmChatHistory } from '@/lib/llm/chat-history-store';
import { resolveMobileTurnSelection } from '@/lib/ws-server/mobile-turn-selection';

const { readHistory } = vi.hoisted(() => ({ readHistory: vi.fn() }));
vi.mock('@/lib/llm/chat-history-store', () => ({ readPersistedLlmChat: readHistory }));
const original = { surface: 'mobile', message: 'keep my words', clientMutationId: 'same-send' };
const receipt = { leadModel: 'selected-model', effort: 'high' as const, mode: 'solo' as const,
  pickedMode: 'solo' as const, permissionMode: 'plan' as const };
let history: PersistedLlmChatHistory;
const resolve = (message = original, repoPath = '/repo', threadId: string | null = 'thoughts-one', backend = 'opencode') =>
  resolveMobileTurnSelection(message, repoPath, threadId, backend);

beforeEach(() => {
  readHistory.mockReset();
  history = { repoPath: '/repo', messages: [
    { id: 'a1', role: 'assistant', content: 'answer', backend: 'opencode', model: 'stale-model', receipt, timestamp: 1 },
    { id: 'u2', role: 'user', content: 'keep my words', timestamp: 2 },
  ] };
  readHistory.mockImplementation(() => ({ history }));
});

describe('mobile thread selection', () => {
  it('continues the actual model, Solo and Plan without inventing an independent effort', () => {
    expect(resolve()).toEqual({ ...original, model: 'selected-model',
      orchestrationMode: 'single', pickedMode: 'solo', permissionMode: 'plan' });
    expect(history.messages).toHaveLength(2);
  });

  it('keeps an observed legacy effort for a lead with a matching transport', () => {
    history.messages[0].backend = 'codex';
    expect(resolve(original, '/repo', 'thoughts-one', 'codex')).toMatchObject({ thinkingEffort: 'high' });
  });

  it.each(['acp', 'hermes', 'opencode', 'pi', 'o8'])('does not inherit an unmapped legacy effort for %s', backend => {
    history.messages[0].backend = backend as typeof history.messages[0]['backend'];
    expect(resolve(original, '/repo', 'thoughts-one', backend)).not.toHaveProperty('thinkingEffort');
  });

  it('preserves explicit choices, including selecting the agent default', () => {
    const explicit = { ...original, model: '', thinkingEffort: 'low', orchestrationMode: 'fusion',
      pickedMode: 'fusion', permissionMode: 'full' };
    expect(resolve(explicit)).toEqual(explicit);
  });

  it.each([
    [{ ...original, surface: 'desktop' }, '/repo', 'thoughts-one', 'opencode'],
    [original, '/different', 'thoughts-one', 'opencode'],
    [original, '/repo', null, 'opencode'],
    [original, '/repo', 'not-a-thread', 'opencode'],
    [original, '/repo', 'thoughts-one', 'codex'],
    [original, '/repo', 'thoughts-one', 'openclaw'],
  ] as const)('does not borrow selection outside its route: %j', (message, repoPath, threadId, backend) => {
    expect(resolve(message, repoPath, threadId, backend)).toEqual(message);
  });

  it('never scans past a newer backend handoff to reuse an older selection', () => {
    history.messages.push({ id: 'a2', role: 'assistant', content: 'new runtime', backend: 'codex', timestamp: 3 });
    expect(resolve()).toEqual(original);
  });

  it.each([['acp', 'acp'], ['hermes', 'hermes'], ['muse', 'Muse default'], ['pi', 'pi']])('does not turn %s display labels into model pins', (backend, label) => {
    history.messages[0] = { ...history.messages[0], backend: backend as typeof history.messages[0]['backend'],
      model: label, receipt: { ...receipt, leadModel: label } };
    expect(resolve(original, '/repo', 'thoughts-one', backend)).not.toHaveProperty('model');
  });

  it('keeps legacy and malformed history on the existing default path', () => {
    readHistory.mockReturnValue(null);
    expect(resolve()).toEqual(original);
    readHistory.mockReturnValue({ history: { messages: [], repoPath: 42 } });
    expect(resolve()).toEqual(original);
  });
});
