# Agent-assisted setup

Use the operator MCP tool `o8_setup` or the `o8 setup` CLI. The app must be running; keep onboarding open for workspace entry. These commands use the normal operator credential and existing API discovery.

```sh
o8 setup status
o8 setup configure --lead codex --workers codex --worker-model gpt-5.6-terra
o8 setup open /absolute/project/path
o8 setup status
o8 setup cancel <request-id>
```

`configure` supports `--lead-model` and `--worker-model`. Use runtime and model choices returned by status. The first worker is the default; other workers retain their runtime defaults. Claude uses `claude-code`. Codex and Fable keep their lead presets; per-conversation overrides remain available. Claude and OpenCode save separate lead models.

`status` distinguishes installed tools, local credential evidence, provider acceptance, persisted choices and sources, privacy, and incomplete steps. Credential evidence does not establish that a provider accepts a model; setup does not run a paid probe. Environment/profile overrides require changing their owning source.

`open` registers an existing Git folder and returns a durable request. Registration and `pending` do not mean the workspace opened. Visible onboarding claims it, rechecks the project and tools, follows its normal workspace entry path, and reports `opened`, `needs_tools`, `needs_privacy`, or `error`. An absent app leaves it pending. Repeating open while pending reuses the request; a new open after completion creates a new request. MCP callers can pass the previous `requestId` with the same path to read a retry receipt without reopening.

Cancellation retains registered projects and saved choices. An in-flight app operation cannot be cancelled; read its result first. A cancelled handoff does not prevent a later explicit human action. If the app stops during `applying`, its claim expires after one minute and status becomes `interrupted`. Inspect the workspace before a fresh open or cancellation; the outcome is unknown until checked.

Sign-in, operating-system permissions, and privacy choices stay with the user. The setup tool does not grant permissions, edit credentials, answer consent, run the first task, or install runtimes.
