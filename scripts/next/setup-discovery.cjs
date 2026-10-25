/** Fixture-only discovery seam. Production route validation and persistence stay intact. */
const Module = require('node:module');
const load = Module._load;
let ready = false;
let refreshes = 0;
const inventory = () => [
  { id: 'codex', label: 'Codex', installed: true, available: ready, unavailableReason: ready ? null : 'needs_auth', detail: ready ? 'Connected' : 'Sign in required', fix: 'codex login' },
  { id: 'claude-code', label: 'Claude Code', installed: true, available: ready, unavailableReason: ready ? null : 'needs_auth', detail: ready ? 'Connected' : 'Sign in required', fix: 'claude' },
  { id: 'opencode', label: 'OpenCode', installed: true, available: ready, unavailableReason: ready ? null : 'needs_auth', detail: ready ? 'Connected' : 'Sign in required', fix: 'opencode2 auth login' },
  { id: 'gemini', label: 'Gemini CLI', installed: true, available: false, unavailableReason: 'needs_auth', detail: 'Sign in required', fix: 'gemini' },
];
Module._load = function(request, parent, isMain) {
  if (parent?.filename.endsWith('/setup/runtime-setup-server.ts') && request.endsWith('/opencode-readiness')) return {
    readOpencodeConfig: async () => ({}),
    opencodeCliModels: async () => new Set(['fixture/selected-model']),
  };
  if (request.endsWith('/runtimes/shared/auth-detect') || request.endsWith('/runtimes/shared/auth-detect.ts')) return {
    getRuntimeAuthSnapshot: async () => ({ statuses: {}, suggestedSubscriptionProfile: { profile: null, detail: null } }),
    getDispatchableRuntimeAvailability: async () => inventory(),
    invalidateRuntimeAuthCache: () => { ready = ++refreshes >= 2; },
  };
  if (request.endsWith('/setup/runtime-activity') || request === './runtime-activity') return {
    readRuntimeActivity: async () => ({ codex: 0, claude: 0, complete: false }),
    readLocalLeadModels: async () => ({}),
  };
  if (request.endsWith('/skeleton/autoscan') || request.endsWith('/skeleton/autoscan.ts')) return {
    triggerScan() {}, startChangePolling() {}, triggerScanIfStale() {}, stopChangePolling() {},
  };
  return load.call(this, request, parent, isMain);
};
