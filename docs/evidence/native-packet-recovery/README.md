# Native packet recovery evidence

Operator visual acceptance: **not checked by eye**. The operator captures the
reviewed branch in the development window. This worker does not launch a native
window or send operating-system input.

Native tests run in the headless GPUI test context. All four controls failed
against the previous UI (missing controls), then passed with the implementation.
All four passed again after the layout revision. They cover the registered
Activity pane and owned HTTP fixture: exact-body receipt replay, cancellation,
inline refusal, retained feedback after Cancel and Escape, UTF-16 validation,
duplicate submission, action-row geometry and content-width buttons/fields.

Production-route coverage starts the native WS listener with Next stopped and
compares the actual reset/rerun handler responses with the TypeScript handlers.
Route parity and the four reset-current-registry tests passed (5 tests total).
Existing transport operator-auth and worker-refusal assertions for both routes
were read but not rerun locally for this change.

Local release cargo check passed on macOS using the shared cache. Touched-file
ESLint, rule-check, formatting, classification manifest and surface boundary
selection checks passed. Full typecheck, hermetic tests and verify:ci were
attempted but are not green in this checkout without installed dependencies.
No dependency installation or copy was made. Live worker retirement, checkout
deletion and provider redispatch were not exercised.
