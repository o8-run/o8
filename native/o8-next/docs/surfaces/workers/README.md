# Workers

Open Workers from the command palette in a selected workspace. Working, Needs review and Blocked show counts from the same server-enriched packets displayed in the desktop. Compact changes card density. Left and Right switch filters; Up and Down select tasks; F5 refreshes.

The module owns one shell registration line, its task entities, view and fixture. It reads `/api/orchestrator/state` and `/api/lanes?active=true`. The desktop's `/api/orchestrator/lane-events` long poll invalidates the projection; a five-second discovery read includes newly queued packets without lanes. It keeps each filter's scroll handle and the selected task. Equal visible task data retains the existing entity and render revision. HTTP errors retain the last successful tasks.

No lifecycle reconciliation or scheduler runs in the native client. Filter membership projects the server's packet status; lane data supplies its existing identity. The fixture is disposable and calls production route handlers through the existing host and authentication middleware.

## Evidence

The item-1 evidence directory records failing and passing tails for the real shell/GPUI test and route-host test. The GPUI test drives the command palette, filters, selection, compact control and a persisted lane change delivered through the production lane-events route.

The item-1 PNGs compare an actual native frame in a private virtual display using software rendering with the existing desktop worker components rendered under their All Glass theme. The desktop reference uses the same blocked-task sentence. This establishes the Linux fallback layout, not macOS material or physical compositor performance. The view consumes shared theme tokens; macOS All Glass material, exact type shaping and visual parity still require the platform capture run tracked by #4711.

## Task card

Each task now shows its repository chip, task reference, title, a plain worker status sentence and a status pill. Activity opens the existing `/api/lanes/:id?events=500` route lazily for its newest bounded window and renders numbered messages in the server's order. Equal activity responses retain the view. Collapsing and reopening reuse the card and scroll handle; Enter or Space opens activity for a keyboard-selected card. Errors retain prior activity and reopening retries the read.

The item-2 GPUI test opens the real palette, selects the blocked filter, reads three persisted activity steps, and verifies that expanding and collapsing keep the card's origin. The route test verifies the same production event handler. The native screenshot shows the Linux fallback; the adjacent reference uses existing desktop worker components under All Glass. macOS material and exact visual parity remain open under #4711.

## Card review round 1

Up and Down continue peer selection when Activity has card focus. Escape returns focus to the list, including its filter shortcuts. Activity now uses the desktop lane-detail route's newest 500 events instead of repeatedly reading the first tail page. The review tests seed 515 progress records, assert that progress 515 appears, append another persisted event, and verify the refreshed window includes it. Red and green native tails are recorded beside the item-2 evidence.

## Card review round 2

Primary mouse presses select and focus a card during capture, before Activity or another child control handles the event. Child controls retain their own subsequent focus handling. Up and Down derive their starting position from the focused card, falling back to list selection when the list has focus. The GPUI regression selects A, clicks B Activity, presses Enter then Down, and verifies C is selected and focused, including that the Activity click selected B first. The item-2 review-r2 tails record the failure on the prior head and the passing test after the fix.

## Conflict and adjust actions

Inspect conflict opens the existing native diff viewer inside the task using the desktop's `/api/worktrees/diff` route. The target is the selected task's lane worktree, falling back to its lane repository or packet workspace in the same order as the desktop. The native client does not invent a conflicting-owner path when the server supplies none; this opens the task's complete workspace diff.

Keep waiting reads `/api/lanes/:id?events=0` to check the current lane and leaves the durable queue unchanged. It does not resume or redispatch the worker. The inline editor is the existing native composer. Send calls `/api/orchestrator/steer-packet` with the exact packet ID, message, operator source and a stable idempotency key. A lost response retains the frozen request and draft; Retry reuses it. Confirmed delivery clears only an unchanged draft, so edits made during a request survive.

Tab and Shift+Tab traverse enabled actions and the editor; Enter or Space activates an action. Controls are disabled during a request. Each action has a GPUI test that asserts the actual server call. The lost-response fixture runs the production route and persisted idempotency service twice while replacing only the external runtime discovery/resume leaf: it records two identical HTTP bodies and one delivery.

The item-3 screenshots show the native actions and draft beside the current desktop worker components in All Glass. macOS material, exact type shaping and shared shell chrome still require the visual parity work in #4711.

## Action review round 1

Unconfirmed requests and composer drafts are saved per workspace and packet in a surface-owned `workers.json` sibling of the shell state. The owner-only file is atomically replaced and synced before Send can call the server. Closing Workers or opening a fresh shell restores the frozen request, including its original idempotency key. A confirmed response removes that pending entry and clears only an unchanged draft; drafts on other cards remain. Unavailable local storage prevents delivery until saving succeeds. The GPUI regression drops a successful real-route response, destroys the original Workers view, opens a fresh shell, and verifies identical request bodies with one runtime delivery after retry.
