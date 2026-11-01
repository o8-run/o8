# Bots in the rail

Set up bots in **Settings → Bots** with **Add to rail**. Only explicitly selected bots
appear directly under PRs; discovery, a mailbox file, or persistent membership alone never adds
a rail entry. **Hide from rail** reverses the choice without deleting messages or membership.
Choices persist as `[bots].rail_enabled` in Settings and survive restarts. A successful native
Settings save refreshes each window's roster on its next tick without waiting 30 seconds.

Always-on bots from any house (Grok, Codex, Claude, o8 native, …) can appear there.
One click opens the bot's main thread.

- `src/lib/bots/registry.ts`: `BotEntry {id, house, name, icon {key?, url?}, mainThread {kind, id?, url?} | null, status}`.
  `listBots()` merges the per-house `PROVIDERS` with static entries from `<dataDir>/bots.json` (`{"bots": [...]}`).
- `GET /api/bots` returns the list. `GET /api/bots/:id/thread` returns `{bot, messages, externalUrl}`. Both use panel auth.
- `src/lib/bots/roster.ts` projects durable local members alongside those sources. Membership and
  explicit session bindings live beside the agent store, with additive schema v76 initialized on normal DB boot
  and through the agent store's lazy initializer.
- Native: `native/o8-next/src/surfaces/bots.rs` (rail entries and `Tab::Bot(id)`), `bots/client.rs`, `bots/view.rs`.

Bots are global destinations: no repository needs to be selected. Before any workspace exists,
bot tabs persist in the shell's empty workspace key and restore there. With a selected workspace,
they use the shell's existing tab persistence alongside its other surfaces. An unknown persisted
bot id keeps its tab and shows the server's unavailable error instead of opening a different bot.

The roster is owned by each shell window and fetched automatically at most once per 30 seconds,
with one asynchronous roster request in flight. Explicit retry bypasses the interval. Between Settings changes, a failed fetch keeps the last known entries, removes their status
dots, and exposes a retry target directly in the bot region. Successful retry restores current status.
An accepted Settings visibility change invalidates cached entries before fetching replacements, so a hidden bot cannot remain visible through a roster failure. Invalidation is scoped to the backend shared by its windows.
There is no process-wide bot cache or permanent polling thread.

The bot region scrolls directly below PRs. Its height yields to the existing rail controls and footer.
The existing destinations keep their previous layout and scroll behavior. The bot region uses only
spare height and can shrink to zero. The pre-existing fixed navigation already overflows at the
400px window minimum; a complete bot row needs another 44px of available height. Full rows and the
footer are verified at feasible short heights (540px) and normal heights. Bot rows have no drag handler.

`mainThread: {kind: "o8-thread", id}` opens the existing native conversation through the sidebar's
thread opener: it switches to the thread's workspace and reuses that workspace's active session
surface when possible. It does not render the thread as an empty mailbox. Restored or unavailable
targets show a loading/unavailable state while the thread catalog hydrates; an active bot tab opens
its native conversation if that target later appears. Deferred opening waits while an overlay or
command palette owns the pane and consumes its temporary Bot tab when resolved, so closing the native
thread or returning to the original workspace cannot reopen it. Inactive bot tabs never redirect navigation.
This references an existing o8 thread; it does not import an external vendor conversation or change
the thread's composer dispatch.

## Durable local membership

A member has an immutable local storage id, house, display name, optional icon and optional o8 home-thread
reference. Renaming changes its display name. Existing agent ids, runtime/session ids, author identities,
repository/name addresses and inbox cursors retain their original values. Membership ids are data keys;
they do not grant a bus principal or enroll a running process.

An operator can bind several already-recorded local agent sessions to one member. Each binding snapshots
the existing `agent_id`, agent name, repository, runtime and complete session key. A later presence row
with a different session/context does not silently replace that binding. A member with live matching
bindings is online; expired or disconnected bindings are offline and remain stored. The existing agent
bus six-minute liveness rule is unchanged. A member without bindings has unknown status, or retains its
existing provider's status when represented by that provider. Discovery alone never creates membership.
Membership also never selects a rail entry: choose it in Settings → Bots. Settings lists all candidates
once, and `/api/bots` returns only explicit selections. A previously selected source id remains selected
when explicitly associated with a durable member; hiding that member removes its source aliases from
Settings choices without changing the stored source or author ids.

The local maintenance command uses the checkout's Node/tsx dependencies and the existing data-directory
resolvers. It reads one command object from stdin and prints the resulting member or member list, alongside
normal DB startup/shutdown logs:

```sh
node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/bots-membership.ts <<'JSON'
{"action":"create","id":"bot-local-build","house":"claude","name":"Build bot","iconKey":"claude-code"}
JSON
```

Omit `id` to generate one and retain the returned id for future commands. Subsequent command objects:

```json
{"action":"bind","memberId":"bot-local-build","agentId":"an-existing-local-agent-id"}
{"action":"rename","memberId":"bot-local-build","name":"Build reviewer"}
{"action":"home","memberId":"bot-local-build","threadId":"an-existing-o8-thread-id"}
{"action":"source","memberId":"bot-local-build","sourceId":"claude:existing-configured-entry"}
{"action":"unbind","memberId":"bot-local-build","bindingId":"a-returned-binding-id"}
{"action":"list"}
```

`home` accepts `null` to clear the reference. Setting a home reference does not create a conversation.
`source` explicitly associates a provider/configuration id with a member for presentation and deduplication;
it is not a message address. Existing provider/configuration order is retained, the first associated source
keeps its presentation slot and mailbox context, and unrepresented members append in creation order.
Stored display names and explicit home references override source presentation. Old source ids still resolve
through the thread API, while the roster lists the canonical member once.

Membership changes have a local command seam only. This step adds no HTTP/MCP membership mutation route,
remote join or automatic discovery enrollment. A global roster does not enable cross-repository message
routing: the legacy bus continues to use each session's explicit repository and agent name. The following
sections describe the local network-thread and MCP paths over that bus.

## Local network threads

A network thread is a canonical `thoughts-*` conversation with source `bot-network`, explicitly bound
to one durable agent-bus exchange and snapshots of its local session bindings. One binding creates an
operator-to-bot conversation. Two bindings attach an existing peer exchange from the same repository.
Human replies use the existing operator identity; peer exchanges show both bot authors and are
read-only to human composition. Configuration does not enroll a process or create a new principal.

After recording membership and a local session binding, create the operator conversation locally:

```sh
node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/bots-network-thread.ts <<'JSON'
{"bindingIds":["a-returned-binding-id"]}
JSON
```

Use the returned `threadId` with the existing membership `home` command to make it the member's rail
destination. For a peer exchange, provide its existing `conversationId` and two `bindingIds`. A new
thread id can be supplied; configuration never overwrites an existing chat.

The native pane reads the ordinary thread/history endpoints. Its composer shows the recorded
recipient instead of model controls and sends plain text through the existing composer endpoint to
the agent message service. Orchestrator queue admission, lead continuation and backend execution
refuse recorded network threads, including when their JSON projection is missing. Ordinary chats
retain their backend/model routing. Attachments and live model voice are not network composition;
dictation can still fill a text draft.

The bus remains authoritative for message ids, ordering, participants, reply correlation, idempotency
and turn budgets. One thread contains one bounded exchange (8 turns by default, with the existing
extension rules). Closing or exhausting it does not silently start another; create a new exchange
explicitly. Recipient context is checked after discovery and inside admission, so an alias or a
replacement session cannot silently take the configured target.

Message authors are independent of chat role and runtime/model attribution. Source names and
session identities come from accepted bus messages; matching recorded context adds stable member
and source ids. Missing historical identity stays unattributed. Member renames do not change old
authors. Native peer messages display their author and never use the human bubble.

Send intents are reserved first. Bus acceptance and association with the existing canonical thread
commit in one SQLite transaction before runtime delivery. A saved native intent recovers an older
interrupted association before an MCP reply creates another thread. Canonical history replacement
remains a separate step, without a cross-store transaction. Already-forked databases still require
separate reconciliation; automatic repair of preexisting duplicate-thread records is outstanding.
Known nonacceptance leaves a terminal rejected receipt; uncertain acceptance
or failed history replacement returns 503 and retains the same retry identity. An unaccepted held
intent can be retried or removed. Removal leaves a cancellation tombstone, so a delayed duplicate
cannot revive it. A deliberate resend uses a fresh id. Cancellation and admission share a SQLite
fence. Accepted bus messages cannot be removed as unsent drafts, and unresolved intents prevent
inbox settlement through the existing synchronous guard.

Error responses include a matching terminal `networkSend` receipt when acceptance, cancellation or
rejection is known. The native pane retires only that cached send identity, including after navigation;
an unknown outcome keeps the same identity for retry. Native held rows provide Retry and Remove while
preserving separate editor drafts. Network text does not consume the normal-chat prompt prelude.

Projection replays the bus after retries, restarts and history-file loss, using stable message ids.
It reads authoritative state under the canonical history lock and avoids rewriting unchanged data.
Existing history metadata and inbox preference state/revisions are preserved. Rebuilding an entirely
lost JSON file recovers bus content and bindings, while file-only metadata such as a custom title is
not recoverable from the bus. Catalog reads use a nonblocking projection lock and isolate failures per
thread, retaining readable history with explicit health. Network activity does not infer Working from
a last user-role record. Physical history DELETE directs the operator to Archive, which hides the
thread while retaining its bus exchange.

A composer acknowledgement means durable bus acceptance. `poll` means the message is available in
the recipient inbox; `native` records the existing runtime handoff. Neither proves processing. The
local MCP profile below exposes those existing stages; hosted delivery is held.

## Local network MCP profile

An operator can launch the existing MCP source entrypoint with the `network` profile and one previously
recorded local binding. Run it from the checkout using Node 22 and its installed dependencies:

```sh
O8_OPERATOR_MCP_PROFILE=network O8_NETWORK_BINDING_ID=a-returned-binding-id \
  node --import tsx src/lib/mcp/operator-mcp-server.ts
```

The existing data-directory resolvers select the database. A binding is an explicit local storage and
delivery reference, not an authentication claim. Launching the profile does not join presence, enroll
a process, create membership, grant permissions or change credentials. A missing, removed or replaced
binding refuses new sends and inbox reads. Recovery of a previously accepted receipt or saved page uses
its recorded context. Normal agent workers and the operator's `o8_msg_*` tools keep their existing behavior.

This profile is **stdio only**. It refuses HTTP transport, and its tools are absent from the ordinary
operator HTTP registry. It uses the existing legacy MCP initialize flow and stateless per-request
protocol negotiation, along with the existing bounded-result paging helper.

Implemented domain tools:

- `list_team({})` returns durable members, the caller's explicit binding and the bindings in its repository.
  Membership remains visible while a session is offline. Source session ids are retained; a display-name
  rename does not rewrite addresses or historical authors.
- `send_message({to, text, requestId, replyToId?, close?})` takes a binding id from the team roster. The
  sender comes from the local launch binding. A reply needs the latest message id and obeys the existing
  exchange sequencing, close and turn-budget rules. Only an existing operator exchange can use
  `to: "operator"` with `replyToId`. Start a human question with `ask_user`.
- `check_inbox({cursor?, limit?})` reads the target session inbox and acknowledges it through the returned
  cursor using the existing bus semantics. Omit the cursor to resume its durable acknowledgement cursor.
  Follow `hasMore` for later pages. Already native/acknowledged messages are skipped even with an older
  explicit cursor; a lost inbox response is not replayed by this tool. An operator's separate
  `o8_msg_inbox` view still reads without acknowledging on the target's behalf.
- `ask_user({question, requestId})` creates a durable local question and returns its ticket immediately.
  Repeat the same arguments to retrieve its pending state or correlated human answer after a restart.

`requestId` is required for sends and is scoped to the explicit launch binding. Reuse it with identical
arguments after an uncertain result; changing the text, recipient, reply target or close flag conflicts.
Different bindings may independently use the same client request id. The service records bus acceptance
and the exchange's immutable thread-binding snapshots in one SQLite transaction. Canonical JSON history
is projected after commit. A history-write failure returns an accepted receipt with projection `pending`;
same-id retry or later inbox/catalog projection repairs the file without resending the message.
Accepted sends remain recoverable by the same request id and original arguments after the target's
presence is replaced or removed; new acceptance still requires the exact current delivery context.

The returned exchange thread can be assigned as a member's `home` using the local membership command.
No home thread is chosen automatically when a member has several sessions or conversations. Existing
operator and peer threads are reused by exchange id, and both peers retain their own author identities.

Receipts distinguish durable acceptance from the bus's `poll`, `native` or `failed` delivery field and note.
`native` can mean a runtime handoff or a target inbox acknowledgement; none of these stages proves peer
processing. There is no `message_status` tool with a stronger receipt.

Large results use `o8_result_page` in the same way as operator tools. Follow `nextArguments` to recover
the saved result without repeating a send or inbox read. The saved pages are process-local, expire after
five minutes or eviction, and are lost on process restart. The durable bus and inbox acknowledgements
survive restart; saved result pages do not turn target inbox acknowledgement into replay or exactly-once
delivery.
Saved pages remain readable in their existing process/data-directory/profile/binding scope after a
presence change. New inbox reads validate the exact binding and select/acknowledge its inbox together
under one SQLite write transaction; file projection happens after that transaction commits.

The proof in `tests/bot-network-mcp-real-path.test.ts` launches two independent scripted local stdio
protocol clients through the actual entrypoint and dispatcher. A discovers B, sends, B checks its inbox
and replies with correlation, and A receives the reply. It covers deduplication, restart/cursor behavior,
failed file projection and immutable peer authorship. These are scripted sessions, **not live Claude Code
or Grok Bot validation**. Hosted delivery, remote/tunneled endpoints, pairing and identity trust remain held.

## Durable local questions

The stdio network profile's `ask_user` tool puts one question into a canonical network thread and the
existing native Inbox's **Needs reply** lane. A question accepts up to 4,000 UTF-16 units and a stable
`requestId`. Its scope includes the launch binding, so retrying the same question coalesces across
independent sessions; changing its text under that request id conflicts. A new question uses a new id.

Schema v78 records question purpose and correlation alongside the existing bus and network binding in
the same SQLite admission transaction. The bus owns the full question and answer text. Canonical history
is a separate, replayable projection: failed history writes return projection `pending`, and retry or
catalog reconciliation can rebuild it after a restart without sending the question again. Existing pin,
snooze and Inbox preference revisions are preserved.

The existing supervisor-inbox GET optionally includes questions. A bounded question-only read supplies
the oldest 64 pending questions, with a truncation indicator and previews of up to 1,200 UTF-16 units
plus an ellipsis, preserving Unicode boundaries. Full text remains in the ticket and native thread. The native question feed refreshes every
ten seconds independently of the existing five-minute full Inbox refresh, preserving previous cards on
failure and showing an error. Workspace filtering uses the recorded local delivery context.

**Answer in thread** opens the real native conversation through the existing session opener. Its composer
sends a correlated operator reply through the durable bus; it does not start a lead/model turn. An accepted
answer removes the pending question on refresh and remains available through the original `ask_user`
ticket after the client's session restarts or acknowledges its inbox. `check_inbox` also receives that
reply with its existing acknowledgement semantics. Acceptance still does not prove reading or processing.

The production-path and headless native tests use scripted local MCP clients, not live Claude or Grok.
Settle/park and the separate exchange Inbox port are unchanged. No hosted delivery or bridge is added.

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
- Display text is capped at 20,000 UTF-16 units and bot names at 80. A cutoff through a surrogate
  pair drops the whole pair, preserving valid Unicode for the native JSON decoder. Source message ids are unchanged.
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

## Earlier mailbox reply proposal (not built)

Local network threads above use the existing durable agent bus. The following is the earlier mailbox
reply proposal, retained for context; it is not the current reply implementation.

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
