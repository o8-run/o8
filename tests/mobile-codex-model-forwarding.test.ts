import { describe, expect, it, vi } from 'vitest';
const send = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/lane/codex-orchestrator-session', () => ({
  ensureCodexOrchestratorSession: () => ({ sessionName: 'fixture-session' }),
  getCodexOrchestratorSession: () => null,
  buildCodexOrchestratorPrompt: (_repo: string, message: string) => message,
  sendToCodexOrchestrator: send,
}));
vi.mock('@/lib/cortex/qa/llm/haiku-adapter', () => ({ prewarmHaiku: async () => {} }));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({ prewarmSonnetCli: async () => {} }));
import { codexBackend } from '@/lib/lane/orchestrator-backends/codex';
import { mobileModelCatalog } from '@/lib/mobile/model-catalog';

describe('phone catalog selection at the Codex backend', () => {
  it('forwards the exact selected model and effort on new and continued threads', async () => {
    const model = mobileModelCatalog().agents.find(agent => agent.id === 'codex')!.models.find(model => model.id === 'gpt-6.1-sol')!;
    for (const threadId of ['thoughts-new', 'thoughts-continued']) {
      await codexBackend.sendTurn('/tmp/fixture', 'Hello', () => {}, {
        threadId, model: model.id, thinkingEffort: 'high', permissionMode: 'full',
      });
      expect(send).toHaveBeenLastCalledWith(expect.anything(), 'Hello', expect.any(Function), expect.objectContaining({
        threadId, model: 'gpt-6.1-sol', thinkingEffort: 'high',
      }));
    }
  });
});
