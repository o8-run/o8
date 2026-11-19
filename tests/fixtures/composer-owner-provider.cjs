// Disposable proof only: preserve WS/executor code, replace the provider seam.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const data = process.env.CORTEX_IDE_DATA_DIR;
if (!data || fs.readFileSync(path.join(data, 'fixture-owner'), 'utf8') !== 'codex-owner-proof/v1') throw Error('Owned composer profile required');
process.env.HOME = path.dirname(data);
process.env.USERPROFILE = path.dirname(data);
// A missed interception must fail locally, never invoke an installed provider.
const blockedProvider = path.join(data, 'blocked-codex');
fs.writeFileSync(blockedProvider, '#!/bin/sh\nexit 78\n', { mode: 0o700 });
process.env.O8_CODEX_BIN = blockedProvider;
process.env.CODEX_HOME = path.join(data, 'empty-codex');
const load = Module._load;
const wrapped = new WeakMap();
Module._load = function(request, parent, main) {
  const actual = load.call(this, request, parent, main);
  let filename;
  try { filename = Module._resolveFilename(request, parent); } catch { return actual; }
  if (typeof filename !== 'string' || !actual || typeof actual !== 'object') return actual;
  if (wrapped.has(actual)) return wrapped.get(actual);
  if (/\/lib\/lane\/orchestrator-backends\/registry(?:\.ts)?$/.test(filename)) {
    const get = actual.getOrchestratorBackend;
    const result = { ...actual, getOrchestratorBackend: (id, ...args) => {
      const backend = get(id, ...args);
      if (id !== 'codex') return backend;
      return { ...backend,
        ensureSession: () => ({ sessionName: 'codex-owner-fixture', status: 'ready' }),
        peekSession: () => ({ sessionName: 'codex-owner-fixture', status: 'ready' }),
        sendTurn: async (repo, message, emit, options) => {
          fs.appendFileSync(path.join(data, 'provider-calls.jsonl'), JSON.stringify({ repo, message,
            threadId: options.threadId, model: options.model, effort: options.thinkingEffort,
            permissionMode: options.permissionMode, projectId: options.projectId }) + '\n');
          emit({ type: 'turn_receipt', leadModel: options.model, effort: options.thinkingEffort });
          emit({ type: 'text', text: 'Fixture Codex reply.' });
          emit({ type: 'done', sessionId: 'fixture-codex-session', cost: null, terminalOutcome: 'completed' });
        },
      };
    } };
    wrapped.set(actual, result); return result;
  }
  if (/\/lib\/ws-server\/orchestrator-project-context(?:\.ts)?$/.test(filename)) {
    const prepare = actual.prepareOrchestratorProjectTurn;
    const result = { ...actual, prepareOrchestratorProjectTurn: async (...args) => {
      if (fs.existsSync(path.join(data, 'block-prepare'))) {
        fs.writeFileSync(path.join(data, 'prepare-entered'), '1');
        const end = Date.now() + 10000;
        while (!fs.existsSync(path.join(data, 'release-prepare'))) {
          if (Date.now() > end) throw Error('Composer proof preparation gate timed out');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      return prepare(...args);
    } };
    wrapped.set(actual, result); return result;
  }
  return actual;
};
