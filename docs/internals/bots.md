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

- Writers append complete JSON objects followed by a newline. Only newline-terminated records are visible;
  an unfinished final record becomes visible on a later read after its newline arrives. Malformed and unknown records are skipped.
- Each request asynchronously reads at most the last **1 MiB** from one opened descriptor, bounded to
  its initially observed size. For a cropped file the budget includes one preceding byte of boundary
  context, leaving up to 1 MiB minus 1 byte of payload. A record crossing the payload boundary is
  discarded, so fewer than 500 messages may fit. An individual
  record larger than the byte window is omitted. No earlier or rotated files are scanned.
- Producers must append while readers are active, rotating by rename and replacement rather than
  in-place rewriting or truncation. An opened descriptor does not freeze concurrent file contents.
- Within that byte window, the first complete valid occurrence of a message id wins. Deduplication happens
  before the 500-message display limit. Supplied ids are preserved in full, within the input byte budget,
  and their deduplication identities are separate from legacy fallback ids. Stable ids refer to immutable
  messages; use a new id for a new turn. This is not global history deduplication or an exactly-once guarantee.
- Returned records carry a server-owned `key` with that same namespace (`id:<sourceId>` or
  `byte:<absoluteOffset>`). Native reading anchors use this key, so a legacy record and an explicitly
  identified record remain distinct even when their public ids and content are identical. The producer's
  `id` is preserved unchanged. If an anchored key leaves the retained window, another record with the
  same public id does not replace it.
- When every retained message has a parseable ISO timestamp with an explicit timezone, messages are sorted
  chronologically with append order breaking equal-time ties. If any timestamp is missing or invalid,
  the entire window retains append order. Clock skew is not detected or repaired.
- Legacy records without an id receive a fallback based on their absolute byte offset. It remains stable
  as the file is appended, but writers must supply stable ids for rotation or mirror/backfill deduplication.
- o8 reads the file and never writes to it (v1 is read-only). Status is `online` when the file changed in the last 15 minutes, `offline` when it is older, and `unknown` when there is no file.
- Another house can use the same mailbox: return `mainThread: {kind: "mailbox", id}` from its provider.
  For an o8 thread use `kind: "o8-thread"`. For a link only use `kind: "url"`.

The native mirror polls no more than once per 10 seconds during shell maintenance, including for
retained inactive tabs. Explicit Refresh can request an immediate read; at most one request per view
is in flight. A changed transcript follows the bottom only if the reader was already within 2 pixels
of it, including when the 500-message window rolls forward. While reading older messages, the visible
message and its within-row position are anchored across refreshes. If that message leaves the bounded
window, the view returns to the oldest retained message; earlier history is no longer available there.

## Proposed: live conversation (design only, not built)

The goal is to see a bot's real conversation in o8 and reply from o8. Two pieces:

**Mirror (bot to o8).** Each time the Grok bot sends or receives a message, it appends that message to
`~/.o8/bots/grok/<agentId>/thread.jsonl`. A backfill routine (every few minutes) reads the bot's own
transcript through its sanctioned tools and appends any missing lines, so both sides are covered even when
a turn was not mirrored live. Ids are stable (`<turnId>:<index>`), so duplicates within the bounded read window are shown once.

**Reply (o8 to bot).** The bot thread view gets a composer. Send:
1. appends `{id, role: "user", text, at, state: "pending"}` to `outbox.jsonl` next to the thread (o8 owns this file, the bot owns `thread.jsonl`);
2. `POST`s `{botId, messageId, text}` to the bot's inbound webhook (`inbound.webhook` in the provider entry or `bots.json`). Grok Bot routines can start a run from a webhook; the run reads the message, answers, and appends both the user line (same `messageId`) and its reply to `thread.jsonl`;
3. o8 polls every 10 s. A pending outbox line whose id shows up in `thread.jsonl` is marked delivered. After a timeout it is shown as failed, with a retry.

**House adapter contract.** Each house supplies:
`discover() -> BotEntry[]`; `mainThread`: `mailbox` file | `o8-thread` id | `url`; and an optional `inbound` (webhook URL plus a reference to its secret).
Codex, Claude, Meta Muse and o8 native bots plug in with the same shape. Aggregators such as Reason Network (MCP `list_team` / `send_message`) or ACP clients could be one more house adapter, or could replace the mailbox for agents that speak them.

**Open questions.**
- Where the webhook secret lives. Proposal: the o8 vault/keychain, with `bots.json` holding only a reference and never the secret.
- Whether a bot can see the user's text before o8 records it as pending (ordering).
- Rotation size and retention for `thread.jsonl`.
- Whether to show the mirror when the bot is offline, and how stale "online" should be.
- One thread per bot or several (Grok Bot has one main chat; Codex/Claude have many sessions).

**Threat model.**
- *Webhook secret*: if it leaks, anyone can wake the bot with arbitrary text. Keep it out of files and logs, send it only over HTTPS, and rotate it.
- *Loopback*: `/api/bots*` stays behind panel auth. The composer POST goes from the o8 server, never from the webview, so the secret never reaches the UI.
- *Spoofed file writes*: any local process running as the user can write `thread.jsonl`. The mirror is display-only and is never treated as an instruction to o8; it is rendered as plain text, never as markup or links that auto-run.
- *Ordering and duplicate ids*: the read-only contract above applies within the 1 MiB window. Future
  delivery acknowledgements need durable receipts; looking for an id in the visible tail cannot prove delivery.
- *File growth*: reads are bounded to 1 MiB and 500 distinct messages. Rotation and retention remain a
  producer concern; the reader does not follow renamed files or carry acknowledgements across rotation.
- *Multi-machine*: the mailbox is per machine. With several machines, each one needs its own mirror; otherwise a sync layer, or a network such as Reason Network, replaces the file.
