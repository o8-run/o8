// Only the provider boundary is deterministic. The actual WS command admission,
// transcript persistence, terminal producer and voice relay stay in production.
const Module = require('node:module');
const original = Module._load;
Module._load = function (request, parent, isMain) {
  const actual = original.call(this, request, parent, isMain);
  if (/orchestrator-backends\/registry(?:\.ts)?$/.test(request)) {
    const get = actual.getOrchestratorBackend;
    const backend = { ...get('codex'),
      ensureSession: (repoPath) => ({ sessionName: 'voice-fixture', repoPath, status: 'ready' }),
      peekSession: () => null,
      sendTurn: async (_repo, _message, emit) => {
        emit({ type: 'text', text: _message.includes('fixture-long-result') ? 'x'.repeat(50_000) : 'Verified fixture answer.' });
        emit({ type: 'done', sessionId: 'fixture-provider', cost: null, terminalOutcome: 'completed' });
      },
    };
    return { ...actual, getOrchestratorBackend: id => id === 'codex' ? backend : get(id) };
  }
  return actual;
};
