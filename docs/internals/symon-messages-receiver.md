# Symon Messages receiver

Historical reference: the Symon WS implementation and its dedicated tests were removed. Paths below describe the former implementation.

On macOS, o8 can receive iMessages for Symon itself and answer them, with no
external connector. Source: `src/lib/symon/messages-receiver/`.

## What the user needs

- A Mac that is on, with Messages signed in.
- Full Disk Access for o8, so it can read the Messages database.
- Automation access from o8 to Messages, which macOS asks for on the first reply.
- A sender other than the Mac's own Messages account: the user texts the Mac's
  account from another number or Apple ID. Messages the Mac's account sends are
  never read.

Without a Mac, Symon is reachable from the o8 phone app.

## Behavior

- Off until enabled through `POST /api/panel/symon/messages-receiver` with
  `{ enabled, handles }`. Handles are `+15555550100` or an email address, at
  most 20. `GET` returns `state` (`off`, `unsupported`, `missing_permission`,
  `unavailable`, `listening`), `enabled` and `handles`.
- The first enabled pass records the newest message as its starting point, so
  history is never answered. Changing the handles starts again from the newest
  message.
- The query reads only one-to-one chats, only messages not sent by this Mac,
  and only from the authorized handles. The handle filter runs inside SQLite, so
  text from anyone else never reaches o8. Group chats are not read.
- Text kept only in `attributedBody` is decoded from the archived string.
- Each message enters the same path as the external connector,
  `handleManagedMessage()`, with `eventId` `imessage:<message guid>` and
  `conversationId` `imessage:direct:<handle>`. Access rules, the brain choice,
  durability and receipts are the same.
- A message whose answer is not ready stays unhandled and is asked again on the
  next pass. A message is recorded as answered before its reply is sent, so a
  restart or a failed send never sends a second reply.
- Replies go through Messages with `osascript`; the handle and text are passed
  as arguments, never inside the script.
- State lives in `<data dir>/symon/messages-receiver.json`.

## One receiver at a time

Enabling o8's receiver turns the external connector off, and enabling the
connector in Settings turns o8's receiver off, so a message is never answered
twice.

## Loop

The server starts one loop on macOS (`src/instrumentation.ts`). It checks every
3 seconds while listening, every 10 seconds while off, and every 60 seconds
after a missing permission or an unreadable database.

## Tests

- `tests/symon-messages-receiver-real-path.test.ts`: a fixture Messages database
  with history, authorized and unauthorized handles, messages from this Mac and
  a group chat; restart without replay; a pending answer; a failed send; archived
  text; missing database and unsupported platform; and the full path through the
  inbound handler on the built-in Pi brain.
- `src/app/api/panel/symon/imessage-access/route.test.ts`: only one receiver is
  enabled at a time.
