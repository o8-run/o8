# Worker environment

Dispatched CLI workers start with an allowlist of launching-shell variables. An
unrelated exported signing password or service token does not reach the worker.
The same policy covers specialized CLI adapters, ACP workers, Pi CLI, and every
declarative adapter, including Antigravity. Bundled Pi already starts with a
private state home and an explicit minimal environment; its model calls go
through the host transport.

## Default allowlist

Only variables that are set are copied. Names are case-sensitive; there are no
vendor-prefix wildcards. The source of truth is
[`worker-environment.ts`](../../src/lib/providers/worker-environment.ts).

| Purpose | Variables |
| --- | --- |
| Executables and user directories | `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA` |
| Windows execution | `SystemRoot`, `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `PATHEXT` |
| Temporary files and locale | `TMPDIR`, `TMP`, `TEMP`, `TZ`, `LANG`, `LANGUAGE`, `LC_ALL`, `LC_ADDRESS`, `LC_COLLATE`, `LC_CTYPE`, `LC_IDENTIFICATION`, `LC_MEASUREMENT`, `LC_MESSAGES`, `LC_MONETARY`, `LC_NAME`, `LC_NUMERIC`, `LC_PAPER`, `LC_TELEPHONE`, `LC_TIME` |
| Terminal | `TERM`, `COLORTERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `NO_COLOR`, `FORCE_COLOR` |
| XDG directories | `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR` |
| Proxies | `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, and their lowercase equivalents |
| Certificate trust | `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `NODE_USE_SYSTEM_CA`, `NODE_USE_ENV_PROXY`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE` |
| Host/runtime configuration | `NODE_ENV`, `O8_DATA_DIR`, `CORTEX_IDE_DATA_DIR`, `O8_API_PORT`, `O8_WS_PORT` |

Each runtime additionally receives its own configuration variables:

| Runtime | Variables |
| --- | --- |
| Codex | `CODEX_HOME` |
| Claude Code | `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_TMPDIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `MAX_THINKING_TOKENS` |
| Gemini | `GEMINI_CLI_HOME`, `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`, `GEMINI_CLI_USE_VERTEX`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS` |
| OpenCode | `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_DISABLE_AUTOUPDATE` |
| Pi CLI | `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` |
| Hermes | `HERMES_HOME` |
| OpenClaw backend | `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH` |
| OpenHands | `OPENHANDS_API_KEY`, `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL` |
| Cursor | `CURSOR_API_KEY` |
| Grok | `GROK_CODE_XAI_API_KEY` |
| Goose | `GOOSE_PATH_ROOT`, `GOOSE_PROVIDER`, `GOOSE_MODEL` |
| Aider | `AIDER_CONFIG`, `AIDER_MODEL` |
| Qwen | `QWEN_CODE_HOME`, `QWEN_API_KEY`, `DASHSCOPE_API_KEY` |
| Kimi | `KIMI_HOME`, `KIMI_API_KEY`, `MOONSHOT_API_KEY` |
| Crush | `CRUSH_GLOBAL_CONFIG`, `CRUSH_GLOBAL_DATA`, `HYPER_API_KEY` |
| Antigravity | `ANTIGRAVITY_HOME` |
| Copilot CLI | `COPILOT_HOME`, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_PROVIDER_TYPE`, `COPILOT_PROVIDER_BASE_URL` |

Prime Agent, Muse, DeepSeek Harness, Qoder, and 3Code use the common
list plus the configuration o8 supplies for the task. Existing runtime login
files remain available through the selected home/config directories. This
allowlist limits environment inheritance; it does not isolate filesystem access.

After selecting ambient variables, o8 merges adapter and per-task inputs such as
`PWD`, `PATH`, `BROWSER`, `O8_WORKER_TOKEN`, `O8_WORKER_PACKET_ID`,
`O8_OWNED_RUN_MARKER`, isolated config homes, and local gateway transport tokens.
Existing billing and provider credential policy still decides which API
credentials o8 injects. Subscription mode does not gain API credentials from this
setting. Restricted/controlled workers retain their stricter credential policy.

## Adding a variable

Set **`O8_WORKER_ENV_ALLOW`** in the environment that starts o8. It accepts a
comma-separated list of exact variable names, ignores whitespace, duplicate names,
and unset variables, and does not expand wildcards:

```sh
export O8_WORKER_ENV_ALLOW=MY_BUILD_REGION,MY_TOOL_CONFIG
```

New worker launches and resume processes receive those variables. Add only names
that tasks need. Adapter/task overrides and credential policy still take
precedence. Restart an already-running o8 host after changing its launching
shell environment. These settings do not expand bundled Pi's private environment
or restricted workers' allowlist.

## Debugging compatibility

Set **`O8_WORKER_ENV_INHERIT=1`** before starting o8 to restore full ambient
inheritance for CLI workers temporarily. Only the exact value `1` enables it.
This exposes unrelated exported variables again. Existing credential filtering,
billing policy, and restricted-worker rules still apply. Remove the setting and
restart o8 when the diagnostic session is complete.
