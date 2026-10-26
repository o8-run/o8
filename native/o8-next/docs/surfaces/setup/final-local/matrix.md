# Final model matrix

Written before the model correction. Each native case drives GPUI project and
tool controls, the production operator-defaults and conversation routes, and the
first production queue entry. Both persisted and queued backend/model must match.

| Choice | Without a saved model | With its saved model |
| --- | --- | --- |
| Claude | Canonical Claude default | Saved Claude model |
| Codex | Canonical Codex default | Validated local Codex default |
| OpenCode | Canonical OpenCode default | Saved OpenCode model |
| Pi | Ask for a model before creating the conversation | Detected Pi model |
| Pi API-key provider/model | Ask for a provider/model before creating the conversation | Detected provider/model choice |
| Managed o8 (additional routing check) | Canonical managed model | Retain the managed model despite an unrelated saved Claude preference |

The API-key form is Pi's explicit OpenRouter provider/model routing. The managed
o8 backend has a separate fixed model policy. No provider inference or real
credential use is part of this fixture matrix.

The recommendation matrix additionally checks a distinct local Codex model and
saved-model precedence. Native tests read production default responses rather
than copy runtime default IDs into the implementation.
