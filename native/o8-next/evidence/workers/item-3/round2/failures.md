# Native failure comparison

Clean main: `af25fc155d7393f6970c09b01a56266d7ffdc7cb`.

| Run | Passed | Failed | Ignored |
| --- | ---: | ---: | ---: |
| Main clean | 320 | 0 | 8 |
| Head clean | 331 | 0 | 8 |
| Head through local CI | 331 | 0 | 8 |

No test fails on either clean tree, so there is no failing native test to name
against a main result. Every one of main's 328 cases and outcomes is retained;
the head has 339 cases, including eleven added passing action cases. Ignored
identities are identical. No test or timeout was weakened. The reported loaded
failures were not reproduced in this clean reference run.

The required CI native run has the same 339 cases and outcomes as the clean
head run. There is no failing native test in that run either.

The two non-native local gate residuals also reproduce on current main:

| Check | Main result | Head result |
| --- | --- | --- |
| Worker route integration | 1/1 assertions pass; process-tree shutdown unconfirmed | 1/1 assertions pass; process-tree shutdown unconfirmed |
| Credential fixture: round-trip and replace through the system store | Same home-directory creation failure (2 pass / 1 fail) | Same case fails; full hermetic suite 9,805 pass / 1 fail / 5 skip |

The focused main credential check used `--experimental.fsModuleCache=false`
after a separate cache-initialization error. No assertion was changed. Full head
CI used the repository configuration unchanged. No app-data write permission
outside the workspace was requested or granted.

