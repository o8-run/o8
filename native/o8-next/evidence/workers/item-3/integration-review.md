# Worker action review on current main

The three new real-input tests fail against `fc7fcdcfa` before the action fixes:
**0 passed, 3 failed**. The same tests pass after the fixes, with all original
worker tests retained: **19 passed, 0 failed**. See the
[red](integration-review-red.txt) and [green](integration-review-green.txt) tails.

Keep waiting retains the fetched lane object when its ID matches the card's
current lane, increments the changed card's revision, and preserves the queue.
It still performs a read, without resuming or redispatching the worker.

Sending freezes the operator's exact text. Whitespace-only validation still
rejects an empty adjustment, and the server keeps its existing message validation.
A confirmed response clears only an exact match to the frozen text, so a space
added after submission remains visible and persisted. Retry still reuses the
same body and idempotency key.

The workspace regression opens two real workspace fixtures with the same packet
ID and one shared draft file. It keeps B's pending request separate from A's draft and lane read, checks both
persisted entries, and verifies that B's acknowledgement does not clear
A's draft or change its lane data. Window events submit and edit before the test
executor drains delivery work; no timeout or sleep budget was increased.

Merged main at `6faa84124`. No shell hook was added; the existing worker surface
registration runs through the shell feature modules. The obsolete extra ignore
was `ui::tests::worker_tests::worker_send_steer_queue_promote_remove_and_streaming_latency`.
Main's queue fix removes that quarantine, and this branch retains that removal.
The Experimental gate is unchanged.

Main's locked all-target check and full native inventory pass: **316 passed,
0 failed, 8 ignored**. Fast type checking, touched-file lint and the rule check
also pass.

## Complete native comparison

| Tree | Passed | Failed | Ignored |
| --- | ---: | ---: | ---: |
| Main at `6faa84124` | 316 | 0 | 8 |
| Worker action head | 326 | 0 | 8 |

All four regular shards and isolated timed probes ran on both trees. Every main
outcome and ignored identity is retained. The ten added worker cases pass,
including the three new review regressions. There are no head-only native
failures. The previously quarantined streaming test ran and passed.

Both locked all-target checks pass. Local `npm run verify:ci` passes seven of
nine checks. The hermetic suite has **9,752 passed, 1 failed, 5 skipped**; the
unchanged credential-store fixture cannot create its directory outside writable
workspace paths. The route assertions pass **1/1**, but fixture process-tree
shutdown cannot be confirmed. The same route gate on current main reproduces
that shutdown failure after passing **1/1** assertions. No gate was disabled.
