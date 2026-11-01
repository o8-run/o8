# Prompt actions

User prompts expose Copy, Rewind and Fork from here on hover or keyboard focus.
The row follows the prompt bubble's right edge and uses the existing native
icon, focus, tooltip, theme and reading-column primitives. It reserves its height
while hidden, so hovering does not move the conversation. No scrollbar or glass
edge fade is added.

Copy writes the exact recorded prompt, including Markdown syntax, and briefly
shows its completion. Relative time exposes the recorded date, time and local
time zone on hover. A double check means the existing `deliveryConfirmed` field
is true. A single check means saved with delivery unconfirmed. Neither claims
that a turn completed or that an agent read a message without evidence.

Fork reads the full canonical history through `GET /api/v2/chat-history`, then
saves only the prefix through the selected user message using the existing POST
and PATCH routes. Rewind confirms inline and saves the prefix before that prompt,
restoring its text and recorded images to the new composer's draft. Attached file
references remain in the prompt text. Rewind is unavailable while a turn runs.
Workers retain read-only history and Copy.

Both operations open saved continuations. The source conversation, its draft,
provider session and workspace files stay unchanged. Neither operation sends a
new provider turn. Provider sessions start cold. A quoted canonical narrative
contains only the chosen prefix, with explicit limits on carried state. Context
and the editable prompt are saved through the native per-conversation store before
the history POST makes the continuation discoverable. A fresh view consumes the
draft once. The prelude remains until it is sent through the normal queue.

The serialized context must fit the existing 128 KiB native prelude limit. An
oversized prefix offers compaction guidance before creating any conversation.
Creation performs no automatic compaction or model call. The saved canonical
prefix remains exact, including after a lost response and retry.

Creation disables repeated presses. A failed attempt retains its destination id
for retry. Retry reads canonical history even when the destination was archived;
it refuses to rewrite an archived continuation or restore its consumed draft.
A changed selection or a new send prevents late completion from taking
over the current conversation. The original draft remains in its own composer.

Implementation: `src/prompt_actions.rs`, its `continuation.rs` and `metadata.rs`,
and the transcript list in `src/composer/regions.rs`. `src/prompt_action_tests.rs`
drives painted native controls against production history and media routes in
the disposable composer fixture. It covers opening a newly listed continuation
before its create response returns. The metadata unit test covers explicit
acknowledgment and recorded timestamps.

Tracking: #5214.
