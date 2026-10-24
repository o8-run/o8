// Fixture runtime seam. Production route, retrieval, source translation and
// middleware remain real. No executable, provider or account is contacted.
const Module = require('node:module');
const { setTimeout: delay } = require('node:timers/promises');
const original = Module._load;
Module._load = function (request, parent, isMain) {
  if (/\/operator\/composer-brain-route(?:\.ts)?$/.test(request)) {
    const context = require('../../src/lib/operator/composer-brain-context');
    return { ...context, resolveComposerBrainRoute: async () => ({ runtime: 'codex', model: 'fixture-model', binary: 'fixture-only' }) };
  }
  if (/\/llm\/codex-adapter(?:\.ts)?$/.test(request)) {
    return { CODEX_DEFAULT_MODEL: 'fixture-model', callCodex: async (prompt, options) => {
      if (options?.readOnly !== true) throw new Error('Fixture requires the production read-only runtime contract');
      const question = prompt.split('Question: ').at(-1).split('\n\nThe following workspace context')[0];
      await delay(question.includes('Fixture slow answer') ? 600 : 100);
      if (question.includes('Fixture runtime error')) throw new Error('private fixture failure');
      if (question.includes('Fixture empty answer')) return ' ';
      if (question.includes('Fixture write request')) return 'I can discuss memory. Changes still require the existing operator approval; this runtime is read-only.';
      return 'Fixture memory rule: keep approvals and read-only retrieval. [D-fixture-memory]';
    } };
  }
  return original.call(this, request, parent, isMain);
};
