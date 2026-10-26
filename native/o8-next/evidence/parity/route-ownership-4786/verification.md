# Parity request ownership (#4786)

This branch starts at current `origin/main`, `fbe95283d`.

The real-browser fixture enters `captureWeb`, opens Settings after hydration and
registers two overlapping API routes. The specific route delegates to the broad
capture route. Four requests include two identical reads, the permitted terminal
view-state save, and a forbidden provider launch. Counters wrap the real route
methods and verify one fulfillment attempt per request, no continuation, no
unauthenticated network bypass and no forwarded provider launch.

The fail-first [red tail](red.txt) reproduces the reported error at
`web.mjs:25`: a disposed response makes the first dispatch claim the request,
then the broad catch attempts a second fulfillment. Attempts are `[2, 1, 1, 1]`.
A delayed read also returns a synthetic 503 when teardown disposes its context
before completion. Both cases fail before the fix; the ordinary overlap case
passes.

Response selection now finishes before a single terminal fulfillment outside
the fetch catch. Only upstream fetch failures produce a 503. Capture tracks its
owned handler promises and drains them before unregistering or closing the
context. This avoids releasing active intercepted requests back to the network.

The [green tail](green.txt) records all 26 harness tests passing. The new cases
cover ordinary overlap, delayed reads during teardown, disposed responses and
unavailable upstream reads. Disposed responses retain their original failure
instead of retrying a consumed request. The existing render-error, blank-frame,
unknown-selection cleanup and 52-gap checks still pass.

One complete local capture ran the real native renderer, GPUI measurement probe,
production-route fixture host and Next browser at both Settings sizes:
1024×720 and 1440×900, with zero crashes. The current-UI Settings page is visible
in both [1024×720](settings-web-1024x720.png) and
[1440×900](settings-web-1440x900.png) screenshots. The
[report](settings-report.json) retains metrics and route statuses; its image
paths refer to the full capture artifact layout. Native X11 frames in this run
show history rather than Settings, so native activation and visual parity remain
unverified under #4711. This change verifies current-UI routing and teardown.

Current main also added the Shortcuts registration without a parity mapping. Its
existing command and current-UI shortcut are now mapped so the dedicated
inventory guard can reach capture. Shortcuts geometry remains unmeasured. No
production data implementation was added.

The [other check tails](checks.txt) record two GPUI parity tests, seven native CLI
assertions, clippy, 27 Linux/boundary regressions, 9,165 JavaScript tests, both
TypeScript checks, classification, lint and rule-check. Main and unrelated-PR
hosted workflow success must be confirmed after this fix is merged; no merge is
performed here.
