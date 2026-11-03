# Auto machine dispatch prerequisites

Issue: [#5269](https://github.com/o8-run/o8/issues/5269).

Status: blocked before implementation. Automatic machine dispatch is not available.
This records the stop condition for the requested fix; it is not a completed fix.

## Existing boundaries

- [Dispatch routing](../../src/lib/dispatch/routing.ts) recommends a runtime from
  session outcomes. It does not select a saved machine.
- The [saved SSH machine registry](../../src/lib/panel/saved-ssh-machines.ts)
  stores terminal connection settings. Its remote reader invokes the saved CLI's
  terminal inventory command. It has no resources-route reader or per-machine
  HTTP endpoint and authentication binding.
- [Saved-machine CLI operations](../../cli/src/commands/machine.ts) provide remote
  terminal commands over the existing SSH connection. They do not expose a
  resources-route request.
- [GET /api/panel/resource-usage](../../src/app/api/panel/resource-usage/route.ts)
  collects resources on the receiving host.
  [API middleware](../../src/middleware.ts) requires an affirmative principal;
  loopback alone does not authorize this route. The resources read is not in the
  worker or paired-device capability lists.
- [Resource attribution](../../src/lib/lane/resource-attribution.ts) returns CPU
  and memory attributed to displayed process subtrees, plus total physical RAM.
  These values are not host-wide free CPU and memory. Subtracting attributed
  usage would omit other host processes and overstate available capacity.
- [Storage admission](../../src/lib/orchestrator/storage-admission.ts) reports
  `dispatchHeadroomBytes` for disk admission. This is not an existing comparator
  across saved machines.

## Required decision before implementation

Define an authorized, read-only way for the dispatcher to call each saved
machine's resources route. Existing saved terminal connectivity does not define
that API capability. A remote CLI bridge using that host's existing local
configuration is one possible design, but no such resources command exists
today; its authority and behavior must be agreed before adding it.

Do not collect or copy remote operator credentials, change authentication or
capability lists, modify SSH credentials, expose listeners, or add port
forwarding as part of this fix. No live saved machine was contacted during this
investigation.

The route also needs a defined host-wide metrics contract: finite free CPU and
memory values with units and validity rules. Attributed session totals are not a
substitute. The ranking policy and deterministic tie fallback need to be defined
against those metrics and the actual machine-dispatch entry point.

## Deferred acceptance proof

Once the access path and metrics contract are established, implement opt-in
`auto` at the real dispatch entry point, preserving explicit selection. Use a
two-machine fixture and stubbed resource responses to prove that:

- The machine with more free CPU and memory wins despite less disk headroom.
- Equal CPU and memory headroom uses the established deterministic fallback.
- Missing, failed, malformed, or non-finite readings produce a clear error before
  any dispatch; they never silently select a machine.
- Explicit machine selection does not depend on automatic resource polling.

Run the regression tests against unchanged main to record the failing behavior,
then against the implementation to record the pass. These tests have not been
written or run because implementation stopped at the access boundary.
