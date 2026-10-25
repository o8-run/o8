import { providerCredentialName } from './credential-names';

/** Ambient worker inputs only. Adapter/task overrides are merged separately. */
const COMMON_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'SSH_AUTH_SOCK',
  'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA',
  'TMPDIR', 'TMP', 'TEMP', 'TZ', 'LANG', 'LANGUAGE',
  'LC_ALL', 'LC_ADDRESS', 'LC_COLLATE', 'LC_CTYPE', 'LC_IDENTIFICATION', 'LC_MEASUREMENT',
  'LC_MESSAGES', 'LC_MONETARY', 'LC_NAME', 'LC_NUMERIC', 'LC_PAPER', 'LC_TELEPHONE', 'LC_TIME',
  'TERM', 'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'NO_COLOR', 'FORCE_COLOR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'NODE_USE_ENV_PROXY',
  'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_ENV',
  'O8_DATA_DIR', 'CORTEX_IDE_DATA_DIR', 'O8_API_PORT', 'O8_WS_PORT',
]);

// npm accepts configuration names without regard to case. Enumerate complete
// names: npm_config_* also contains authentication and Node preload settings.
const NPM_CONFIG_KEYS = new Set([
  'npm_config_userconfig', 'npm_config_globalconfig', 'npm_config_registry',
  'npm_config_cache', 'npm_config_prefix',
  'npm_config_proxy', 'npm_config_https_proxy', 'npm_config_noproxy',
  'npm_config_ca', 'npm_config_cafile', 'npm_config_strict_ssl',
  'npm_config_fetch_retries', 'npm_config_fetch_retry_factor',
  'npm_config_fetch_retry_mintimeout', 'npm_config_fetch_retry_maxtimeout', 'npm_config_fetch_timeout',
  'npm_config_offline', 'npm_config_prefer_offline', 'npm_config_prefer_online',
]);

// Exact names, never vendor prefixes: a prefix can also contain unrelated secrets.
const RUNTIME_KEYS: Record<string, readonly string[]> = {
  codex: ['CODEX_HOME'],
  'claude-code': ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_TMPDIR', 'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'MAX_THINKING_TOKENS'],
  gemini: ['GEMINI_CLI_HOME', 'GEMINI_CLI_SYSTEM_SETTINGS_PATH', 'GEMINI_CLI_SYSTEM_DEFAULTS_PATH',
    'GEMINI_CLI_USE_VERTEX', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS'],
  opencode: ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_AUTOUPDATE'],
  pi: ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR'],
  hermes: ['HERMES_HOME'],
  openclaw: ['OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH'],
  openhands: ['OPENHANDS_API_KEY', 'LLM_PROVIDER', 'LLM_MODEL', 'LLM_BASE_URL'],
  cursor: ['CURSOR_API_KEY'],
  grok: ['GROK_CODE_XAI_API_KEY'],
  goose: ['GOOSE_PATH_ROOT', 'GOOSE_PROVIDER', 'GOOSE_MODEL'],
  aider: ['AIDER_CONFIG', 'AIDER_MODEL'],
  qwen: ['QWEN_CODE_HOME', 'QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
  kimi: ['KIMI_HOME', 'KIMI_API_KEY', 'MOONSHOT_API_KEY'],
  crush: ['CRUSH_GLOBAL_CONFIG', 'CRUSH_GLOBAL_DATA', 'HYPER_API_KEY'],
  antigravity: ['ANTIGRAVITY_HOME'],
  'copilot-cli': ['COPILOT_HOME', 'COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN',
    'COPILOT_PROVIDER_TYPE', 'COPILOT_PROVIDER_BASE_URL'],
};

/** Operator extensions accept comma-separated, exact environment variable names. */
export function workerParentEnvironment(source: Record<string, string | undefined>, runtimeId?: string): Record<string, string | undefined> {
  const npmNames = Object.keys(source).filter(name => NPM_CONFIG_KEYS.has(name.toLowerCase()));
  const names = new Set(source.O8_WORKER_ENV_INHERIT === '1' ? Object.keys(source) : [...COMMON_KEYS, ...npmNames, ...(RUNTIME_KEYS[runtimeId ?? ''] ?? [])]);
  for (const name of source.O8_WORKER_ENV_ALLOW?.split(',') ?? []) {
    const trimmed = name.trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) names.add(trimmed);
  }
  // Debug/addition knobs do not authorize store or provider credentials. The
  // normal process boundary restores API keys only after the billing decision.
  return Object.fromEntries([...names].filter(name => source[name] !== undefined && name !== 'O8_MASTER_KEY' && !providerCredentialName(name)).map(name => [name, source[name]]));
}
