# Engineering Brain routing

In **Settings → Models → Engineering Brain**, choose how o8 pays for Brain answers.

- **Auto** is the default. On an eligible plan, classification and cited answers use managed inference. If that route is unavailable or its allowance is reached, o8 reports the condition. It does not switch to a connected CLI, local model, or BYOK key.
- **Subscription** is an explicit opt-in. It permits the existing connected-CLI Brain routes and may use their quotas.

Free plans keep the existing route behavior in Auto. Existing explicit Brain CLI selections migrate to Subscription. Cached answers may be reused only within the same routing and entitlement state; a setting or entitlement change causes the next uncached answer to use the current route.

## Text model on your own OpenRouter key

When a request goes directly to OpenRouter with your own key, Brain answers, dictation polish and the o8 Operator chat ask for `openai/gpt-6-luna` first and `nvidia/nemotron-3.5-lightning:free` second. Set `O8_OPENROUTER_TEXT_MODEL` to an OpenRouter id such as `deepseek/deepseek-v4-flash` in the app's environment to replace the first model. The `$0` fallback stays in place. The managed endpoint and local runtimes ignore the variable, and a value that is not a `vendor/model` id is ignored.
