# Mobile Ask effort pins

An explicit Ask effort is one of `low`, `medium`, `high`, or `xhigh`. Both the
generation route and text-session route reject malformed explicit values before
runtime detection, planner dispatch, worker launch, or session creation. A valid
pin passes unchanged into the selected local worker or planner.

Omitting effort preserves each entry point's default policy. Generation uses
`xhigh`. A text session with an explicit model uses `xhigh`; a text session with
both model and effort omitted retains the desktop's default planner selection.
An explicit effort with automatic model selection still pins that effort.

Generation returns the dispatched effort in `X-O8-Ask-Effort` for both streaming
and JSON responses. A text-session receipt and persisted session retain the
planner's effort. A planner receipt that changes a concrete pin is refused with
409 before session creation, and concrete pins disable automatic default
fallback. A planner surface that cannot honor a concrete effort returns 400.

`normalizeMobileAskEffort` restores saved selections and can replace a stale
saved value with `xhigh`. Live request routing uses strict validation instead.
Changing the selected model preserves every valid saved effort because the Ask
catalog shares the same effort vocabulary across its local models.

`tests/mobile-ask-effort-real-path.test.ts` uses an enrolled fixture phone token,
the actual route handlers, persisted sessions, a planner bridge fixture, and a
temporary worker executable that records its actual arguments and prompt. It
checks explicit low, omission, malformed values, streaming receipts, planner
receipts, and refusal before persistence when a pin cannot be honored.
