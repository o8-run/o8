// Capability map for orchestrator runtime adapters. See docs/internals/runtime-adapter-contract.md.
import { MODEL_IDS } from '@/lib/models';

export type DeclarativeParserProfile =
  | 'antigravity-stream-json'
  | 'text'
  | 'copilot-jsonl'
  | 'openhands-ndjson'
  | 'qwen-stream-json';

type DeclarativeManifestArg = string | {
  when: 'cwd' | 'prompt' | 'model' | 'effort' | 'threadId' | 'sessionPath';
  args: string[];
};

export interface DeclarativeRuntimeManifest {
  launchArgs: DeclarativeManifestArg[];
  resumeArgs: DeclarativeManifestArg[] | null;
  /** Stable runtime-owned file used when a CLI persists resumable sessions itself. */
  sessionFileName?: string;
  parserProfile: DeclarativeParserProfile;
  costFormat: 'structured' | 'text';
  authEnvVars: string[];
  authPaths: string[];
  authFix: string;
  extraSpawnEnv?: Record<string, string>;
}

export interface OrchestratorRuntimeCapability<
  WorkerProvider extends string = string,
  AuthHouse extends string = string,
> {
  /** Display label in pickers, chips */
  label: string;
  /** Short label for tight spaces */
  shortLabel: string;
  /** Can this runtime receive dispatched packets via mission control? */
  dispatchable: boolean;
  /** Adapter can launch through an explicit governed route but is not offered in mission pickers. */
  explicitLaunchOnly?: boolean;
  /** Does it require a --model flag to be picked before launch? */
  requiresModel: boolean;
  /** Default model if user doesn't pick one */
  defaultModel?: string;
  /** Chip / icon color for UI; HEX */
  accentColor: string;
  /** Binary name (for cli-resolver + diagnostics) */
  binaryName: string;
  /** Human-readable description for the launch picker tooltip */
  description: string;
  /** Worker-routing provider stamped onto mission metadata. */
  workerProvider: WorkerProvider;
  /** Auth inventory bucket; null only for discovery-only runtimes. */
  authHouse: AuthHouse | null;
  /**
   * Model ids this runtime's CLI can actually launch, when that set is
   * knowable. Codex cannot run an Anthropic id and the Claude harness cannot
   * run an OpenAI one; handing either the other house's model fails the turn
   * (#1807, and the codex-direction hit on 2026-07-05).
   *
   * OMIT for a runtime that legitimately fronts several providers -- cursor,
   * opencode and the gateway-backed harnesses all do. Absent means "do not
   * guess", and the model passes through untouched. A wrong constraint here
   * would block a valid selection, which is worse than the bug it prevents.
   */
  modelIdPattern?: RegExp;
  /** Whether launch accepts a reasoning-effort selection. */
  reasoningEffort: boolean;
  /** Provider-native durable session transforms. Missing means unsupported. */
  sessionTransforms?: {
    import: boolean;
    checkpoint: boolean;
    fork: boolean;
    rewind: boolean;
  };
  /** One-entry adapter + auth definition for straightforward owned CLIs. */
  declarative?: DeclarativeRuntimeManifest;
  /**
   * Model capability tier, used by the "Workers use the Brain" auto mode:
   * `auto` turns the Engineering Brain on for every NON-frontier worker so a
   * weaker model gets repo knowledge without burning context on searches.
   * `frontier` — top-tier coding models (Codex GPT-5.5 xhigh, Claude).
   * `standard` — capable but benefits from injected knowledge (Gemini, opencode).
   * `local` — future on-device models (M5 era); always Brain-assisted in auto.
   */
  tier: 'frontier' | 'standard' | 'local';
}

export const ORCHESTRATOR_RUNTIMES = {
  codex: {
    label: 'Codex',
    shortLabel: 'Codex',
    dispatchable: true,
    requiresModel: false,
    // Dispatched workers default to gpt-5.6-terra. The Codex ORCHESTRATOR
    // default is gpt-6-astra (see MODEL_IDS.codexDefault); workers stay on
    // Terra. gpt-5.5
    // remains selectable. (History: gpt-5-codex → gpt-5.5 on 2026-04-30 after
    // upstream 400'd gpt-5-codex on ChatGPT-account Codex CLI.)
    defaultModel: MODEL_IDS.codexWorkerDefault,
    accentColor: '#2563eb', // blue — matches existing codex tone in display.ts
    binaryName: 'codex',
    workerProvider: 'codex',
    authHouse: 'codex',
    modelIdPattern: /^(gpt-|o\d|openai\/)/i,
    reasoningEffort: true,
    sessionTransforms: {
      import: true,
      checkpoint: true,
      fork: true,
      rewind: true,
    },
    tier: 'frontier',
    description: 'Codex coding agent via `codex exec --json` (Astra orchestration · Terra workers). Full-access sandbox, thread resume.',
  },
  cloud: {
    label: 'Cloud Worker',
    shortLabel: 'Cloud',
    // The durable adapter is usable through the runtime launch route. Mission
    // dispatch stays hidden until external-worker availability is surfaced.
    dispatchable: false,
    explicitLaunchOnly: true,
    requiresModel: false,
    defaultModel: MODEL_IDS.codexWorkerDefault,
    accentColor: '#2563eb',
    binaryName: 'codex',
    workerProvider: 'codex',
    authHouse: null,
    modelIdPattern: /^(gpt-|o\d|openai\/)/i,
    reasoningEffort: true,
    tier: 'frontier',
    description: 'Durable external Codex worker with a remote Git checkout and scoped worker key.',
  },
  'claude-code': {
    label: 'Claude Code',
    shortLabel: 'Claude',
    // #1407 (2026-07-06): operator reversed the old #650 lock. Frontier
    // runtimes orchestrate and work; Claude workers must use interactive
    // stream-json spawn only so they stay sub-billed, never Agent SDK --print.
    dispatchable: true,
    requiresModel: false,
    defaultModel: MODEL_IDS.claudeWorkerDefault,
    accentColor: '#e07a3a', // orange — matches existing claude-code tone in display.ts
    binaryName: 'claude',
    workerProvider: 'claude',
    authHouse: 'claude',
    // A Claude id, never the runtime's own name: threads made without a lead
    // saved "claude-code" as their model, and it must fall to the default.
    modelIdPattern: /^(claude-(?!code$)|anthropic\/)/i,
    reasoningEffort: true,
    tier: 'frontier',
    description: 'Claude Code CLI worker via interactive stream-json. Uses the existing Claude account by default or an explicitly selected API gateway model; never --print.',
  },
  gemini: {
    label: 'Gemini CLI',
    shortLabel: 'Gemini',
    dispatchable: true,
    requiresModel: false,
    // 2026-04-28: reverted from gemini-3.1-pro to gemini-3-pro-preview after
    // the 3.1-pro fan-out test (mission-958a824e-b0a) showed 5/5 hallucinated
    // completions at thinkingEffort=max. See memory
    // gemini_fanout_reliability_apr28.md. The GEMINI_FALLBACK_CASCADE rolls
    // back further if 3-pro-preview hits quota.
    defaultModel: 'gemini-3-pro-preview',
    accentColor: '#4285f4', // Google blue
    binaryName: 'gemini',
    workerProvider: 'gemini',
    authHouse: 'gemini',
    modelIdPattern: /^(gemini|google\/)/i,
    reasoningEffort: false,
    tier: 'standard',
    description: 'Legacy Gemini CLI worker for enterprise or paid API access via headless stream-json, with owned-session resume and review support. Free and AI Pro/Ultra use Antigravity CLI.',
  },
  antigravity: {
    label: 'Antigravity',
    shortLabel: 'AGY',
    dispatchable: true,
    requiresModel: false,
    defaultModel: 'gemini-3.8-flash-low',
    accentColor: '#0f9d58',
    binaryName: 'agy',
    workerProvider: 'antigravity',
    authHouse: 'antigravity',
    reasoningEffort: false,
    tier: 'standard',
    description: 'Google Antigravity CLI (agy) worker with streaming output and conversation resume. Uses existing permissions and quota settings.',
    declarative: {
      launchArgs: ['--print', 'Workspace directory: {{cwd}}\n\n{{prompt}}', '--add-dir', '{{cwd}}', '--output-format', 'stream-json', '--sandbox', '--print-timeout', '15m', { when: 'model', args: ['--model', '{{model}}'] }],
      resumeArgs: ['--print', '{{prompt}}', '--output-format', 'stream-json', '--sandbox', '--print-timeout', '15m', '--conversation', '{{threadId}}', { when: 'model', args: ['--model', '{{model}}'] }],
      parserProfile: 'antigravity-stream-json',
      costFormat: 'structured',
      authEnvVars: [],
      authPaths: [],
      authFix: 'Run agy and sign in with Google. Keep Use AI Credits off for quota-only use.',
    },
  },
  magnitude: {
    label: 'Magnitude',
    shortLabel: 'Mag',
    dispatchable: false,
    requiresModel: false,
    accentColor: '#0f9f8f',
    binaryName: 'magnitude',
    workerProvider: 'magnitude',
    authHouse: null,
    reasoningEffort: false,
    tier: 'local',
    description: 'Local-model agent CLI available as a visible repository terminal. Packet dispatch waits for a stable headless or RPC contract.',
  },
  opencode: {
    label: 'OpenCode 2',
    shortLabel: 'OC2',
    // OpenCode 2 keeps the governed JSONL + resume contract while adding a
    // shared service/API architecture and explicit ordered permissions. Its
    // dispatch preflight accepts provider credentials or a selected keyless
    // provider configured on the local network.
    dispatchable: true,
    requiresModel: true,
    // OpenCode's free DeepSeek V4 Flash route gives fresh installs a working
    // default; operators can still pin any discovered provider/model id.
    defaultModel: 'opencode/deepseek-v4-flash-free',
    accentColor: '#a855f7', // purple — distinct from the other three
    binaryName: 'opencode2',
    workerProvider: 'opencode',
    authHouse: 'opencode',
    reasoningEffort: false,
    tier: 'standard',
    description: 'Multi-provider OpenCode 2 worker via `opencode2 run --format json`; dispatch requires provider credentials or a configured local provider.',
  },
  'copilot-cli': {
    label: 'GitHub Copilot CLI',
    shortLabel: 'Copilot',
    dispatchable: true,
    requiresModel: false,
    accentColor: '#238636',
    binaryName: 'copilot',
    workerProvider: 'copilot-cli',
    authHouse: 'copilot-cli',
    reasoningEffort: false,
    // The CLI can route across model families, so the runtime name alone does
    // not guarantee a frontier model. Keep Brain auto-assistance enabled.
    tier: 'standard',
    description: 'Multi-model Copilot CLI worker via non-interactive JSONL with native session resume.',
    declarative: {
      launchArgs: [
        '-p',
        '{{prompt}}',
        '--allow-all',
        '--no-ask-user',
        '--output-format',
        'json',
        '--no-color',
        '--no-auto-update',
        '--no-remote-export',
      ],
      resumeArgs: [
        '-p',
        '{{prompt}}',
        '--resume={{threadId}}',
        '--allow-all',
        '--no-ask-user',
        '--output-format',
        'json',
        '--no-color',
        '--no-auto-update',
        '--no-remote-export',
      ],
      parserProfile: 'copilot-jsonl',
      costFormat: 'structured',
      authEnvVars: [
        'COPILOT_GITHUB_TOKEN',
        'GH_TOKEN',
        'GITHUB_TOKEN',
        'COPILOT_PROVIDER_API_KEY',
        'COPILOT_PROVIDER_BEARER_TOKEN',
        'COPILOT_PROVIDER_BASE_URL',
      ],
      authPaths: ['.copilot/config.json', '.copilot/settings.json'],
      authFix: 'Install Copilot CLI (`npm i -g @github/copilot`), then run `copilot login` or configure a supported token or model provider.',
    },
  },
  crush: {
    label: 'Crush',
    shortLabel: 'Crush',
    dispatchable: true,
    requiresModel: false,
    accentColor: '#ff5f87',
    binaryName: 'crush',
    workerProvider: 'crush',
    authHouse: 'crush',
    reasoningEffort: false,
    // Provider and model selection live in Crush configuration, so dispatch
    // cannot infer frontier capability from the runtime id.
    tier: 'standard',
    description: 'Multi-provider Crush worker via its automatic non-interactive one-shot command.',
    declarative: {
      launchArgs: ['run', '--quiet', '{{prompt}}'],
      resumeArgs: null,
      parserProfile: 'text',
      costFormat: 'text',
      authEnvVars: [
        'HYPER_API_KEY',
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        'VERCEL_API_KEY',
        'GEMINI_API_KEY',
        'OPENROUTER_API_KEY',
        'AWS_ACCESS_KEY_ID',
        'AZURE_OPENAI_API_KEY',
      ],
      authPaths: [
        '.config/crush/crushrc',
        '.config/crush/crush.json',
        '.local/share/crush/crush.json',
        'AppData/Local/crush/crush.json',
      ],
      authFix: 'Install Crush (`npm i -g @charmland/crush`), then run `crush` once to configure a provider or set a supported provider API key.',
    },
  },
  openhands: {
    label: 'OpenHands',
    shortLabel: 'OpenHands',
    dispatchable: true,
    requiresModel: false,
    accentColor: '#6d5ce7',
    binaryName: 'openhands',
    workerProvider: 'openhands',
    authHouse: 'openhands',
    reasoningEffort: false,
    tier: 'standard',
    description: 'Model-agnostic OpenHands CLI worker via headless NDJSON with automatic tool approval.',
    declarative: {
      launchArgs: ['--headless', '--json', '-t', '{{prompt}}'],
      resumeArgs: null,
      parserProfile: 'openhands-ndjson',
      costFormat: 'structured',
      authEnvVars: ['OPENHANDS_API_KEY', 'LLM_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
      authPaths: ['.openhands/config.toml'],
      authFix: 'Install OpenHands, then run `openhands login` or configure a model provider.',
    },
  },
  goose: {
    label: 'Goose',
    shortLabel: 'Goose',
    dispatchable: true,
    requiresModel: false,
    accentColor: '#d97706',
    binaryName: 'goose',
    workerProvider: 'goose',
    authHouse: 'goose',
    reasoningEffort: false,
    tier: 'standard',
    description: 'MCP-native Goose CLI worker via bounded automatic headless execution.',
    declarative: {
      launchArgs: ['run', '-t', '{{prompt}}', '--max-turns', '100'],
      resumeArgs: null,
      parserProfile: 'text',
      costFormat: 'text',
      authEnvVars: ['GOOSE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY'],
      authPaths: ['.config/goose/config.yaml'],
      authFix: 'Install Goose, then configure a provider with `goose configure`.',
      extraSpawnEnv: { GOOSE_MODE: 'auto', GOOSE_MAX_TURNS: '100' },
    },
  },
  qwen: {
    label: 'Qwen Code',
    shortLabel: 'Qwen',
    dispatchable: true,
    requiresModel: false,
    accentColor: '#7c3aed',
    binaryName: 'qwen',
    workerProvider: 'qwen',
    authHouse: 'qwen',
    reasoningEffort: false,
    tier: 'standard',
    description: 'Qwen Code CLI worker via Gemini-compatible headless stream JSON and YOLO approval mode.',
    declarative: {
      launchArgs: ['-p', '{{prompt}}', '--yolo', '--output-format', 'stream-json'],
      resumeArgs: null,
      parserProfile: 'qwen-stream-json',
      costFormat: 'structured',
      authEnvVars: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY', 'OPENAI_API_KEY'],
      authPaths: ['.qwen/oauth_creds.json', '.qwen/settings.json'],
      authFix: 'Install Qwen Code, then run `qwen` once to sign in or configure QWEN_API_KEY.',
    },
  },
  qoder: {
    label: 'Qoder',
    shortLabel: 'Qoder',
    dispatchable: true,
    requiresModel: false,
    accentColor: '#4ade80',
    binaryName: 'qodercli',
    workerProvider: 'qoder',
    authHouse: 'qoder',
    reasoningEffort: false,
    tier: 'standard',
    description: 'Qoder CLI worker (Claude-protocol stream JSON), pinned to Qwen3.8-Max-Preview while the discounted-credits campaign runs.',
    declarative: {
      launchArgs: ['-p', '{{prompt}}', '-m', 'Qwen3.8-Max-Preview', '--dangerously-skip-permissions', '--output-format', 'stream-json'],
      resumeArgs: null,
      parserProfile: 'qwen-stream-json',
      costFormat: 'structured',
      authEnvVars: [],
      authPaths: ['.qoder/settings.json'],
      authFix: 'Install Qoder CLI (`npm i -g @qoder-ai/qodercli`), then run `qodercli login`.',
    },
  },
  kimi: {
    label: 'Kimi Code',
    shortLabel: 'Kimi',
    dispatchable: true,
    requiresModel: false,
    accentColor: '#334155',
    binaryName: 'kimi',
    workerProvider: 'kimi',
    authHouse: 'kimi',
    reasoningEffort: false,
    tier: 'standard',
    description: 'Kimi Code CLI worker via automatic non-interactive prompt mode.',
    declarative: {
      launchArgs: ['-p', '{{prompt}}'],
      resumeArgs: null,
      parserProfile: 'text',
      costFormat: 'text',
      authEnvVars: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
      authPaths: ['.kimi-code/config.toml'],
      authFix: 'Install Kimi Code, then run `kimi login` or configure KIMI_API_KEY.',
    },
  },
  aider: {
    label: 'Aider',
    shortLabel: 'Aider',
    dispatchable: true,
    requiresModel: false,
    accentColor: '#dc2626',
    binaryName: 'aider',
    workerProvider: 'aider',
    authHouse: 'aider',
    reasoningEffort: false,
    tier: 'standard',
    description: 'Aider one-shot coding worker with automatic approvals and configured test execution.',
    declarative: {
      launchArgs: ['--message', '{{prompt}}', '--yes-always', '--auto-test'],
      resumeArgs: null,
      parserProfile: 'text',
      costFormat: 'text',
      authEnvVars: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'],
      authPaths: ['.aider.conf.yml'],
      authFix: 'Install Aider, then configure a model provider API key.',
    },
  },
  '3code': {
    label: '3code',
    shortLabel: '3code',
    dispatchable: true,
    requiresModel: false,
    accentColor: '#74c8c1',
    binaryName: '3code',
    workerProvider: '3code',
    authHouse: '3code',
    reasoningEffort: false,
    tier: 'standard',
    description: 'Local-first 3code CLI worker with runtime-owned session logs and deterministic resume.',
    declarative: {
      launchArgs: ['--session', '{{sessionPath}}', { when: 'model', args: ['--model', '{{model}}'] }, '{{prompt}}'],
      resumeArgs: ['--resume={{sessionPath}}', { when: 'model', args: ['--model', '{{model}}'] }, '{{prompt}}'],
      sessionFileName: 'session.3log',
      parserProfile: 'text',
      costFormat: 'text',
      authEnvVars: [],
      authPaths: ['.config/3code/config'],
      authFix: 'Install 3code, then run `3code` once to configure a provider.',
    },
  },
  pi: {
    label: 'Pi',
    shortLabel: 'Pi',
    dispatchable: true,
    requiresModel: false,
    accentColor: '#16a34a',
    binaryName: 'pi',
    workerProvider: 'pi',
    authHouse: 'pi',
    reasoningEffort: false,
    tier: 'standard',
    description: 'earendil-works/pi coding agent via RPC-mode JSONL with native steer.',
  },
  // The Pi SDK bundled with o8 (#3258), separate from the external `pi` CLI
  // above. It runs on o8's own Node and the managed model route.
  'pi-builtin': {
    label: 'Pi (built-in)',
    shortLabel: 'Pi built-in',
    dispatchable: true,
    requiresModel: false,
    defaultModel: 'openai/gpt-6-luna',
    accentColor: '#16a34a',
    // No CLI on PATH: Pi runs as o8's own Node worker script. A name no other
    // process uses keeps process detection from claiming every `node` process.
    binaryName: 'o8-pi-worker',
    workerProvider: 'pi-builtin',
    authHouse: 'pi-builtin',
    // The managed model, or an explicit OpenRouter model on the user's connection (#3584).
    modelIdPattern: /^(?:openai\/gpt-6-luna|openrouter\/[A-Za-z0-9._-]+\/[A-Za-z0-9._:+-]+)$/,
    reasoningEffort: false,
    tier: 'standard',
    description: 'Pi SDK bundled with o8 on the managed model route (your plan or the free daily allowance), or on an OpenRouter model you pick. Writes and commands stay in the packet worktree.',
  },
  cursor: {
    label: 'Cursor',
    shortLabel: 'Cursor',
    dispatchable: true,
    requiresModel: false,
    defaultModel: 'cursor-agent',
    accentColor: '#111827',
    binaryName: 'cursor-agent',
    workerProvider: 'cursor',
    authHouse: 'cursor',
    reasoningEffort: false,
    tier: 'frontier',
    description: 'Cursor CLI headless worker via `cursor-agent -p --output-format stream-json`.',
  },
  grok: {
    label: 'Grok Build',
    shortLabel: 'Grok',
    dispatchable: true,
    requiresModel: false,
    accentColor: '#16a34a',
    binaryName: 'grok',
    workerProvider: 'grok',
    authHouse: 'grok',
    modelIdPattern: /^(grok|x-ai\/|xai\/)/i,
    reasoningEffort: false,
    tier: 'frontier',
    description: 'Grok Build coding CLI with provider-selected current defaults, structured headless output, and durable resume.',
  },
  'prime-agent': {
    label: 'Prime Agent',
    shortLabel: 'Prime',
    dispatchable: true,
    requiresModel: false,
    accentColor: '#0ea5e9',
    binaryName: 'prime-agent',
    workerProvider: 'prime-agent',
    authHouse: 'prime-agent',
    reasoningEffort: false,
    // Standard, not frontier: runs on the operator's own provider keys via
    // prime-agent's own config, so it qualifies for the "Workers use the
    // Brain" auto mode like Gemini/opencode.
    tier: 'standard',
    description: "Open-source RLM coding harness CLI (json-mode JSONL output); runs on the operator's own provider keys.",
  },
  muse: {
    label: 'Muse Code', shortLabel: 'Muse', dispatchable: true, requiresModel: false,
    accentColor: '#0866ff', binaryName: 'muse', workerProvider: 'muse', authHouse: 'muse',
    reasoningEffort: true, tier: 'frontier',
    description: 'Native Muse Code worker with durable sessions. Uses the installed CLI account and its available models; sandbox remains enabled.',
  },
  hermes: {
    label: 'Hermes',
    shortLabel: 'Hermes',
    dispatchable: true,
    requiresModel: false,
    accentColor: '#64748b',
    binaryName: 'hermes',
    workerProvider: 'hermes',
    authHouse: 'hermes',
    reasoningEffort: false,
    tier: 'standard',
    description: 'Hermes Agent worker through its ACP stdio server, using the provider and model configured by Hermes.',
  },
  'deepseek-harness': {
    label: 'DeepSeek Harness',
    shortLabel: 'DSH',
    dispatchable: true,
    requiresModel: false,
    defaultModel: 'deepseek-v4-pro',
    accentColor: '#4d6bfe',
    binaryName: 'dsh-acp-demo',
    workerProvider: 'deepseek-harness',
    authHouse: 'deepseek-harness',
    reasoningEffort: false,
    tier: 'standard',
    description: 'DeepSeek Harness developer preview through its official ACP stdio server, with provider selection kept separate from the harness.',
  },
} satisfies Record<string, OrchestratorRuntimeCapability>;

export type OrchestratorRuntime = keyof typeof ORCHESTRATOR_RUNTIMES;
export type RuntimeWorkerProvider = (typeof ORCHESTRATOR_RUNTIMES)[OrchestratorRuntime]['workerProvider'];
export type RuntimeAuthHouse = Exclude<
  (typeof ORCHESTRATOR_RUNTIMES)[OrchestratorRuntime]['authHouse'],
  null
>;
type CatalogRuntimeCapability = OrchestratorRuntimeCapability<RuntimeWorkerProvider, RuntimeAuthHouse>;

export const RUNTIME_PRESETS = {
  'ui-edit-low-latency': {
    modelByRuntime: {
      codex: MODEL_IDS.codexScoutDefault,
      'claude-code': MODEL_IDS.claudeHaikuQaDefault,
    },
  },
} as const satisfies Record<string, {
  modelByRuntime: Partial<Record<OrchestratorRuntime, string>>;
}>;

export type RuntimePresetId = keyof typeof RUNTIME_PRESETS;

/** Resolve a semantic preset through the runtime already selected by operator policy. */
export function resolveRuntimePreset(
  presetId: RuntimePresetId,
  runtime: OrchestratorRuntime,
): { runtime: OrchestratorRuntime; model: string } | null {
  const modelByRuntime = RUNTIME_PRESETS[presetId].modelByRuntime as Partial<Record<OrchestratorRuntime, string>>;
  const model = modelByRuntime[runtime];
  return model ? { runtime, model } : null;
}

export const ORCHESTRATOR_RUNTIME_IDS = Object.freeze(
  Object.keys(ORCHESTRATOR_RUNTIMES) as OrchestratorRuntime[],
);

export function isOrchestratorRuntime(value: unknown): value is OrchestratorRuntime {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ORCHESTRATOR_RUNTIMES, value);
}

/**
 * The runtime a session key names, or null when it names none.
 *
 * Keys are `<runtime>-owned:<id>` / `<runtime>-discovered:<id>`, so the key
 * itself carries runtime identity — which is why a surface holding only a
 * session key still knows what is running in it (#1749).
 *
 * Pure and client-safe on purpose. `runtimeIdFromSessionKey` in
 * `runtime/transcript.ts` does the same parse but validates against the adapter
 * registry, pulling every adapter with it; a React surface cannot import that.
 */
export function runtimeFromSessionKeyId(sessionKey: string | null | undefined): OrchestratorRuntime | null {
  const normalized = sessionKey?.trim() ?? '';
  const separator = normalized.indexOf(':');
  if (separator <= 0) return null;
  if (!normalized.slice(separator + 1).trim()) return null;
  const prefix = normalized.slice(0, separator).trim().replace(/-(?:owned|discovered)$/, '');
  return isOrchestratorRuntime(prefix) ? prefix : null;
}

export function runtimeFromOwnedSessionKey(value: unknown): OrchestratorRuntime | null {
  if (typeof value !== 'string') return null;
  const sessionKey = value.trim();
  return ORCHESTRATOR_RUNTIME_IDS.find((runtime) => sessionKey.startsWith(`${runtime}-owned:`)) ?? null;
}

export function isOwnedOrchestratorSessionKey(value: unknown): boolean {
  return runtimeFromOwnedSessionKey(value) !== null;
}

export function listDispatchableRuntimes(options?: {
  includeExperimental?: boolean;
  experimental?: OrchestratorRuntime[];
}): OrchestratorRuntime[] {
  void options;
  return ORCHESTRATOR_RUNTIME_IDS
    .filter((id) => ORCHESTRATOR_RUNTIMES[id].dispatchable);
}

export function isDispatchableRuntime(value: unknown): value is OrchestratorRuntime {
  return isOrchestratorRuntime(value) && ORCHESTRATOR_RUNTIMES[value].dispatchable;
}

export function formatDispatchableRuntimeChoices(): string {
  return listDispatchableRuntimes().map((id) => `"${id}"`).join(', ');
}

export function listDeclarativeRuntimes(): OrchestratorRuntime[] {
  return ORCHESTRATOR_RUNTIME_IDS.filter((id) => 'declarative' in ORCHESTRATOR_RUNTIMES[id]);
}

export function listDispatchableWorkerProviders(): RuntimeWorkerProvider[] {
  return [...new Set(listDispatchableRuntimes().map(
    (runtime) => ORCHESTRATOR_RUNTIMES[runtime].workerProvider,
  ))];
}

export function isRuntimeWorkerProvider(value: unknown): value is RuntimeWorkerProvider {
  return typeof value === 'string' && listDispatchableWorkerProviders().includes(value as RuntimeWorkerProvider);
}

export function getRuntimeCapability(runtime: OrchestratorRuntime): CatalogRuntimeCapability {
  return ORCHESTRATOR_RUNTIMES[runtime];
}

/** Runtimes that ship in the dispatch picker. Mirrors the canonical capability set. */
export const V1_DISPATCH_RUNTIMES: OrchestratorRuntime[] = listDispatchableRuntimes();

// Eighteen dispatchable seats at the table. The nineteenth is yours:
// docs/internals/runtime-adapter-contract.md is the chair.
