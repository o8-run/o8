# Discovered thread import

The server exposes these routes to the native session and sidebar transports.
They use the existing API access policy and accept the usual optional
`?workspace=<absolute path>` scope.

`GET /api/runtime/discovered-sessions` returns pending Codex and Claude Code
sessions, including historical sessions beyond the dashboard's recency and row
limits:

```json
{
  "sessions": [{
    "sessionKey": "codex:<provider id>",
    "backend": "codex",
    "providerSessionId": "<provider id>",
    "title": "Existing task",
    "repoPath": "/path/to/project",
    "repoName": "project",
    "repoBranch": "main"
  }],
  "projects": [{
    "repoPath": "/path/to/project",
    "repoName": "project",
    "sessionKeys": ["codex:<provider id>"]
  }]
}
```

Claude Code session keys start with `claude-code:` and use backend `claude`.
Owned workers and sessions already bound to saved chats are omitted. Archived
chats count as existing imports. No provider config homes or identity details are
returned.

`POST /api/runtime/discovered-sessions/import` accepts
`{"sessionKeys":["codex:<id>","claude-code:<id>"]}` and returns:

```json
{
  "created": [{ "sessionKey": "codex:<id>", "tabId": "thoughts-import-<hash>" }],
  "existing": [{ "sessionKey": "claude-code:<id>", "tabId": "thoughts-<existing>" }]
}
```

Duplicate keys are collapsed; an empty selection succeeds with empty arrays.
The complete selection is checked before any chat is written. Malformed input
returns 400, unknown sessions return 404 with `error.code` equal to
`unknown_discovered_session`, and missing or ambiguous Codex rollouts return 409
with `session_not_resumable`. The 409 lists every such key in `error.sessionKeys`
(`error.sessionKey` is the first), so a picker can drop them and retry once.

Creation uses the existing chat-history POST handler, matching single-row
Continue: an empty o8 chat with `orchestratorSessionIds.codex` or
`orchestratorSessionIds.claude` set to the original provider session ID. Import
marks the chat `orchestratorVisible` so empty imports stay in history until the
first send, rather than being collected as unused placeholders. Import
does not send a prompt, copy transcripts, or launch a provider. The normal first
send continues the bound session, including the existing discovered Codex
rollout resolver/linking path.

A shared cross-process lease serializes bulk imports. Existing single-row
continuations are recognized by their saved provider bindings. Stable import
chat IDs also prevent reimport after a continuation replaces its provider
session ID. Retries preserve existing histories. If a storage failure interrupts
a batch, retry the same selection to create only the remaining chats.

o8 next's Setup offers these sessions on first launch (#5260).
