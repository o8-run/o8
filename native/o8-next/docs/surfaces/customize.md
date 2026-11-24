# Customize

Native inventories register through `src/surfaces/customize.rs`.
The cached view remains bound to its workspace. See [parity and prior evidence](customize/verification.md).

The surface also owns `Client::customize_request`, following the request
extraction on main at `9f44b02ea`. Shared transport helpers retain the same
routes, operator bearer, response decoding and refusal text.

The prior reopen/view-identity fix was already present and remains covered. None
of the three new review findings was fixed at the previous pushed head.

Saved prompts, with their Edit, Save and Delete controls, were removed with the
prompt library on 2026-11-24. The paragraphs below record the earlier slice.

Hooks retain event/type metadata; connections retain name, transport and host.
Commands, URL credentials, path and query never enter displayed/copied row bodies.
Agent and skill bodies contain the description alone.

[Five GPUI regressions failed before the fixes](customize/registration/red-tail.txt).
An additional [repository reload regression](customize/registration/scope-red-tail.txt)
caught reuse of the cached repository. [Final green](customize/registration/green-tail.txt)
passes all eight surface cases. The [production-route red](customize/registration/api-red-tail.txt)
returned HTTP 200 for stale writes; [route/store green](customize/registration/api-green-tail.txt)
passes ten cases. Auth refusal still uses the production middleware/handler.

Current rebase results, failures and retries: [customize/registration/verification.md](customize/registration/verification.md).

Refs #4548
