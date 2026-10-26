# Recency paging correction

The native client treated any duplicate across offset pages as evidence that the
server lacked pagination. A message arriving between pages legitimately moves a
chat to the head and shifts an already-read boundary row into the next page.
That rejected the whole sidebar load.

The client now advances the offset by the number of records consumed, merges by
thread ID, and continues past overlapping rows. When overlap occurs, one bounded
head refresh recovers the promoted chat and its latest summary. A complete page
with no new IDs ends discovery while retaining available records, bounding the
fallback for older hosts that repeat their first page.

## Real-path regression

`native/o8-next/src/sidebar_tests.rs` adds:

- `sidebar_message_between_pages_keeps_every_thread`: starts the existing fixture
  host with 2,000 authored chats. Immediately before the second page, the host
  POSTs an incoming message through the production chat-history API. The native
  sidebar discovery must match every desktop-route ID exactly once, retain all
  2,000 chats, and put the updated running chat first with its three persisted
  messages. The saved record is read back through the production API.
- `sidebar_repeated_full_page_retains_available_threads`: uses the same production
  route while the fixture host ignores the offset. The client must finish with
  500 available authored chats, unique IDs, and no pagination compatibility error.

Both tests were written and run against the previous client before the fix.
Their preserved failures are in `red-tail.txt` and `red-repeated-page-tail.txt`.
The first green rerun is in `green-tail.txt`; the final native run also passes
both cases. Before: the sidebar load returned a pagination error. After: the
incoming-message fixture returns all **2,000 unique chats**, and the repeated-page
fixture keeps **500 available chats**.

Reproduce the first red/green path with Node 22 and the README's Rust toolchain:

```sh
cargo +1.97.1 test --locked --manifest-path native/o8-next/Cargo.toml sidebar_message_between_pages_keeps_every_thread -- --nocapture --test-threads=1
```

The fixture switches `--sidebar-paging-message` and `--sidebar-repeat-page` apply
only to the owned `--sidebar` fixture host. No account, provider turn or visible
window is needed for these client regressions.

## Verification

The locked release build passes. The full locked release native run passes
**36 unit tests and 7 CLI tests**, with three existing explicit measurement
workloads ignored. Both new regressions pass in that run.

The seven focused JavaScript files listed in the [original verification](../verification.md)
pass **38 tests**. The 8 GB `npx tsc --noEmit`, `npm run typecheck:fast`, ESLint on
the touched TypeScript fixture host, rule-check and test classification pass.
`gates.json` records their exits, and `verification-tail.txt` preserves the
native and JavaScript summaries.


The full npm gate also passes: **1,230 files and 8,855 tests passed**, with
three files and five tests skipped; zero failures (549.09 seconds). The account
fixture previously recorded in #4633 passes in this run.

The isolated 2,000-thread measurement runs after all other checks finish, using
the [same headless endpoint and sampling method](../verification.md):

| Endpoint | p50 (ms) | p95 (ms) |
| --- | ---: | ---: |
| First painted sidebar row | 406.516 | 554.738 |
| Wheel event through CPU scene paint | 3.693 | 8.118 |

Ten first-paint samples and 500 scroll frames materialize at most **22 rows**.
Raw samples are in `run-1.json`. These GPUI TestAppContext/offscreen measurements
use the test text system and exclude native font shaping, GPU presentation and
compositor cadence. First paint includes HTTP bootstrap and excludes fixture-host
and process startup.
