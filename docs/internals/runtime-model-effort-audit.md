# Runtime, model and effort audit

Audit of #2520 against the worker registry and lead backend registry on 2026-10-24.
This is an app admission and transport matrix. Captured transports establish what
o8 sends, not account entitlement, installed CLI acceptance or a successful provider
turn. Dynamic model catalogs are open sets; a representative configured id tests
the adapter contract, not every model that a provider might add.

## Vocabulary and evidence

The app vocabulary is adaptive, low, medium, high, max, xhigh and ultra. Disabled,
none, minimal and off are not independent app picker values. Explicit disabled
strings are rejected. Adaptive means reset to the runtime default on worker paths;
it does not promise disabled reasoning. Omission may inherit an operator default.
The desktop manual picker does not offer adaptive as a manual reasoning tier.

Official wire contracts checked during this audit:

- [Codex model metadata](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs)
  defines an effort vocabulary and model-advertised support. App high-end pairs
  remain the recorded exact catalog entries in `src/lib/codex/reasoning-effort.ts`.
- [OpenAI API types](https://github.com/openai/openai-node/blob/master/src/resources/shared.ts)
  distinguish API reasoning effort from the Codex catalog and explicitly warn that
  models do not support every value. Codex ultra is not proof of API ultra support.
- [Anthropic API types](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts)
  distinguish adaptive, disabled, enabled thinking and output_config.effort. Enabled
  budgets must be at least 1024 and strictly smaller than max_tokens.
- [Gemini headless reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md)
  establishes the stream transport. The o8 adapter has no independent effort flag.
- [Muse SDK](https://github.com/meta-models/muse-code-sdk), installed version 1.4.6,
  describes model/list variants as the complete selectable effort set or unknown.
  Its protocol vocabulary alone does not establish model compatibility.

## Worker matrix

Here B means low, medium, high and xhigh; A means B plus max and ultra; D means
omitted/default or adaptive only. Every row also rejects the disabled string.
Defaults and model selection are from
[`runtime-capabilities.ts`](../../src/lib/orchestrator/runtime-capabilities.ts),
[`worker-catalog.ts`](../../src/lib/orchestrator/worker-catalog.ts) and each owned adapter.

| Runtime | Selectable model contract | Independent concrete effort | Actual transport and default |
| --- | --- | --- | --- |
| codex | gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-5.6-sol, gpt-5.6-terra | A | `-c model_reasoning_effort=value`; configured model, otherwise worker default |
| codex | gpt-6-luna | B and max | Same flag; ultra refused |
| codex | gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.3-codex and unknown configured ids | B | Same flag; max and ultra refused; unknown model acceptance remains unverified |
| codex | gpt-4o, ollama:model, lmstudio:model | D | Local model expands to `--oss --local-provider`; reasoning pins refused |
| cloud | Same Codex classes | Same as Codex | Durable launch.effort payload to external worker, then the same `-c` mapping; validated again at startCodex |
| claude-code | claude-fable-5-1, claude-opus-5-5, claude-fable-5, claude-fable-5[1m], claude-opus-5, claude-opus-4-8, claude-opus-4-7, claude-opus-4-6, claude-sonnet-5, claude-sonnet-4-6, claude-sonnet-4-5, claude-haiku-4-5, claude-haiku-4-5-20251001; configured carrier ids | B and max at app admission | `--effort value`; ultra refused. Per-model and carrier provider acceptance is still unknown |
| gemini | Gemini registry models or configured model | D | `--model`, `-p`, `--output-format stream-json`; no effort flag |
| antigravity | Configured model, default gemini-3.8-flash-low | D | `--model`; no effort flag |
| opencode | Discovered provider/model ids, default opencode/deepseek-v4-flash-free | D | `run --format json --model`; model-encoded variants remain model identity |
| pi | Configured external CLI model | D | RPC process/model and prompt; no independent effort field |
| pi-builtin | openai/gpt-6-luna or selected openrouter/provider/model | D | SDK model route; managed transport disables reasoning effort |
| cursor | Configured model, default cursor-agent | D | `-p --output-format stream-json`, optional `--model` |
| grok | Configured grok or x-ai model | D | JSON worker arguments, optional `--model`; no effort argument |
| prime-agent | Runtime configuration | D | `--mode json`; no independent model or effort flag |
| hermes | ACP-discovered/configured model | D | ACP session configuration and prompt; no independent effort field |
| deepseek-harness | Configured model, default deepseek-v4-pro | D | ACP harness model configuration; no independent effort field |
| muse | model/list ids or runtime default | A at current app admission | `--reasoning-effort value`; model variants are not enforced yet, #4614 |
| copilot-cli | CLI configuration | D | Declarative prompt and JSON output; no model/effort override |
| crush | CLI configuration | D | `run --quiet`; no model/effort override |
| openhands | CLI configuration | D | `--headless --json -t`; no model/effort override |
| goose | CLI configuration | D | `run -t`; no model/effort override |
| qwen | CLI configuration | D | `-p --output-format stream-json`; no model/effort override |
| qoder | Qwen3.8-Max-Preview fixed by adapter | D | Fixed `-m`; no effort override |
| kimi | CLI configuration | D | `-p`; no model/effort override |
| aider | CLI configuration | D | `--message`; no model/effort override |
| 3code | Discovered/configured model | D | `--model`, session file and resume; no effort override |
| magnitude | Operator terminal only | No governed launch | Discovery adapter; no packet dispatch or resume |
| remote-customer | Optional startup-gated adapter, modelHint | Unverified | LaunchRequest omits effort, #4621; not in the mission picker or canonical matrix test |

Fresh and resumed owned Codex/Claude/Muse processes use their saved model and effort.
The common owned spawn boundary also checks retries. Inherited saved defaults are
normalized for the selected model before persistence; an incompatible explicit pin
is refused. A saved explicit pin that becomes incompatible is refused on resume,
rather than rewritten. This preserves the original request as evidence.

## Lead and API matrix

Worker and lead backends are separate contracts. The registered lead backends are
claude, codex, openclaw, hermes, acp, opencode, collide, fable, o8, pi and muse.

| Surface | Selection to wire | Receipt and remaining limit |
| --- | --- | --- |
| Desktop selector | Per-model storage to thinkingEffort on the prepared turn; stale choices on default-only backends normalize to adaptive | Valid per-model choices survive switching away and back |
| Claude and Fable leads | Model plus `--effort`; adaptive omits the flag | turn_receipt contains the mapped value; ultra becomes max, #4617 |
| Codex lead | Model plus `-c model_reasoning_effort`; omitted/adaptive uses app policy xhigh | Receipt follows resolved effort; model/version coercion remains, #4617 |
| OpenClaw lead | `--thinking value`; omission adds no flag | ultra exceeds the documented adapter vocabulary, #4619 |
| ACP, Hermes and OpenCode leads | Discovered model or exact model-encoded effort variant to ACP session configuration | Independent thinkingEffort is not applied, despite the receipt, #4615 |
| Pi lead | Managed or OpenRouter SDK route, no independent reasoning override | Receipt may echo a concrete request or medium, #4615 |
| Muse lead | model/list and session model, then turn/start.reasoningEffort | Model-specific variants still unchecked, #4614 |
| Collide lead | Configured participant backend/model/effort plus aggregator override | Inherits each participant backend's limitations |
| o8 lead | Fixed managed Low service tier, SDK or text fallback | Low is a service tier, not observed provider reasoning; no effort picker |
| Mobile chat | No per-model picker; optional effort to CLI proxy after shape validation | CLI proxy validates compatibility; existing #4332 fix retained |
| Mobile global settings | Global thinkingEffort preference | Separate from per-model worker effort; downstream lead limitations still apply |
| Mobile Ask | Separate allowlisted model and effort vocabulary to planner route | Opus low becomes medium; malformed values become xhigh, #4620 |
| CLI chat API | effort to Codex argv; Gemini/OpenCode concrete pins refused | Captured executable tests retained; no live provider claim |
| Native OpenAI API | o3, o3-mini, o4-mini, including YYYY-MM-DD snapshots: low/medium/high to reasoning_effort | Effort support uses the family; the request keeps the exact snapshot id. Other concrete pairs are refused |
| Native Anthropic API | Existing thinking model families, including YYYYMMDD snapshots: low/medium/high/max/xhigh to budgets 4000/10000/24000/48000/60000 | The request keeps the exact snapshot id; max_tokens reserves 4000 answer tokens, at most 64000 for these mappings; ultra/unmapped models refused |
| Native Anthropic default/adaptive | Omission selects adaptive on the existing adaptive-model allowlist; explicit adaptive omits thinking | This historical default/reset distinction does not mean disabled thinking |
| Native Google and ChatGPT plan APIs | Omitted/default or adaptive only | Concrete independent effort refused; current transports have no verified mapping |
| Operator API | Existing managed Low/High service policy | A service tier; provider and fallback policy determine actual reasoning |

The native Anthropic budget mapping is an app budget policy, not proof of the
provider's model-specific native output_config.effort support. API and CLI catalogs
are not interchangeable. Disabled reasoning would need its own transport-specific
contract; this change does not invent a new app enum value.

## Persistence, dispatch and coverage

Mission CLI/MCP and create-mission/spawn-prompt APIs resolve effort aliases before
creation. WorkerRouting persists requestedEffort and selectedEffort. Delegation
also checks the discovered worker catalog. Dispatch resolves inherited defaults,
checks honored pins, launches the lane and records the effective role-routing
receipt. Runtime launch POST persists an idempotency binding and replays the same
result after database reopening. Owned session metadata then supplies fresh,
retry and resume argv. External cloud workers validate the delivered payload
before spawning. Known action-route effort refusals persist as typed 400 receipts.
Existing mission pin, CLI chat and mobile validation fixes are
retained; legacy internal targeting no-op semantics are not promoted to pin support.

`tests/runtime-effort-matrix-real-path.test.ts` drives 873 model/runtime/effort
vectors through the actual launch POST plus a registry-completeness check. It
checks admission, persisted replay and Codex/Claude/Muse argument mappings. The
launch boundary is captured. `tests/runtime-effort-compatibility-real-path.test.ts`
adds real executable launch, cold resume, saved-default normalization and external
worker captures. `tests/llm-effort-compatibility-real-path.test.ts` captures native
API payloads. `ComposerSelectorModelRestore.test.ts` mounts the real selector and
checks saved state. Existing mission, spawn, delegation, mobile and CLI fixtures
cover their entry points. None of these tests contacts a paid model.

The parent remains open: #4614, #4615, #4617, #4619, #4620 and #4621 need fixes and real
entry-point regressions. Per-model Claude/carrier acceptance and installed-version
acceptance also remain unverified. The matrix
does not claim full native-provider acceptance or complete lead-to-provider parity.
