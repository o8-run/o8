// Replace only answer composition; routing, credentials and persisted context stay real.
const Module = require('node:module');
const load = Module._load;
Module._load = function(id, ...args) {
  if (/cortex\/qa\/ask(?:\.ts)?$/.test(id)) return { askCortex: async (_question, _repo, options) => ({
    answer: options.projectId, citations: [], class: 'A', retrievalMs: 0, classifyMs: 0, sourcesConsidered: 0,
  }) };
  return load.call(this, id, ...args);
};
