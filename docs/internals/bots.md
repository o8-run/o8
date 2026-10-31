# Bots in the rail

Always-on bots from any house (Grok, Codex, Claude, o8 native, …) appear in the
o8 next rail directly under PRs. One click opens the bot's main thread.

- `src/lib/bots/registry.ts`: `BotEntry {id, house, name, icon {key?, url?}, mainThread {kind, id?, url?} | null, status}`.
  `listBots()` merges the per-house `PROVIDERS` with static entries from `<dataDir>/bots.json` (`{"bots": [...]}`).
- `GET /api/bots` returns the list. `GET /api/bots/:id/thread` returns `{bot, messages, externalUrl}`. Both use panel auth.
- Native: `native/o8-next/src/surfaces/bots.rs` (rail entries and `Tab::Bot(id)`), `bots/client.rs`, `bots/view.rs`.

## Grok provider and its mailbox

The Grok provider finds Grok Bot agents whose data directory is on this machine
(`$O8_GROK_AGENT_DATA` or `~/agent-data/agents/<agentId>/profile.json`). It reads
only the `name` field. The Grok Bot chat is not stored on the machine, and there is
no sanctioned local API for it. So the main thread is an o8 **mailbox** the bot
writes into, plus the app's deep link `grokbot://app/v1/agent?id=<agentId>`
(the "Open in app" button). The deep link opens only where the Grok Bot app is installed.

Mailbox: `<dataDir>/bots/<house>/<agentId>/thread.jsonl`, appended one JSON object per line:

```json
{"id": "m42", "role": "user" | "bot" | "system", "text": "…", "at": "2026-10-31T22:30:00Z"}
```

- Writers append whole lines only. o8 skips torn or unknown lines and shows the last 500 messages.
- o8 reads the file and never writes to it (v1 is read-only). Status is `online` when the file changed in the last 15 minutes, `offline` when it is older, and `unknown` when there is no file.
- Another house can use the same mailbox: return `mainThread: {kind: "mailbox", id}` from its provider.
  For an o8 thread use `kind: "o8-thread"`. For a link only use `kind: "url"`.
