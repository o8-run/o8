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

Bound native text turns preserve the selected effort through routing and process
arguments. They start a dedicated session because the unbound warm slot is keyed
only by model. Unbound sessions retain their existing model-tier defaults.
The bounded native harness compiles the production session, phone-turn entry
point, and routing modules, then records arguments from actual fixture workers.

Worker rejection reasons reach both JSON and streaming generation responses.
Result errors and bounded startup diagnostics are retained so an unsupported
effort reports its real reason instead of a generic generation failure.
An unsupported worker effort returns HTTP 400 with `effort_unsupported`, matching
the text-session refusal. Generation waits for the worker's terminal result
before sending success headers, including for streaming requests; successful
streams deliver the completed answer as SSE. A refusal returns a JSON error
without success chunks or a completion marker. Other worker failures retain 502.
