# Engineering Brain routing

In **Settings → Models → Engineering Brain**, choose how o8 pays for Brain answers.

- **Auto** is the default. On an eligible plan, classification and cited answers use managed inference. If that route is unavailable or its allowance is reached, o8 reports the condition. It does not switch to a connected CLI, local model, or BYOK key.
- **Subscription** is an explicit opt-in. It permits the existing connected-CLI Brain routes and may use their quotas.

Free plans keep the existing route behavior in Auto. Existing explicit Brain CLI selections migrate to Subscription. Cached answers may be reused only within the same routing and entitlement state; a setting or entitlement change causes the next uncached answer to use the current route.

## Text model on your own OpenRouter key

For direct OpenRouter requests, the default primary model for Brain answers, dictation polish, and Operator chat is `openai/gpt-6-luna`. Set `O8_OPENROUTER_TEXT_MODEL` in the app's environment to a `vendor/model[:variant]` id, such as `deepseek/deepseek-v4-flash`, to replace that default primary. Unset, blank, or malformed values keep the default. For Brain calls, an explicit `model` option takes precedence over the environment variable. Managed endpoints and local runtimes ignore the variable.

The fallback depends on the caller:

| Caller | Default fallbacks after the primary, in order |
| --- | --- |
| Brain (`callOpenRouter`) | Paid: `google/gemini-2.5-flash-lite`, then `openai/gpt-5.4-nano`, then `x-ai/grok-4.3` |
| Dictation polish | `nvidia/nemotron-3.5-lightning:free` |
| Operator chat's OpenRouter chain | `nvidia/nemotron-3.5-lightning:free` |

Brain sends its fallback list in OpenRouter's `models[]` field within one request. A caller can replace that list with `fallbackModels`, or disable it with `fallbackModels: []`. An explicit `model` option changes the primary but keeps the default fallback list unless `fallbackModels` is also supplied. A `:free` primary alone therefore does not guarantee free Brain calls.

These are the existing runtime fallback rules; the environment variable changes only the default primary model.
