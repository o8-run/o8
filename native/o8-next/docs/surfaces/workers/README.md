# Workers

Open Workers from the command palette in a selected workspace. Working, Needs review and Blocked show counts from the same server-enriched packets displayed in the desktop. Compact changes card density. Left and Right switch filters; Up and Down select tasks; F5 refreshes.

The module owns one shell registration line, its task entities, view and fixture. It reads `/api/orchestrator/state` and `/api/lanes?active=true`. The desktop's `/api/orchestrator/lane-events` long poll invalidates the projection; a five-second discovery read includes newly queued packets without lanes. It keeps each filter's scroll handle and the selected task. Equal visible task data retains the existing entity and render revision. HTTP errors retain the last successful tasks.

No lifecycle reconciliation or scheduler runs in the native client. Filter membership projects the server's packet status; lane data supplies its existing identity. The fixture is disposable and calls production route handlers through the existing host and authentication middleware.

## Evidence

The item-1 evidence directory records failing and passing tails for the real shell/GPUI test and route-host test. The GPUI test drives the command palette, filters, selection, compact control and a persisted lane change delivered through the production lane-events route.

The item-1 PNGs compare an actual native frame in a private virtual display using software rendering with the existing desktop worker components rendered under their All Glass theme. The desktop reference uses the same blocked-task sentence. This establishes the Linux fallback layout, not macOS material or physical compositor performance. The view consumes shared theme tokens; macOS All Glass material, exact type shaping and visual parity still require the platform capture run tracked by #4711.

## Task card

Each task now shows its repository chip, task reference, title, a plain worker status sentence and a status pill. Activity opens the existing `/api/lanes/:id/events` route lazily and renders numbered messages in the server's order. Equal activity responses retain the view. Collapsing and reopening reuse the card and scroll handle; Enter or Space opens activity for a keyboard-selected card. Errors retain prior activity and reopening retries the read.

The item-2 GPUI test opens the real palette, selects the blocked filter, reads three persisted activity steps, and verifies that expanding and collapsing keep the card's origin. The route test verifies the same production event handler. The native screenshot shows the Linux fallback; the adjacent reference uses existing desktop worker components under All Glass. macOS material and exact visual parity remain open under #4711.
