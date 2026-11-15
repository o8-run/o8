# Local-model coverage

This audit covers the registered orchestrator backends, every dispatchable worker runtime, and the requested model-calling support surfaces at HEAD. “Yes” means o8 explicitly selects a loopback or on-device route. “Partial” means a route exists but depends on plan order, fallback behavior, or runtime-owned configuration that o8 cannot verify. “No” means the current adapter has no local launch contract.

| Surface | Local path today | Selection | Decision point | Gap |
|---|---|---|---|---|
| Orchestrator: codex | Yes | Composer model or default dispatch model; `ollama:` / `lmstudio:` prefix; `O8_DISPATCH_MODEL` or persisted setting | `src/lib/lane/codex-orchestrator-session.ts:233` | No fail-closed local-only guard or route receipt. |
| Orchestrator: claude | No | Model-source setting chooses native, API, or subscription carrier | `src/lib/lane/claude-harness-carrier.ts:48` | No local endpoint carrier. |
| Orchestrator: openclaw | Partial | Runtime-owned agent model config; composer model if it is in the agent allowlist | `src/lib/lane/orchestrator-backends/openclaw.ts:489` | o8 inherits the route but cannot assert that it is local. |
| Orchestrator: hermes | Partial | Runtime-owned provider/model config exposed through the ACP model catalog | `src/lib/lane/orchestrator-backends/acp.ts:237` | No o8 local setting, endpoint probe, or route receipt. |
| Orchestrator: acp | Partial | `O8_ACP_COMMAND` / `O8_ACP_ARGS`; model comes from the external ACP agent | `src/lib/lane/orchestrator-backends/acp.ts:456` | An arbitrary local ACP agent can work, but locality is opaque to o8. |
| Orchestrator: collide | Partial | `O8_COLLIDE_PROPOSERS` / `O8_COLLIDE_AGGREGATOR` JSON can select codex participants with local prefixes | `src/lib/lane/orchestrator-backends/collide-config.ts:99` | Default participants are mixed; no local-only preset or all-participant validation. |
| Orchestrator: fable | No | `O8_FABLE_MODEL`, then the claude model guard and native carrier | `src/lib/lane/orchestrator-backends/fable-config.ts:35`; `src/lib/lane/orchestrator-model-guard.ts:60` | No local carrier; local prefixes are incompatible with this backend. |
| Orchestrator: o8 | Partial | Local inference endpoint/chat-model setting or env, routed through the operator proxy | `src/app/api/v2/proxy/llm/route.ts:423`; `src/lib/cortex/qa/llm/inference-route.ts:177` | Managed entitlement wins before local, and no local-only mode prevents fallback. |
| Orchestrator: opencode | Partial | Discovered model setting plus runtime-owned provider config | `src/lib/lane/orchestrator-backends/acp.ts:81`; `src/lib/lane/orchestrator-backends/acp.ts:396` | Local models can appear in the catalog, but o8 does not verify endpoint locality. |
| Worker: codex | Yes | Mission model or default dispatch model; `ollama:` / `lmstudio:` prefix; `O8_DISPATCH_MODEL` or persisted setting | `src/lib/codex/owned.ts:281` | No fail-closed local-only guard or route receipt. |
| Worker: claude-code | No | Worker model-source setting; native, API, or subscription carrier | `src/lib/claude-code/worker-profile-types.ts:1` | No local endpoint carrier. |
| Worker: gemini | No | Mission/default model passed to the same runtime CLI | `src/lib/gemini/owned.ts:149` | No local provider or endpoint contract. |
| Runtime: magnitude | Yes (terminal only) | Runtime-owned | `src/lib/orchestrator/runtime-capabilities.ts:156` | Not dispatchable, so no packet can use it. |
| Worker: opencode | Partial | `opencodeWorkerModel` setting or mission model plus runtime-owned provider config | `src/lib/opencode/owned.ts:35` | o8 passes the model but cannot verify that its provider is local. |
| Worker: openhands | Partial | Runtime-owned `.openhands/config.toml`; o8 passes no model or endpoint | `src/lib/orchestrator/runtime-capabilities.ts:201` | Locality is possible only through opaque runtime configuration. |
| Worker: goose | Partial | Runtime-owned provider config; o8 passes no model or endpoint | `src/lib/orchestrator/runtime-capabilities.ts:223` | Locality is possible only through opaque runtime configuration. |
| Worker: qwen | No | Runtime login/config; fixed headless launch arguments | `src/lib/orchestrator/runtime-capabilities.ts:246` | No local model or endpoint selection in the adapter. |
| Worker: qoder | No | Runtime login; launch pins its bundled model | `src/lib/orchestrator/runtime-capabilities.ts:268` | No local model or endpoint selection in the adapter. |
| Worker: kimi | No | Runtime login/config; prompt-only launch | `src/lib/orchestrator/runtime-capabilities.ts:290` | No local model or endpoint selection in the adapter. |
| Worker: aider | Partial | Runtime-owned `.aider.conf.yml`; o8 passes no model or endpoint | `src/lib/orchestrator/runtime-capabilities.ts:312` | Locality is possible only through opaque runtime configuration. |
| Worker: 3code | Partial | Runtime-owned provider config; o8 passes session path and prompt | `src/lib/orchestrator/runtime-capabilities.ts:333` | The runtime is local-first, but o8 neither selects nor verifies the provider. |
| Worker: pi | Partial | Mission/default model passed to runtime-owned provider config | `src/lib/pi/owned.ts:300` | o8 selects a model id but has no local provider or endpoint receipt. |
| Worker: cursor | No | Mission/default model passed to the same runtime CLI | `src/lib/cursor/owned.ts:46` | No local provider or endpoint contract. |
| Worker: grok | No | Mission/default model passed to the same runtime CLI | `src/lib/grok/owned.ts:67` | No local provider or endpoint contract. |
| Worker: prime-agent | Partial | Runtime-owned provider config; o8 passes no model or endpoint | `src/lib/prime-agent/owned.ts:49` | Locality is possible only through opaque runtime configuration. |
| Worker: deepseek-harness | No | `O8_DEEPSEEK_HARNESS_PROVIDER` selects one of two network providers | `src/lib/deepseek-harness/runtime-resolution.ts:52` | Provider enum has no local inference route. |
| Brain: classify | Partial | `O8_LOCAL_INFERENCE_BASE_URL` + `O8_LOCAL_CHAT_MODEL` or persisted settings; liveness-gated HTTP tier | `src/lib/cortex/qa/classifier.ts:180`; `src/lib/cortex/qa/llm/inference-route.ts:177` | Managed entitlement wins before local; later cloud and CLI fallbacks remain reachable. |
| Brain: compose | Partial | Same local settings/env; `classAComposer=fastest` reaches the HTTP route before CLI tiers | `src/lib/cortex/qa/compose-class-a.ts:219` | Default composition can try subscription CLIs first; local is not enforceable. |
| Dictation polish | No | Claude Haiku through the Anthropic API key only | `src/app/api/dictation/polish/route.ts` | No local route; without a key the transcript goes out unpolished. |
| TTS | Partial | Automatic network synthesis, then OS/browser speech fallback | `src/lib/tts/engine.ts:259`; `src-tauri/src/tts/native_say.rs:52` | Offline speech exists only as a fallback and cannot be selected as primary. |
| Settings / Diagnostics detection | Partial | Persisted local settings or env; configured-endpoint probe plus fixed default-runtime probe | `src/lib/cortex/qa/llm/inference-route.ts:178`; `src/app/api/setup/detect/route.ts:443` | Model discovery tries `/api/tags` first, then `/v1/models`; Diagnostics does not show effective per-surface routes. |

## Verifiable egress harness

`tests/local-egress-assertion-real-path.test.ts` drives a real packet through
dispatch → worker → Brain → review → merge while a process-level preload records
TCP destinations in both the o8 process and inherited Node worker processes.
Unexpected non-loopback destinations are recorded before connect and blocked;
loopback o8-internal IPC is excluded, while the configured local-provider
endpoint remains in the report. The test prints an `o8/local-egress-report/v1`
baseline with per-surface endpoint counts.

## Issue-worthy gaps

- Add fail-closed local-only enforcement with per-surface routing receipts [L]
- Let paid-plan Brain, dictation, and o8 routes honor explicit local selection [M]
- Add a local-only Collide preset with all-participant validation [M]
- Expose verified local-provider controls for runtime-configured backends and workers [L]
- Add local launch contracts to cloud-bound dispatch runtimes [L]
- Make offline TTS selectable as the primary provider [M]
- Give the magnitude runtime a dispatch contract once its headless/RPC surface stabilizes [M]
