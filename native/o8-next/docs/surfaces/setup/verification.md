# Native onboarding slice (#4548)

The opt-in app shell opens project setup when it has no saved workspace sessions.
Setup can also be opened from the shell toolbar. Installed-app defaults and
packaging are unchanged. This is a partial port; the table below is the parity
inventory, not a claim that onboarding acceptance is complete.

| Desktop control | Native counterpart | Status |
| --- | --- | --- |
| Open a registered project | Project buttons | Ported |
| Open folder | Folder path editor using the desktop's path-entry fallback | Ported; native chooser missing |
| Cancel folder choice | Cancel | Ported |
| Check again / retry discovery | Check again | Ported |
| Change / set up tools | Set up tools | Ported |
| Lead selection | Available runtime lead buttons | Ported for listed runtime backends; Fable choice missing |
| Worker pool selection | Available runtime worker buttons; last worker retained | Ported |
| Lead model / worker model selectors | Retains recommendation fields for unchanged runtimes | Missing selectors |
| Use this setup / continue to project | Use this setup | Ported |
| Refresh tools / check sign-in | Check again | Ported discovery refresh |
| Set up later / back to projects | Projects / Close setup | Ported |
| Install tool | None | Missing |
| Configure tool | None | Missing |
| Sign in / copy sign-in command | None | Missing |
| Open / close sign-in terminal | None | Missing |
| Clone from GitHub / toggle GitHub list | None | Missing |
| Connect GitHub / device flow | None | Missing |
| Select and clone repositories | None | Missing |
| Start without a project | Start without a project | Ported |
| Product analytics choice | Product analytics toggle | Ported |
| Crash report choice | Crash reports toggle | Ported |
| Save privacy choices | Save and continue | Ported |
| Expand telemetry sample / privacy details | None | Missing |
| Open workspace with lead conversation | Persisted thread and existing Surface/composer | Ported |
| Agent setup request claim / renew / acknowledgement | None | Missing |
| Resume onboarding progress after restart | None | Missing |
| Enable microphone / accessibility / screen access | None | Missing |
| Test / stop microphone | None | Missing |
| Expand desktop permissions / restart and return | None | Missing |
| Mobile setup / copy beta link / TestFlight | None | Missing |
| Help / report issue / docs / privacy link | None | Missing |
| Onboarding sounds | None | Missing |
| Release notes signup | None | Missing |

All HTTP requests use Client's existing operator bearer and explicit loopback
origin, timeout, redirect refusal and response bounds. No native credential
store, discovery port, account or runtime is introduced. No dependencies changed.

`shell_tests.rs` drives clicks and text input through the app shell, against
`scripts/next/dev-server.ts --onboarding`. Production repository, operator-defaults,
history, middleware and setup-config handlers perform validation and persistence.
The fixture replaces CLI discovery, runtime activity and background scans only.
Temporary paths are compared with canonicalization on both sides. The fixture's
stdout is drained after startup to preserve production mutation logging.

[Red tail](red-tail.txt): 0 new regressions passed, 3 failed at missing native
controls. [Green tail](green-tail.txt): 3 new regressions and 2 existing shell
regressions passed. The new cases cover project/tool/privacy/workspace entry,
folder registration/error/cancel, and missing operator auth/retry. Additional
headless coverage is still needed for projectless completion, both privacy toggle
positions, all tool-pool permutations, save failures and agent recovery.

[Measurement](run-1.json): one debug Linux TestAppContext run, 94.81 ms from
opening the shell to first setup CPU scene and 51.81 ms from the Setup click to
its CPU scene. Timing includes async HTTP. Base has no setup surface, so before
latency is unavailable; no speedup is claimed. The test text system, CPU scene
paint, debug build and one sample do not establish real font shaping, GPU,
compositor latency or a production latency target. macOS execution and display
measurement remain open.


## Current main integration

Reconciled with the native Inbox already on main. The final [green run](green-main-tail.txt)
passes **11 shell and Inbox cases**. The [second timing receipt](run-2.json)
records **108.02 ms open-to-first-frame** and **55.55 ms interaction-to-frame**
on the same debug/headless CPU endpoint. Earlier receipts remain in place.
No GPU/compositor or macOS display claim is added.

The [integration red](red-inbox-tail.txt) caught first-run setup obscuring the
explicitly opened empty Inbox. Explicit navigation now dismisses idle setup and
retains the busy-operation refusal. The existing real-path Inbox case passes.


The [queue red](red-queue-tail.txt) requires the newly opened workspace's first
message to persist through the production queue POST. The fixture now exposes
that existing handler and owns its publication sink and WebSocket ports. It
starts no queue heartbeat or provider. The [final green](green-final-tail.txt)
passes all 11 cases, including that first message. [Final timing](run-3.json):
64.04 ms open-to-first-frame; 28.14 ms interaction-to-frame, on the same limited
debug/headless CPU endpoint.

Refs #4548
